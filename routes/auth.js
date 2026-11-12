import express from "express";
import * as authController from "../controllers/authController.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

router.post("/nonce", authController.requestNonce);
router.post("/register", authController.register);
router.post("/activate/resend", authController.resendActivation);
router.post("/activate/:token", authController.activateAccount);
router.post("/activate", authController.activateAccount);
router.post("/login", authController.login);
router.post("/login/wallet", authController.walletLogin);
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
