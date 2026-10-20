import User from "../models/user.js";
import Role from "../models/role.js";
import University from "../models/university.js";
import NFT from "../models/nft.js";
import Reports from "../models/reports.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getPagination = (query) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(query.limit, 10) || 20)
  );

  return { page, limit, skip: (page - 1) * limit };
};

const paginationMeta = (page, limit, total) => ({
  page,
  limit,
  total,
  pages: Math.ceil(total / limit) || 1,
});

export const getDashboardStats = asyncHandler(async (req, res) => {
  const [
    totalUsers,
    activeUsers,
    totalUniversities,
    pendingUniversities,
    verifiedUniversities,
    totalAllocations,
    totalMinted,
    totalReports,
    openReports,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ isActive: true }),
    University.countDocuments(),
    University.countDocuments({ verificationStatus: "PENDING" }),
    University.countDocuments({ verificationStatus: "VERIFIED" }),
    NFT.countDocuments({ allocated: true }),
    NFT.countDocuments({ minted: true }),
    Reports.countDocuments(),
    Reports.countDocuments({ resolved: false }),
  ]);

  res.status(200).json({
    success: true,
    stats: {
      totalUsers,
      activeUsers,
      totalUniversities,
      pendingUniversities,
      verifiedUniversities,
      totalAllocations,
      totalMinted,
      totalReports,
      openReports,
    },
  });
});

export const getRoles = asyncHandler(async (req, res) => {
  const roles = await Role.find({ isActive: true })
    .select("name displayName description permissions")
    .sort({ name: 1 });

  res.status(200).json({ success: true, roles });
});

export const getUsers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const { search, role } = req.query;
  const filter = {};

  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ name: regex }, { email: regex }];
  }

  if (role) {
    const roleDocument = await Role.findOne({ name: role });

    if (!roleDocument) {
      throw new AppError("Role not found", 404);
    }

    filter.roleId = roleDocument._id;
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .populate("roleId")
      .populate("primaryWallet")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    users: users.map((user) => user.toJSON()),
    pagination: paginationMeta(page, limit, total),
  });
});

export const updateUserRole = asyncHandler(async (req, res) => {
  const { role } = req.body;

  if (!role) {
    throw new AppError("role is required", 400);
  }

  const roleDocument = await Role.findOne({ name: role, isActive: true });

  if (!roleDocument) {
    throw new AppError("Role not found", 404);
  }

  const user = await User.findById(req.params.userId);

  if (!user) {
    throw new AppError("User not found", 404);
  }

  const isSelf = user._id.equals(req.user._id);

  if (isSelf && role !== "admin") {
    throw new AppError("You cannot remove your own admin role", 400);
  }

  if (role !== "admin") {
    const currentRole = await Role.findById(user.roleId);

    if (currentRole?.name === "admin") {
      const adminRole = await Role.findOne({ name: "admin" });
      const adminCount = adminRole
        ? await User.countDocuments({ roleId: adminRole._id })
        : 0;

      if (adminCount <= 1) {
        throw new AppError("At least one admin account is required", 400);
      }
    }
  }

  user.roleId = roleDocument._id;
  await user.save();
  await user.populate(["roleId", "primaryWallet"]);

  res.status(200).json({ success: true, user: user.toJSON() });
});

export const updateUserStatus = asyncHandler(async (req, res) => {
  const { isActive } = req.body;

  if (typeof isActive !== "boolean") {
    throw new AppError("isActive must be a boolean", 400);
  }

  const user = await User.findById(req.params.userId);

  if (!user) {
    throw new AppError("User not found", 404);
  }

  if (user._id.equals(req.user._id) && !isActive) {
    throw new AppError("You cannot deactivate your own account", 400);
  }

  user.isActive = isActive;
  await user.save();
  await user.populate(["roleId", "primaryWallet"]);

  res.status(200).json({ success: true, user: user.toJSON() });
});

export const getUniversities = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const { search, status } = req.query;
  const filter = {};

  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    filter.$or = [
      { name: regex },
      { code: regex },
      { walletAddress: regex },
    ];
  }

  if (status) {
    if (!["PENDING", "VERIFIED", "REJECTED"].includes(status)) {
      throw new AppError("Invalid verification status", 400);
    }

    filter.verificationStatus = status;
  }

  const [universities, total] = await Promise.all([
    University.find(filter)
      .populate("userId", "name email isActive")
      .populate("walletId", "address isVerified")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    University.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    universities,
    pagination: paginationMeta(page, limit, total),
  });
});

export const updateUniversityStatus = asyncHandler(async (req, res) => {
  const { verificationStatus, isActive } = req.body;

  if (!["PENDING", "VERIFIED", "REJECTED"].includes(verificationStatus)) {
    throw new AppError(
      "verificationStatus must be PENDING, VERIFIED or REJECTED",
      400
    );
  }

  const update = { verificationStatus };

  if (typeof isActive === "boolean") {
    update.isActive = isActive;
  }

  const university = await University.findByIdAndUpdate(
    req.params.universityId,
    update,
    { new: true, runValidators: true }
  )
    .populate("userId", "name email isActive")
    .populate("walletId", "address isVerified");

  if (!university) {
    throw new AppError("University not found", 404);
  }

  res.status(200).json({ success: true, university });
});

export const getNftAllocations = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const { search, minted } = req.query;
  const filter = {};

  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    filter.$or = [
      { name: regex },
      { ipfsHash: regex },
      { studentWallet: regex },
      { universityWallet: regex },
      { nftAddress: regex },
    ];
  }

  if (minted === "true" || minted === "false") {
    filter.minted = minted === "true";
  }

  const [allocations, total] = await Promise.all([
    NFT.find(filter)
      .populate("universityId", "name code")
      .populate("studentId", "name email")
      .sort({ allocatedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit),
    NFT.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    allocations,
    pagination: paginationMeta(page, limit, total),
  });
});

export const getReports = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const { resolved, search } = req.query;
  const filter = {};

  if (resolved === "true" || resolved === "false") {
    filter.resolved = resolved === "true";
  }

  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    filter.$or = [
      { nftIpfsHash: regex },
      { reportType: regex },
      { reportDetails: regex },
      { studentWallet: regex },
      { universityWallet: regex },
    ];
  }

  const [reports, total] = await Promise.all([
    Reports.find(filter)
      .populate("universityId", "name code")
      .populate("studentId", "name email")
      .sort({ reportedOn: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Reports.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    reports,
    pagination: paginationMeta(page, limit, total),
  });
});

export const resolveReport = asyncHandler(async (req, res) => {
  const { solutionDetails } = req.body;

  if (!solutionDetails || !String(solutionDetails).trim()) {
    throw new AppError("solutionDetails is required", 400);
  }

  const report = await Reports.findById(req.params.reportId);

  if (!report) {
    throw new AppError("Report not found", 404);
  }

  report.resolved = true;
  report.solutionDetails = String(solutionDetails).trim();
  report.resolvedDate = new Date();
  await report.save();
  await report.populate([
    { path: "universityId", select: "name code" },
    { path: "studentId", select: "name email" },
  ]);

  res.status(200).json({ success: true, report });
});
