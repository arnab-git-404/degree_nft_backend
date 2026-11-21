import Program from "../models/program.js";
import ProgramSession from "../models/programSession.js";
import AcademicSession, { yearColor } from "../models/academicSession.js";
import Enrollment from "../models/enrollment.js";
import { colorFromSeed, hashString } from "../utils/color.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { audit } from "../utils/audit.js";

// P05-01: the college is always req.institution (requireInstitution), never taken from the body.
const EDITABLE = ["name", "description", "color", "status"];

const pick = (source, keys) =>
  Object.fromEntries(keys.filter((key) => source?.[key] !== undefined).map((key) => [key, source[key]]));

// Turns a unique-index clash into a readable 409.
const saveUnique = async (operation, message) => {
  try {
    return await operation;
  } catch (error) {
    if (error.code === 11000) throw new AppError(message, 409);
    throw error;
  }
};

// Strict 24-hex: rejects missing values and query objects like { $ne: null }.
const objectId = (value, message) => {
  if (!/^[a-f0-9]{24}$/i.test(String(value ?? ""))) throw new AppError(message, 400);
  return String(value);
};

export const listPrograms = asyncHandler(async (req, res) => {
  const programs = await Program.find({ institutionId: req.institution._id }).sort({ code: 1 }).lean();
  // lean() skips schema defaults and the pre-validate hook, so programs saved before colours existed get theirs here.
  res.status(200).json({
    success: true,
    programs: programs.map((program) => ({ ...program, color: program.color ?? colorFromSeed(hashString(program.code)) })),
  });
});

export const createProgram = asyncHandler(async (req, res) => {
  const program = await saveUnique(
    Program.create({ ...pick(req.body, ["code", ...EDITABLE]), institutionId: req.institution._id }),
    "This college already has a program with that code"
  );

  await audit(req, {
    action: "institution.program.create",
    scope: "INSTITUTION",
    targetType: "Program",
    targetId: program._id,
    summary: `Created program ${program.code}`,
    details: { code: program.code, name: program.name },
  });
  res.status(201).json({ success: true, program });
});

export const updateProgram = asyncHandler(async (req, res) => {
  if (req.body?.code !== undefined) throw new AppError("A program code cannot be changed", 400);

  const program = await Program.findOne({ _id: req.params.programId, institutionId: req.institution._id });
  if (!program) throw new AppError("Program not found", 404);

  const before = pick(program.toObject(), EDITABLE);
  program.set(pick(req.body, EDITABLE));
  await program.save();

  await audit(req, {
    action: "institution.program.update",
    scope: "INSTITUTION",
    targetType: "Program",
    targetId: program._id,
    summary: `Updated program ${program.code}`,
    details: { before, after: pick(program.toObject(), EDITABLE) },
  });
  res.status(200).json({ success: true, program });
});

// P05-02: program sessions (cohorts). The program must belong to the selected college.
const SESSION_EDITABLE = ["startYear", "endYear", "status", "name", "color"];
const SESSION_DUPLICATE = "This program already has a batch for that intake or those years";

export const listProgramSessions = asyncHandler(async (req, res) => {
  const filter = { institutionId: req.institution._id };
  if (req.query.programId) filter.programId = objectId(req.query.programId, "Invalid programId");

  const sessions = await ProgramSession.find(filter)
    .populate("programId", "code name status color")
    .sort({ startYear: -1, endYear: -1 })
    .lean();
  // Batches saved before names/codes/colours existed get theirs computed here (lean() skips the model hooks).
  res.status(200).json({
    success: true,
    sessions: sessions.map((session) => {
      const code = session.code ?? `${session.programId?.code}-${session.startYear}`;
      return {
        ...session,
        code,
        name: session.name ?? `${session.programId?.code} ${session.startYear}–${session.endYear}`,
        color: session.color ?? colorFromSeed(hashString(code)),
        // Batches saved with the old statuses: Open counts as Active, Planned and Closed as Inactive.
        status: session.status === "ACTIVE" || session.status === "OPEN" ? "ACTIVE" : "INACTIVE",
      };
    }),
  });
});

export const createProgramSession = asyncHandler(async (req, res) => {
  const programId = objectId(req.body?.programId, "Choose a program");
  const program = await Program.findOne({ _id: programId, institutionId: req.institution._id });
  if (!program) throw new AppError("Program not found", 404);

  // An intake of an academic session takes its start year from that session.
  let { startYear } = req.body || {};
  let academicSessionId;
  if (req.body?.academicSessionId !== undefined) {
    const intake = await AcademicSession.findOne({
      _id: objectId(req.body.academicSessionId, "Invalid academicSessionId"),
      institutionId: req.institution._id,
    });
    if (!intake) throw new AppError("Academic session not found", 404);
    if (!intake.isActive) throw new AppError("That academic year is inactive; activate it in Settings first", 409);
    ({ _id: academicSessionId, startYear } = intake);
  }

  // Defaults when the form leaves them blank: code CSE-2026, name "CSE 2026–2030".
  const endYear = req.body?.endYear;
  const code = (typeof req.body?.code === "string" && req.body.code.trim()) || `${program.code}-${startYear}`;
  const name = (typeof req.body?.name === "string" && req.body.name.trim()) || `${program.code} ${startYear}–${endYear}`;

  const session = await saveUnique(
    ProgramSession.create({
      ...pick(req.body, SESSION_EDITABLE),
      name,
      code,
      startYear,
      academicSessionId,
      programId,
      institutionId: req.institution._id,
    }),
    SESSION_DUPLICATE
  );

  await audit(req, {
    action: "institution.programSession.create",
    scope: "INSTITUTION",
    targetType: "ProgramSession",
    targetId: session._id,
    summary: `Created session ${program.code} ${session.startYear}-${session.endYear}`,
    details: { programId, ...pick(session.toObject(), SESSION_EDITABLE) },
  });
  res.status(201).json({ success: true, session });
});

export const updateProgramSession = asyncHandler(async (req, res) => {
  if (req.body?.programId !== undefined) throw new AppError("A session cannot move to another program", 400);
  if (req.body?.code !== undefined) throw new AppError("A batch code cannot be changed", 400);

  const session = await ProgramSession.findOne({ _id: req.params.sessionId, institutionId: req.institution._id });
  if (!session) throw new AppError("Session not found", 404);
  if (session.academicSessionId && req.body?.startYear !== undefined && Number(req.body.startYear) !== session.startYear) {
    throw new AppError("The start year comes from the academic session", 400);
  }

  const before = pick(session.toObject(), SESSION_EDITABLE);
  session.set(pick(req.body, SESSION_EDITABLE));
  // Enrolled students (and later their credentials) name these years: once anyone is enrolled they stay.
  if ((session.isModified("startYear") || session.isModified("endYear")) && (await Enrollment.exists({ programSessionId: session._id }))) {
    throw new AppError("Students are enrolled in this batch, so its years can no longer change", 409);
  }
  await saveUnique(session.save(), SESSION_DUPLICATE);

  await audit(req, {
    action: "institution.programSession.update",
    scope: "INSTITUTION",
    targetType: "ProgramSession",
    targetId: session._id,
    summary: `Updated session ${session.startYear}-${session.endYear}`,
    details: { programId: String(session.programId), before, after: pick(session.toObject(), SESSION_EDITABLE) },
  });
  res.status(200).json({ success: true, session });
});

// Administration › Academic Sessions: the college's academic years (2024-25), used as program intakes.
export const listAcademicSessions = asyncHandler(async (req, res) => {
  const institutionId = req.institution._id;
  const [sessions, counts] = await Promise.all([
    AcademicSession.find({ institutionId }).sort({ startYear: -1 }).lean(),
    ProgramSession.aggregate([
      { $match: { institutionId, academicSessionId: { $exists: true } } },
      { $group: { _id: "$academicSessionId", count: { $sum: 1 } } },
    ]),
  ]);
  const batchCounts = new Map(counts.map((row) => [String(row._id), row.count]));
  res.status(200).json({
    success: true,
    // lean() skips schema defaults, so years saved before isActive existed count as active.
    academicSessions: sessions.map((session) => ({
      ...session,
      isActive: session.isActive ?? true,
      color: session.color ?? yearColor(session.startYear), // years saved before colours existed
      batchCount: batchCounts.get(String(session._id)) || 0,
    })),
  });
});

export const createAcademicSession = asyncHandler(async (req, res) => {
  const session = await saveUnique(
    AcademicSession.create({ ...pick(req.body, ["startYear", "endYear", "isActive", "color"]), institutionId: req.institution._id }),
    "This college already has a session starting in that year"
  );

  await audit(req, {
    action: "institution.academicSession.create",
    scope: "INSTITUTION",
    targetType: "AcademicSession",
    targetId: session._id,
    summary: `Created academic session ${session.startYear}-${session.endYear}`,
  });
  res.status(201).json({ success: true, academicSession: session });
});

// Settings › Academic years: the Active/Inactive and Set Current toggles.
export const updateAcademicSession = asyncHandler(async (req, res) => {
  const session = await AcademicSession.findOne({ _id: req.params.academicSessionId, institutionId: req.institution._id });
  if (!session) throw new AppError("Academic session not found", 404);

  const { isActive = session.isActive, isCurrent = session.isCurrent } = req.body || {};
  if (typeof isActive !== "boolean" || typeof isCurrent !== "boolean") throw new AppError("isActive and isCurrent must be true or false", 400);
  // Also blocks deactivating the current year: set another year as current first.
  if (isCurrent && !isActive) throw new AppError("An inactive year cannot be the current year; set another year as current first", 409);

  // Clear the old current first: the unique index allows only one per college.
  if (isCurrent && !session.isCurrent) {
    await AcademicSession.updateMany({ institutionId: req.institution._id, isCurrent: true }, { isCurrent: false });
  }
  session.set({ isActive, isCurrent });
  await session.save();

  await audit(req, {
    action: "institution.academicSession.update",
    scope: "INSTITUTION",
    targetType: "AcademicSession",
    targetId: session._id,
    summary: `Updated academic session ${session.startYear}-${session.endYear}`,
    details: { isActive, isCurrent },
  });
  res.status(200).json({ success: true, academicSession: session });
});
