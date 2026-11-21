import mongoose from "mongoose";
import { colorFromSeed, hashString, HEX_COLOR } from "../utils/color.js";

export const MEMBERSHIP_STATUSES = ["INVITED", "ACTIVE", "SUSPENDED"];

// A user's access inside one college. Permissions come from roleId (a Role with scope INSTITUTION),
// so a Registrar at ABC has no rights at XYZ.
const InstitutionMembershipSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    institutionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Institution",
      required: true,
      index: true,
    },
    roleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Role",
      required: true,
    },
    status: {
      type: String,
      enum: MEMBERSHIP_STATUSES,
      default: "INVITED",
      required: true,
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    invitedAt: Date,
    acceptedAt: Date,
    // Hex colour for the person's avatar tile: set from the user id unless a colour is picked.
    color: { type: String, match: HEX_COLOR },
  },
  { timestamps: true },
);

InstitutionMembershipSchema.pre("validate", function setColor() {
  if (!this.color && this.userId)
    this.color = colorFromSeed(hashString(String(this.userId)));
});

InstitutionMembershipSchema.index(
  { userId: 1, institutionId: 1 },
  { unique: true },
);

// The role must be a college-level role, never a platform role, and a college's own role only in that college.
InstitutionMembershipSchema.pre("validate", async function checkRoleScope() {
  if (!this.isModified("roleId")) return;
  const role = await mongoose
    .model("Role")
    .findById(this.roleId)
    .select("scope institutionId");
  if (role?.scope !== "INSTITUTION") {
    this.invalidate(
      "roleId",
      "Membership role must be an INSTITUTION-scoped role",
    );
  } else if (
    role.institutionId &&
    !role.institutionId.equals(this.institutionId)
  ) {
    this.invalidate("roleId", "This role belongs to another college");
  }
});

export default mongoose.model(
  "InstitutionMembership",
  InstitutionMembershipSchema,
);
