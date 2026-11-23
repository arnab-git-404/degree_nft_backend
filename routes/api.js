import express from "express";
import * as credentialController from "../controllers/credentialController.js";
import * as institutionController from "../controllers/institutionController.js";
import * as registrationController from "../controllers/registrationController.js";
import * as programController from "../controllers/programController.js";
import * as collegeRoleController from "../controllers/collegeRoleController.js";
import * as studentController from "../controllers/studentController.js";
import * as enrollmentController from "../controllers/enrollmentController.js";
import * as credentialTypeController from "../controllers/credentialTypeController.js";
import * as chainController from "../controllers/chainController.js";
import * as requestController from "../controllers/credentialRequestController.js";
import * as verifyController from "../controllers/verifyController.js";
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

// Credentials: the college issues and corrects them, the student confirms and mints them
router.post("/ipfs/pin-json", protect, requireInstitution("credential:create"), credentialController.pinMetadata);
router.post("/institution/credentials", protect, requireInstitution("credential:create"), credentialController.issueCredential);
router.get("/institution/credentials", protect, requireInstitution("credential:read"), credentialController.listCollegeCredentials);
router.post("/institution/credentials/:credentialId/revise", protect, requireInstitution("credential:create"), credentialController.reviseCredential);
router.get("/student/credentials/next/:walletAddress", protect, requirePermission("credential:read"), credentialController.getNextCredential);
router.get("/student/credentials/minted/:walletAddress", protect, requirePermission("credential:read"), credentialController.getMintedCredentials);
router.post("/student/credentials/confirm", protect, requirePermission("credential:confirm"), credentialController.confirmCredential);
router.post("/student/credentials/claim", protect, requirePermission("credential:confirm"), credentialController.claimCredential);
router.post("/student/credentials/report", protect, requirePermission("report:create"), credentialController.createReport);

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

// Public verification (no login): the link and QR on every issued credential
router.get("/verify/:assetAddress", verifyController.verifyCredential);

// Credential lifecycle: academic status (one person), wallet recovery and burning (two approvals, two people)
router.post("/institution/credentials/:credentialId/status", protect, requireInstitution("credential:revoke"), requestController.changeAcademicStatus);
router.post("/institution/credentials/:credentialId/burn", protect, requireInstitution("credential:burn"), requestController.requestBurn);
router.post("/institution/students/:studentId/recovery", protect, requireInstitution("credential:recover"), requestController.startRecovery);
router.get("/institution/credential-requests", protect, requireInstitution(), requestController.listRequests);
router.post("/institution/credential-requests/:requestId/approve-first", protect, requireInstitution("approval:first"), requestController.approveFirst);
router.post("/institution/credential-requests/:requestId/approve-final", protect, requireInstitution("approval:final"), requestController.approveFinal);
router.post("/institution/credential-requests/:requestId/retry", protect, requireInstitution("approval:final"), requestController.retryRequest);
router.post("/institution/credential-requests/:requestId/reject", protect, requireInstitution(), requestController.rejectRequest);

// Billing: the college's prepaid balance (on-chain payments to the DegreeNFT treasury, charges per minted credential)
router.get("/institution/billing", protect, requireInstitution("billing:read"), chainController.getCollegeBilling);
router.post("/institution/billing/sync", protect, requireInstitution("billing:read"), chainController.syncCollegeDeposits);

// Credential types: the college's master list of what it issues
router.get("/institution/credential-types", protect, requireInstitution("credentialType:read"), credentialTypeController.listCredentialTypes);
router.post("/institution/credential-types", protect, requireInstitution("credentialType:create"), credentialTypeController.createCredentialType);
router.patch("/institution/credential-types/:credentialTypeId", protect, requireInstitution("credentialType:update"), credentialTypeController.updateCredentialType);

// Academic catalog (P05)
router.get("/institution/programs", protect, requireInstitution("program:read"), programController.listPrograms);
router.post("/institution/programs", protect, requireInstitution("program:create"), programController.createProgram);
router.patch(
  "/institution/programs/:programId",
  protect,
  requireInstitution("program:update"),
  programController.updateProgram
);
router.get(
  "/institution/program-sessions",
  protect,
  requireInstitution("programSession:read"),
  programController.listProgramSessions
);
router.post(
  "/institution/program-sessions",
  protect,
  requireInstitution("programSession:create"),
  programController.createProgramSession
);
router.patch(
  "/institution/program-sessions/:sessionId",
  protect,
  requireInstitution("programSession:update"),
  programController.updateProgramSession
);

// College administration: academic sessions (2024-25) that programs take intakes in
router.get(
  "/institution/academic-sessions",
  protect,
  requireInstitution("academicSession:read"),
  programController.listAcademicSessions
);
router.post(
  "/institution/academic-sessions",
  protect,
  requireInstitution("academicSession:manage"),
  programController.createAcademicSession
);
router.patch(
  "/institution/academic-sessions/:academicSessionId",
  protect,
  requireInstitution("academicSession:manage"),
  programController.updateAcademicSession
);

// College Admin › Roles: the college's own roles (shared roles are read-only here)
router.get("/institution/roles", protect, requireInstitution("role:manage"), collegeRoleController.listCollegeRoles);
router.post("/institution/roles", protect, requireInstitution("role:manage"), collegeRoleController.createCollegeRole);
router.patch("/institution/roles/:roleId", protect, requireInstitution("role:manage"), collegeRoleController.updateCollegeRole);

// College student profiles (P05-03)
router.get("/institution/students", protect, requireInstitution("student:read"), studentController.listStudents);
router.post("/institution/students", protect, requireInstitution("student:create"), studentController.createStudent);
router.post("/institution/students/import", protect, requireInstitution("student:create"), studentController.importStudents);
router.patch("/institution/students/:studentId", protect, requireInstitution("student:update"), studentController.updateStudent);
router.post("/institution/students/:studentId/invite", protect, requireInstitution("student:update"), studentController.inviteStudent);

// Enrollments: a student in a batch (P05-04/05)
router.get("/institution/enrollments", protect, requireInstitution("enrollment:read"), enrollmentController.listEnrollments);
router.post("/institution/enrollments", protect, requireInstitution("enrollment:create"), enrollmentController.createEnrollment);
router.post("/institution/enrollments/import", protect, requireInstitution("enrollment:create"), enrollmentController.importEnrollments);
router.patch("/institution/enrollments/:enrollmentId", protect, requireInstitution("enrollment:update"), enrollmentController.updateEnrollment);

// Settings › Activity log: the selected college's own history
router.get("/institution/activity", protect, requireInstitution("audit:read"), institutionController.getActivity);

// The signed-in user's own college invitations
router.get("/memberships/invitations", protect, institutionController.getInvitations);
router.post("/memberships/:membershipId/accept", protect, institutionController.acceptInvitation);
router.post("/memberships/:membershipId/decline", protect, institutionController.declineInvitation);

router.get(
  "/institution/credential-stats",
  protect,
  requireInstitution("batch:upload"),
  institutionController.getCredentialStats
);
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
router.get(
  "/get-reports",
  protect,
  requireInstitution("report:read"),
  institutionController.getAllReports
);

export default router;
