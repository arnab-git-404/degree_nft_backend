import express from "express";
import * as authController from "../controllers/authController.js";
import { protect } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";

// Public endpoints: brute force and spam limits per IP.
const signInLimit = rateLimit({ bucket: "auth-sign-in", max: 20 });
const linkLimit = rateLimit({ bucket: "auth-link", max: 20 });

const router = express.Router();

router.post("/nonce", signInLimit, authController.requestNonce);
router.post("/activate/resend", linkLimit, authController.resendActivation);
router.post("/activate/:token", authController.activateAccount);
router.post("/activate", authController.activateAccount);
router.post("/login", signInLimit, authController.login);
router.post("/login/wallet", signInLimit, authController.walletLogin);
router.get("/student-invite/:token", linkLimit, authController.getStudentInvite);
router.post("/student-invite/:token/claim", linkLimit, authController.claimStudentInvite);
router.get("/recovery/:token", linkLimit, authController.getRecovery);
router.post("/recovery/:token/prove", linkLimit, authController.proveRecoveryWallet);
router.get("/me", protect, authController.getMe);
router.patch("/profile", protect, authController.updateProfile);
router.patch("/password", protect, authController.changePassword);
router.post("/wallet/link", protect, authController.linkWallet);
router.patch(
  "/wallet/:walletId/primary",
  protect,
  authController.setPrimaryWallet
);
router.delete("/wallet/:walletId", protect, authController.unlinkWallet);

export default router;
