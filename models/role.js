import mongoose from "mongoose";

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
    name: "university",
    displayName: "University",
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
];

export default mongoose.model("Role", RoleSchema);
