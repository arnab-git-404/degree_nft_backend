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
    permissions: ["nft:read", "nft:confirm", "report:create"],
    isSystem: true,
  },
  {
    name: "institution",
    displayName: "Institution",
    description: "Can issue credentials and manage student allocations",
    permissions: [
      "nft:create",
      "nft:read",
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
      "program:read",
      "program:create",
      "program:update",
      "nft:create",
      "nft:read",
      "batch:upload",
      "student:read",
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
    permissions: ["nft:create", "nft:read", "student:read", "report:read", "program:read"],
    isSystem: true,
  },
  {
    name: "staff",
    displayName: "Staff",
    description: "Reads student and credential records in one college",
    scope: "INSTITUTION",
    permissions: ["nft:read", "student:read", "program:read"],
    isSystem: true,
  },
];

export default mongoose.model("Role", RoleSchema);
