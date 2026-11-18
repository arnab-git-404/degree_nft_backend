import Program from "../models/program.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { audit } from "../utils/audit.js";

// P05-01: the college is always req.institution (requireInstitution), never taken from the body.
const EDITABLE = ["name", "degreeLevel", "durationValue", "durationUnit", "status"];

const pick = (source, keys) =>
  Object.fromEntries(keys.filter((key) => source?.[key] !== undefined).map((key) => [key, source[key]]));

export const listPrograms = asyncHandler(async (req, res) => {
  const programs = await Program.find({ institutionId: req.institution._id }).sort({ code: 1 }).lean();
  res.status(200).json({ success: true, programs });
});

export const createProgram = asyncHandler(async (req, res) => {
  let program;
  try {
    program = await Program.create({ ...pick(req.body, ["code", ...EDITABLE]), institutionId: req.institution._id });
  } catch (error) {
    if (error.code === 11000) throw new AppError("This college already has a program with that code", 409);
    throw error;
  }

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
