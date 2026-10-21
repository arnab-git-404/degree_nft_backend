import mongoose from "mongoose";

export const connectDatabase = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      dbName: process.env.MONGODB_DB_NAME || "DegreeNft",
    });
    console.log("MongoDB connected successfully..");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
};
