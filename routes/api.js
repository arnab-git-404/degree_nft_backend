import express from "express";
import * as nftController from "../controllers/nftController.js";
import * as institutionController from "../controllers/institutionController.js";
import * as registrationController from "../controllers/registrationController.js";
import authRoutes from "./auth.js";
import adminRoutes from "./admin.js";
import { protect, requirePermission } from "../middleware/auth.js";

const router = express.Router();

// Authentication routes
router.use("/auth", authRoutes);

// Admin routes
router.use("/admin", adminRoutes);

// Public institution registration (no login: applicants have no account yet)
router.get("/registration/:token", registrationController.getPublicLink);
router.post(
  "/registration/:token/apply",
  registrationController.submitApplication
);

// NFT routes
router.post(
  "/ipfs/pin-json",
  protect,
  requirePermission("nft:create"),
  nftController.pinMetadata
);
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

// Institution routes
// Only accounts whose role can issue credentials may create a profile (no self-promotion).
router.post(
  "/institution/profile",
  protect,
  requirePermission("nft:create"),
  institutionController.createProfile
);
router.get(
  "/institution/profile",
  protect,
  institutionController.getProfile
);
router.post(
  "/batch-upload",
  protect,
  requirePermission("batch:upload"),
  institutionController.batchUpload
);
router.get(
  "/get-all-uploaded-data",
  protect,
  requirePermission("student:read"),
  institutionController.getAllUploadedData
);
router.post(
  "/update-nft-allocations/:walletAddress",
  protect,
  requirePermission("nft:create"),
  institutionController.updateNftAllocations
);
router.get(
  "/get-reports",
  protect,
  requirePermission("report:read"),
  institutionController.getAllReports
);

export default router;
