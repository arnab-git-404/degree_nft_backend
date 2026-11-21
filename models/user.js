import mongoose from "mongoose";

export const USER_TYPES = ["SUPER_ADMIN", "ADMIN", "STAFF", "STUDENT"];
// Bootstrap platform operator (env admin wallets, seedAdmin). Everyone else is labelled by an admin.
export const SUPER_ADMIN_ACCOUNT = { userType: "SUPER_ADMIN" };

const UserSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true,
      match: [/^\S+@\S+\.\S+$/, "Please provide a valid email address"],
    },
    passwordHash: {
      type: String,
      select: false,
    },
    roleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Role",
      required: true,
      index: true,
    },
    // UI/onboarding label only; access always comes from the role's permissions.
    userType: {
      type: String,
      enum: USER_TYPES,
      default: "STUDENT",
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    activationTokenHash: {
      type: String,
      select: false,
    },
    activationExpiresAt: {
      type: Date,
      select: false,
    },
    phone: {
      type: String,
      trim: true,
      default: "",
    },
    bio: {
      type: String,
      trim: true,
      maxlength: 280,
      default: "",
    },
    avatarUrl: {
      type: String,
      trim: true,
      default: "",
    },
    lastLoginAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        delete ret.passwordHash;
        return ret;
      },
    },
    toObject: {
      virtuals: true,
    },
  }
);

UserSchema.virtual("wallets", {
  ref: "Wallet",
  localField: "_id",
  foreignField: "userId",
});

UserSchema.virtual("primaryWallet", {
  ref: "Wallet",
  localField: "_id",
  foreignField: "userId",
  match: { isPrimary: true },
  justOne: true,
});

UserSchema.virtual("institution", {
  ref: "Institution",
  localField: "_id",
  foreignField: "userId",
  justOne: true,
});

UserSchema.virtual("memberships", {
  ref: "InstitutionMembership",
  localField: "_id",
  foreignField: "userId",
});

UserSchema.virtual("studentProfiles", {
  ref: "StudentDetails",
  localField: "_id",
  foreignField: "userId",
});

export default mongoose.model("User", UserSchema);
