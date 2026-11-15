import asyncHandler from "../utils/asyncHandler.js";
import * as staffService from "../services/staffService.js";

// Colleges are created only by Super Admin approval of an application (registrationController.approveApplication).

export const getProfile = asyncHandler(async (req, res) => {
  res.status(200).json({
    success: true,
    institution: req.institution,
  });
});

export const batchUpload = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No file uploaded." });
  }

  res
    .status(200)
    .json({ message: "This function is in the early stage of development..." });
};

export const getAllReports = async (req, res) => {
  res
    .status(200)
    .json({ message: "This function is in the early stage of development..." });
};

export const getAllUploadedData = async (req, res) => {
  res
    .status(200)
    .json({ message: "This function is in the early stage of development..." });
};

export const updateNftAllocations = async (req, res) => {
  res
    .status(200)
    .json({ message: "This function is in the early stage of development..." });
};

// P04 staff management: always the college from requireInstitution (req.institution), never from the body.
export const getStaff = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, ...(await staffService.listMembers(req.institution, { asSuperAdmin: false })) });
});

export const inviteStaff = asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, ...(await staffService.inviteMember(req, req.institution, req.body, { asSuperAdmin: false })) });
});

export const updateStaff = asyncHandler(async (req, res) => {
  const membership = await staffService.updateMember(req, req.institution, req.params.membershipId, req.body, { asSuperAdmin: false });
  res.status(200).json({ success: true, membership });
});

export const getInvitations = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, invitations: await staffService.listInvitations(req.user) });
});

export const acceptInvitation = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, membership: await staffService.respondToInvitation(req, req.params.membershipId, true) });
});

export const declineInvitation = asyncHandler(async (req, res) => {
  await staffService.respondToInvitation(req, req.params.membershipId, false);
  res.status(200).json({ success: true });
});
