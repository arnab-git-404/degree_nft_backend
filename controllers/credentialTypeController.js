import CredentialType, { ensureCredentialTypes } from "../models/credentialType.js";
import { colorFromSeed, hashString } from "../utils/color.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { audit } from "../utils/audit.js";

// The college is always req.institution (requireInstitution), never taken from the body.
const EDITABLE = ["name", "description", "color", "status"];

const pick = (source, keys) =>
  Object.fromEntries(keys.filter((key) => source?.[key] !== undefined).map((key) => [key, source[key]]));

export const listCredentialTypes = asyncHandler(async (req, res) => {
  await ensureCredentialTypes(req.institution._id);
  const credentialTypes = await CredentialType.find({ institutionId: req.institution._id }).sort({ name: 1 }).lean();
  res.status(200).json({
    success: true,
    credentialTypes: credentialTypes.map((type) => ({ ...type, color: type.color ?? colorFromSeed(hashString(type.code)) })),
  });
});

export const createCredentialType = asyncHandler(async (req, res) => {
  let credentialType;
  try {
    credentialType = await CredentialType.create({ ...pick(req.body, ["code", ...EDITABLE]), institutionId: req.institution._id });
  } catch (error) {
    if (error.code === 11000) throw new AppError("This college already has a credential type with that code", 409);
    throw error;
  }
  await audit(req, {
    action: "institution.credentialType.create",
    scope: "INSTITUTION",
    targetType: "CredentialType",
    targetId: credentialType._id,
    summary: `Created credential type ${credentialType.code}`,
  });
  res.status(201).json({ success: true, credentialType });
});

export const updateCredentialType = asyncHandler(async (req, res) => {
  if (req.body?.code !== undefined) throw new AppError("A credential type code cannot be changed", 400);

  const credentialType = await CredentialType.findOne({ _id: req.params.credentialTypeId, institutionId: req.institution._id });
  if (!credentialType) throw new AppError("Credential type not found", 404);

  const before = pick(credentialType.toObject(), EDITABLE);
  credentialType.set(pick(req.body, EDITABLE));
  await credentialType.save();

  await audit(req, {
    action: "institution.credentialType.update",
    scope: "INSTITUTION",
    targetType: "CredentialType",
    targetId: credentialType._id,
    summary: `Updated credential type ${credentialType.code}`,
    details: { before, after: pick(credentialType.toObject(), EDITABLE) },
  });
  res.status(200).json({ success: true, credentialType });
});
