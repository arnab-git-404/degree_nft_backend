import Student, { STUDENT_STATUSES } from "../models/student.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { audit } from "../utils/audit.js";

// P05-03: college student profiles. The college is always req.institution, never taken from the body.
const EDITABLE = ["fullName", "registrationNo", "email", "phone", "studentStatus"];
const DUPLICATE = "Another student in this college has that registration number";

const pick = (source, keys) =>
  Object.fromEntries(keys.filter((key) => source?.[key] !== undefined).map((key) => [key, source[key]]));

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const saveUnique = async (operation) => {
  try {
    return await operation;
  } catch (error) {
    if (error.code === 11000) throw new AppError(DUPLICATE, 409);
    throw error;
  }
};

// Name and registration number only: email and phone stay out of the activity log.
const logDetails = (student) => ({ fullName: student.fullName, registrationNo: student.registrationNo, studentStatus: student.studentStatus });

// Paginated: a college can have thousands of students. Stats always cover the whole college.
export const listStudents = asyncHandler(async (req, res) => {
  const institutionId = req.institution._id;
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  const filter = { institutionId };

  if (STUDENT_STATUSES.includes(req.query.status)) filter.studentStatus = req.query.status;
  if (req.query.search) {
    const regex = new RegExp(escapeRegex(String(req.query.search).trim()), "i");
    filter.$or = [{ fullName: regex }, { registrationNo: regex }, { email: regex }, { phone: regex }];
  }

  const [students, total, all, active] = await Promise.all([
    // _id breaks ties (bulk-added students share a timestamp), so pages never repeat or skip a row.
    Student.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Student.countDocuments(filter),
    Student.countDocuments({ institutionId }),
    Student.countDocuments({ institutionId, studentStatus: "ACTIVE" }),
  ]);

  res.status(200).json({
    success: true,
    students,
    stats: { total: all, active, inactive: all - active },
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  });
});

export const createStudent = asyncHandler(async (req, res) => {
  const student = await saveUnique(Student.create({ ...pick(req.body, EDITABLE), institutionId: req.institution._id }));

  await audit(req, {
    action: "institution.student.create",
    scope: "INSTITUTION",
    targetType: "Student",
    targetId: student._id,
    summary: `Added student ${student.fullName}`,
    details: logDetails(student),
  });
  res.status(201).json({ success: true, student });
});

// Bulk add from the Excel template. Each row is checked like a single add; good rows are saved, the rest
// come back with their sheet row number and reason. The page sends large files in chunks of 200.
const IMPORT_LIMIT = 500;

export const importStudents = asyncHandler(async (req, res) => {
  const rows = req.body?.students;
  if (!Array.isArray(rows) || rows.length === 0) throw new AppError("No students to import", 400);
  if (rows.length > IMPORT_LIMIT) throw new AppError(`Send at most ${IMPORT_LIMIT} students per request`, 400);

  const institutionId = req.institution._id;
  const failed = [];
  const valid = [];
  const fileNumbers = new Map(); // registration no. -> first row that used it

  for (const [index, row] of rows.entries()) {
    const rowNo = Number.isInteger(row?.row) ? row.row : index + 2;
    const student = new Student({ ...pick(row, EDITABLE), institutionId });
    try {
      await student.validate();
    } catch (error) {
      failed.push({ row: rowNo, message: Object.values(error.errors || {}).map((item) => item.message).join(", ") || error.message });
      continue;
    }
    if (student.registrationNo) {
      if (fileNumbers.has(student.registrationNo)) {
        failed.push({ row: rowNo, message: `Registration no. ${student.registrationNo} is also on row ${fileNumbers.get(student.registrationNo)}` });
        continue;
      }
      fileNumbers.set(student.registrationNo, rowNo);
    }
    valid.push({ rowNo, student });
  }

  // Numbers already used in this college.
  const taken = new Set(
    (await Student.find({ institutionId, registrationNo: { $in: [...fileNumbers.keys()] } }).select("registrationNo").lean()).map(
      (student) => student.registrationNo
    )
  );
  const toInsert = valid.filter(({ rowNo, student }) => {
    if (!taken.has(student.registrationNo)) return true;
    failed.push({ row: rowNo, message: DUPLICATE });
    return false;
  });

  let created = toInsert.length;
  if (toInsert.length) {
    try {
      await Student.insertMany(toInsert.map(({ student }) => student), { ordered: false });
    } catch (error) {
      // A number taken by someone else in the meantime: report those rows, keep the rest.
      if (!error.writeErrors) throw error;
      created -= error.writeErrors.length;
      for (const writeError of error.writeErrors) {
        // This driver keeps code / errmsg on writeError.err.
        const raw = writeError.err || writeError;
        failed.push({ row: toInsert[writeError.index].rowNo, message: raw.code === 11000 ? DUPLICATE : raw.errmsg || "Could not save this row" });
      }
    }
  }

  failed.sort((a, b) => a.row - b.row);
  await audit(req, {
    action: "institution.student.import",
    scope: "INSTITUTION",
    targetType: "Student",
    summary: `Imported ${created} student${created === 1 ? "" : "s"}${failed.length ? `, ${failed.length} row(s) skipped` : ""}`,
    details: { created, skipped: failed.length },
  });
  res.status(200).json({ success: true, created, failed });
});

export const updateStudent = asyncHandler(async (req, res) => {
  const student = await Student.findOne({ _id: req.params.studentId, institutionId: req.institution._id });
  if (!student) throw new AppError("Student not found", 404);

  const before = logDetails(student);
  student.set(pick(req.body, EDITABLE));
  await saveUnique(student.save());

  await audit(req, {
    action: "institution.student.update",
    scope: "INSTITUTION",
    targetType: "Student",
    targetId: student._id,
    summary: `Updated student ${student.fullName}`,
    details: { before, after: logDetails(student) },
  });
  res.status(200).json({ success: true, student });
});
