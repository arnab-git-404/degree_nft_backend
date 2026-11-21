import mongoose from "mongoose";

export const ROLE_SCOPES = ["PLATFORM", "INSTITUTION"];

const RoleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    displayName: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    permissions: [
      {
        type: String,
        trim: true,
      },
    ],
    // PLATFORM roles go on users.roleId; INSTITUTION roles go on institutionMemberships.roleId (rights in one college only).
    scope: {
      type: String,
      enum: ROLE_SCOPES,
      default: "PLATFORM",
      required: true,
      index: true,
    },
    // Set on a role a college made for itself (usable only there); null = shared by every college.
    institutionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Institution",
      default: null,
      immutable: true,
      index: true,
    },
    isSystem: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

RoleSchema.statics.DEFAULT_ROLES = [
  {
    name: "student",
    displayName: "Student",
    description: "Can claim credentials and report issues",
    permissions: ["credential:read", "credential:confirm", "report:create"],
    isSystem: true,
  },
  {
    name: "institution",
    displayName: "Institution",
    description: "Can issue credentials and manage student allocations",
    permissions: [
      "credential:create",
      "credential:read",
      "batch:upload",
      "student:read",
      "report:read",
      "report:resolve",
    ],
    isSystem: true,
  },
  {
    name: "admin",
    displayName: "Admin",
    description: "Full platform access",
    permissions: ["*"],
    isSystem: true,
  },
  {
    name: "institution_admin",
    displayName: "Institution Admin",
    description: "Head of a college: issues credentials, manages its records and staff",
    scope: "INSTITUTION",
    permissions: [
      "staff:read",
      "staff:invite",
      "staff:manage",
      "role:manage",
      "audit:read",
      "program:read",
      "program:create",
      "program:update",
      "programSession:read",
      "programSession:create",
      "programSession:update",
      "credentialType:read",
      "credentialType:create",
      "credentialType:update",
      "academicSession:read",
      "academicSession:manage",
      "credential:create",
      "credential:read",
      "batch:upload",
      "student:read",
      "student:create",
      "student:update",
      "enrollment:read",
      "enrollment:create",
      "enrollment:update",
      "report:read",
      "report:resolve",
    ],
    isSystem: true,
  },
  {
    name: "registrar",
    displayName: "Registrar",
    description: "Issues credentials and reads student records in one college",
    scope: "INSTITUTION",
    permissions: [
      "credential:create",
      "credential:read",
      "student:read",
      "student:create",
      "student:update",
      "enrollment:read",
      "enrollment:create",
      "enrollment:update",
      "report:read",
      "program:read",
      "programSession:read",
      "academicSession:read",
      "credentialType:read",
    ],
    isSystem: true,
  },
  {
    name: "staff",
    displayName: "Staff",
    description: "Reads student and credential records in one college",
    scope: "INSTITUTION",
    permissions: ["credential:read", "student:read", "enrollment:read", "program:read", "programSession:read", "academicSession:read", "credentialType:read"],
    isSystem: true,
  },
];

export default mongoose.model("Role", RoleSchema);
