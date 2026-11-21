import Enrollment, { ENROLLMENT_STATUSES } from "../models/enrollment.js";
import Student from "../models/student.js";
import Program from "../models/program.js";
import ProgramSession from "../models/programSession.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { audit } from "../utils/audit.js";

// P05-04/05: a college student in one of the college's batches. Every id is checked against req.institution.
const EDITABLE = ["enrollmentCode", "officialEnrollmentNo", "status"];
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const IMPORT_LIMIT = 500;

const pick = (source, keys) =>
  Object.fromEntries(keys.filter((key) => source?.[key] !== undefined).map((key) => [key, source[key]]));
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const objectId = (value, message) => {
  if (!OBJECT_ID.test(String(value ?? ""))) throw new AppError(message, 400);
  return String(value);
};

// Two unique rules: the same student twice in a batch, or an enrollment code used twice in the college.
const duplicateMessage = (error) =>
  error.keyPattern?.enrollmentCode || /enrollmentCode/.test(error.message || error.errmsg || "")
    ? "Another enrollment in this college has that enrollment code"
    : "This student is already enrolled in that batch";

const saveUnique = async (operation) => {
  try {
    return await operation;
  } catch (error) {
    if (error.code === 11000) throw new AppError(duplicateMessage(error), 409);
    throw error;
  }
};

const POPULATE = [
  { path: "studentId", select: "fullName registrationNo studentStatus walletHint" },
  { path: "programSessionId", select: "startYear endYear status name code color" },
  { path: "programId", select: "code name color" },
];

const logDetails = (enrollment) => ({
  studentId: String(enrollment.studentId?._id || enrollment.studentId),
  programSessionId: String(enrollment.programSessionId?._id || enrollment.programSessionId),
  enrollmentCode: enrollment.enrollmentCode,
  status: enrollment.status,
});

export const listEnrollments = asyncHandler(async (req, res) => {
  const institutionId = req.institution._id;
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  const filter = { institutionId };

  if (req.query.programId) filter.programId = objectId(req.query.programId, "Invalid programId");
  if (req.query.programSessionId) filter.programSessionId = objectId(req.query.programSessionId, "Invalid programSessionId");
  if (ENROLLMENT_STATUSES.includes(req.query.status)) filter.status = req.query.status;
  // The Students page asks for the enrollments of the students it shows (?studentIds=a,b,c).
  if (req.query.studentIds) {
    const ids = String(req.query.studentIds).split(",").filter(Boolean);
    if (ids.length > 100) throw new AppError("Ask for at most 100 students at a time", 400);
    filter.studentId = { $in: ids.map((id) => objectId(id, "Invalid studentIds")) };
  }
  if (req.query.search) {
    const regex = new RegExp(escapeRegex(String(req.query.search).trim()), "i");
    // shortcut: matches at most 1000 students by name / reg. no.; use a joined search if colleges outgrow it.
    const students = await Student.find({ institutionId, $or: [{ fullName: regex }, { registrationNo: regex }] })
      .select("_id")
      .limit(1000)
      .lean();
    filter.$or = [{ studentId: { $in: students.map((student) => student._id) } }, { enrollmentCode: regex }, { officialEnrollmentNo: regex }];
  }

  const [enrollments, total, counts] = await Promise.all([
    Enrollment.find(filter).populate(POPULATE).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Enrollment.countDocuments(filter),
    Enrollment.aggregate([{ $match: { institutionId } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
  ]);
  const byStatus = Object.fromEntries(counts.map((row) => [row._id, row.count]));

  res.status(200).json({
    success: true,
    enrollments,
    stats: {
      total: counts.reduce((sum, row) => sum + row.count, 0),
      enrolled: byStatus.ENROLLED || 0,
      completed: byStatus.COMPLETED || 0,
      cancelled: byStatus.CANCELLED || 0,
    },
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  });
});

export const createEnrollment = asyncHandler(async (req, res) => {
  const institutionId = req.institution._id;
  const [student, batch] = await Promise.all([
    Student.findOne({ _id: objectId(req.body?.studentId, "Choose a student"), institutionId }),
    ProgramSession.findOne({ _id: objectId(req.body?.programSessionId, "Choose a batch"), institutionId }),
  ]);
  if (!student) throw new AppError("Student not found", 404);
  if (!batch) throw new AppError("Batch not found", 404);

  const enrollment = await saveUnique(
    Enrollment.create({
      ...pick(req.body, EDITABLE),
      institutionId,
      studentId: student._id,
      programSessionId: batch._id,
      programId: batch.programId,
    })
  );
  await enrollment.populate(POPULATE);

  await audit(req, {
    action: "institution.enrollment.create",
    scope: "INSTITUTION",
    targetType: "Enrollment",
    targetId: enrollment._id,
    summary: `Enrolled ${student.fullName} in ${enrollment.programId.code} ${batch.startYear}-${batch.endYear}`,
    details: logDetails(enrollment),
  });
  res.status(201).json({ success: true, enrollment });
});

export const updateEnrollment = asyncHandler(async (req, res) => {
  if (["studentId", "programSessionId", "programId"].some((key) => req.body?.[key] !== undefined)) {
    throw new AppError("An enrollment cannot move to another student or batch; cancel it and enroll again", 400);
  }
  const enrollment = await Enrollment.findOne({ _id: req.params.enrollmentId, institutionId: req.institution._id });
  if (!enrollment) throw new AppError("Enrollment not found", 404);

  const before = logDetails(enrollment);
  enrollment.set(pick(req.body, EDITABLE));
  await saveUnique(enrollment.save());
  await enrollment.populate(POPULATE);

  await audit(req, {
    action: "institution.enrollment.update",
    scope: "INSTITUTION",
    targetType: "Enrollment",
    targetId: enrollment._id,
    summary: `Updated enrollment of ${enrollment.studentId?.fullName}`,
    details: { before, after: logDetails(enrollment) },
  });
  res.status(200).json({ success: true, enrollment });
});

/**
 * Excel import. Each row names the student by registration no. and the batch by program code + start year
 * (+ end year when several batches of that program start the same year). Good rows are saved; the rest come
 * back with their sheet row number and a plain reason.
 */
export const importEnrollments = asyncHandler(async (req, res) => {
  const rows = req.body?.enrollments;
  if (!Array.isArray(rows) || rows.length === 0) throw new AppError("No enrollments to import", 400);
  if (rows.length > IMPORT_LIMIT) throw new AppError(`Send at most ${IMPORT_LIMIT} enrollments per request`, 400);

  const institutionId = req.institution._id;
  const text = (value) => String(value ?? "").trim();
  const upper = (value) => text(value).toUpperCase();

  // Look everything up once for the whole chunk.
  const [students, programs] = await Promise.all([
    Student.find({ institutionId, registrationNo: { $in: [...new Set(rows.map((row) => upper(row?.registrationNo)).filter(Boolean))] } })
      .select("registrationNo fullName")
      .lean(),
    Program.find({ institutionId, code: { $in: [...new Set(rows.map((row) => upper(row?.programCode)).filter(Boolean))] } })
      .select("code")
      .lean(),
  ]);
  const batches = await ProgramSession.find({ institutionId, programId: { $in: programs.map((program) => program._id) } })
    .select("programId startYear endYear")
    .lean();
  const studentByNo = new Map(students.map((student) => [student.registrationNo, student]));
  const programByCode = new Map(programs.map((program) => [program.code, program]));

  const failed = [];
  const valid = [];
  const seen = new Map(); // studentId:batchId -> first row

  for (const [index, row] of rows.entries()) {
    const rowNo = Number.isInteger(row?.row) ? row.row : index + 2;
    const fail = (message) => failed.push({ row: rowNo, message });
    const registrationNo = upper(row?.registrationNo);
    const programCode = upper(row?.programCode);
    const startYear = Number(text(row?.startYear));
    const endYear = text(row?.endYear) ? Number(text(row.endYear)) : null;

    if (!registrationNo) { fail("Registration no. is required"); continue; }
    if (!programCode) { fail("Program code is required"); continue; }
    if (!Number.isInteger(startYear)) { fail("Batch start year is required (e.g. 2022)"); continue; }
    const student = studentByNo.get(registrationNo);
    if (!student) { fail(`No student with registration no. ${registrationNo} (add the student first)`); continue; }
    const program = programByCode.get(programCode);
    if (!program) { fail(`No program with code ${programCode}`); continue; }

    const matches = batches.filter(
      (batch) => batch.programId.equals(program._id) && batch.startYear === startYear && (endYear === null || batch.endYear === endYear)
    );
    if (matches.length === 0) { fail(`${programCode} has no batch starting in ${startYear}${endYear ? `-${endYear}` : ""}`); continue; }
    if (matches.length > 1) { fail(`${programCode} has several batches starting in ${startYear}; add the end year`); continue; }
    const batch = matches[0];

    const key = `${student._id}:${batch._id}`;
    if (seen.has(key)) { fail(`Same student and batch as row ${seen.get(key)}`); continue; }
    seen.set(key, rowNo);

    const enrollment = new Enrollment({
      ...pick(row, EDITABLE),
      status: upper(row?.status) || "ENROLLED",
      institutionId,
      studentId: student._id,
      programSessionId: batch._id,
      programId: program._id,
    });
    try {
      await enrollment.validate();
    } catch (error) {
      fail(Object.values(error.errors || {}).map((item) => item.message).join(", ") || error.message);
      continue;
    }
    valid.push({ rowNo, enrollment });
  }

  let created = valid.length;
  if (valid.length) {
    try {
      await Enrollment.insertMany(valid.map(({ enrollment }) => enrollment), { ordered: false });
    } catch (error) {
      // Already enrolled, or a code used elsewhere: report those rows, keep the rest.
      if (!error.writeErrors) throw error;
      created -= error.writeErrors.length;
      for (const writeError of error.writeErrors) {
        // This driver keeps code / errmsg / keyPattern on writeError.err.
        const raw = writeError.err || writeError;
        failed.push({
          row: valid[writeError.index].rowNo,
          message: raw.code === 11000 ? duplicateMessage({ keyPattern: raw.keyPattern, errmsg: raw.errmsg }) : raw.errmsg || "Could not save this row",
        });
      }
    }
  }

  failed.sort((a, b) => a.row - b.row);
  await audit(req, {
    action: "institution.enrollment.import",
    scope: "INSTITUTION",
    targetType: "Enrollment",
    summary: `Imported ${created} enrollment${created === 1 ? "" : "s"}${failed.length ? `, ${failed.length} row(s) skipped` : ""}`,
    details: { created, skipped: failed.length },
  });
  res.status(200).json({ success: true, created, failed });
});
