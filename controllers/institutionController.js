import asyncHandler from "../utils/asyncHandler.js";

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
