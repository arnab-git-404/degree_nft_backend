import express from "express";
import * as authController from "../controllers/authController.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

router.post("/nonce", authController.requestNonce);
router.post("/register", authController.register);
router.post("/login", authController.login);
router.post("/login/wallet", authController.walletLogin);
router.get("/me", protect, authController.getMe);
router.post("/wallet/link", protect, authController.linkWallet);
router.patch(
  "/wallet/:walletId/primary",
  protect,
  authController.setPrimaryWallet
);

export default router;
