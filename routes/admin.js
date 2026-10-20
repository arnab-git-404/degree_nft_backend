import express from "express";
import * as adminController from "../controllers/adminController.js";
import { protect, authorize } from "../middleware/auth.js";

const router = express.Router();

router.use(protect, authorize("admin"));

router.get("/stats", adminController.getDashboardStats);
router.get("/roles", adminController.getRoles);

router.get("/users", adminController.getUsers);
router.patch("/users/:userId/role", adminController.updateUserRole);
router.patch("/users/:userId/status", adminController.updateUserStatus);

router.get("/universities", adminController.getUniversities);
router.patch(
  "/universities/:universityId/status",
  adminController.updateUniversityStatus
);

router.get("/nfts", adminController.getNftAllocations);

router.get("/reports", adminController.getReports);
router.patch("/reports/:reportId/resolve", adminController.resolveReport);

export default router;
