import express from "express";
import * as adminController from "../controllers/adminController.js";
import {
  protect,
  authorize,
  requirePermission,
} from "../middleware/auth.js";

const router = express.Router();

router.use(protect, authorize("admin"));

router.get("/stats", adminController.getDashboardStats);

router.get("/permissions", adminController.getPermissionCatalog);
router.get("/roles", adminController.getRoles);
router.post("/roles", adminController.createRole);
router.get("/roles/:roleId/users", adminController.getRoleUsers);
router.patch("/roles/:roleId", adminController.updateRole);
router.delete("/roles/:roleId", adminController.deleteRole);

router.get("/users", adminController.getUsers);
router.patch("/users/:userId/role", adminController.updateUserRole);
router.patch("/users/:userId/status", adminController.updateUserStatus);

router.get("/universities", adminController.getUniversities);
router.patch(
  "/universities/:universityId/status",
  adminController.updateUniversityStatus
);

router.get("/nfts", adminController.getNftAllocations);

router.get(
  "/reports",
  requirePermission("report:read"),
  adminController.getReports
);
router.patch(
  "/reports/:reportId/resolve",
  requirePermission("report:resolve"),
  adminController.resolveReport
);

export default router;
