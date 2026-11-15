import express from "express";
import * as nftController from "../controllers/nftController.js";
import * as institutionController from "../controllers/institutionController.js";
import * as registrationController from "../controllers/registrationController.js";
import authRoutes from "./auth.js";
import adminRoutes from "./admin.js";
import { protect, requirePermission, requireInstitution } from "../middleware/auth.js";

const router = express.Router();

// Authentication routes
router.use("/auth", authRoutes);

// Admin routes
router.use("/admin", adminRoutes);

// Public institution registration (no login: applicants have no account yet)
router.get("/registration/:token", registrationController.getPublicLink);
router.get(
  "/registration/:token/wallet/:walletAddress",
  registrationController.checkApplicationWallet
);
router.post(
  "/registration/:token/apply",
  registrationController.submitApplication
);

// NFT routes
router.post(
  "/ipfs/pin-json",
  protect,
  requireInstitution("nft:create"),
  nftController.pinMetadata
);
router.post(
  "/create-nft-ipfsHash-allocation",
  protect,
  requireInstitution("nft:create"),
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
router.get(
  "/institution/profile",
  protect,
  requireInstitution(),
  institutionController.getProfile
);
router.get("/institution/staff", protect, requireInstitution("staff:read"), institutionController.getStaff);
router.post("/institution/staff", protect, requireInstitution("staff:invite"), institutionController.inviteStaff);
router.patch(
  "/institution/staff/:membershipId",
  protect,
  requireInstitution("staff:manage"),
  institutionController.updateStaff
);

// The signed-in user's own college invitations
router.get("/memberships/invitations", protect, institutionController.getInvitations);
router.post("/memberships/:membershipId/accept", protect, institutionController.acceptInvitation);
router.post("/memberships/:membershipId/decline", protect, institutionController.declineInvitation);

router.post(
  "/batch-upload",
  protect,
  requireInstitution("batch:upload"),
  institutionController.batchUpload
);
router.get(
  "/get-all-uploaded-data",
  protect,
  requireInstitution("student:read"),
  institutionController.getAllUploadedData
);
router.post(
  "/update-nft-allocations/:walletAddress",
  protect,
  requireInstitution("nft:create"),
  institutionController.updateNftAllocations
);
router.get(
  "/get-reports",
  protect,
  requireInstitution("report:read"),
  institutionController.getAllReports
);

export default router;
