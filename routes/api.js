import express from "express";
import * as nftController from "../controllers/nftController.js";
import * as universityController from "../controllers/universityController.js";
import * as registrationController from "../controllers/registrationController.js";
import authRoutes from "./auth.js";
import adminRoutes from "./admin.js";
import { protect, requirePermission } from "../middleware/auth.js";

const router = express.Router();

// Authentication routes
router.use("/auth", authRoutes);

// Admin routes
router.use("/admin", adminRoutes);

// Public university registration (no login: applicants have no account yet)
router.get("/registration/:token", registrationController.getPublicLink);
router.post(
  "/registration/:token/apply",
  registrationController.submitApplication
);

// NFT routes
router.post(
  "/create-nft-ipfsHash-allocation",
  protect,
  requirePermission("nft:create"),
  nftController.createNftAllocation
);
router.get(
  "/check-authorization/:walletAddress",
  protect,
  requirePermission("nft:read"),
  nftController.checkAuthorization
);
router.post(
  "/confirm-mint",
  protect,
  requirePermission("nft:confirm"),
  nftController.confirmMint
);
router.get(
  "/minted-nfts/:walletAddress",
  protect,
  requirePermission("nft:read"),
  nftController.getMintedNfts
);
router.post(
  "/confirm-nft-credential",
  protect,
  requirePermission("nft:confirm"),
  nftController.confirmCredential
);
router.post(
  "/report-issue",
  protect,
  requirePermission("report:create"),
  nftController.createReport
);

// University routes
router.post(
  "/university/profile",
  protect,
  universityController.createProfile
);
router.get(
  "/university/profile",
  protect,
  universityController.getProfile
);
router.post(
  "/batch-upload",
  protect,
  requirePermission("batch:upload"),
  universityController.batchUpload
);
router.get(
  "/get-all-uploaded-data",
  protect,
  requirePermission("student:read"),
  universityController.getAllUploadedData
);
router.post(
  "/update-nft-allocations/:walletAddress",
  protect,
  requirePermission("nft:create"),
  universityController.updateNftAllocations
);
router.get(
  "/get-reports",
  protect,
  requirePermission("report:read"),
  universityController.getAllReports
);

export default router;
