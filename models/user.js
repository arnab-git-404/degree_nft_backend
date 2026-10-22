import mongoose from "mongoose";

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

UserSchema.virtual("university", {
  ref: "University",
  localField: "_id",
  foreignField: "userId",
  justOne: true,
});

UserSchema.virtual("studentProfiles", {
  ref: "StudentDetails",
  localField: "_id",
  foreignField: "studentId",
});

export default mongoose.model("User", UserSchema);
