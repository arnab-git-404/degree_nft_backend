import mongoose from "mongoose";

// One document (key "platform") with settings the Super Admin edits in Admin → Settings.
const PlatformSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "platform" },
    smtp: {
      enabled: { type: Boolean, default: false },
      host: { type: String, trim: true, default: "" },
      port: { type: Number, default: 587 },
      // true = SSL/TLS from the start (port 465); false = STARTTLS upgrade (587/25/2525)
      secure: { type: Boolean, default: false },
      username: { type: String, trim: true, default: "" },
      // Encrypted with utils/secretBox; never sent to the browser.
      passwordEncrypted: { type: String, default: "", select: false },
      fromName: { type: String, trim: true, default: "DegreeNFT" },
      fromEmail: { type: String, trim: true, lowercase: true, default: "" },
      lastTestAt: Date,
      lastTestOk: Boolean,
      lastTestError: { type: String, default: "" },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export default mongoose.model("PlatformSetting", PlatformSettingSchema);
