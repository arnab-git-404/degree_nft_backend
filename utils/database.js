import mongoose from "mongoose";

export const connectDatabase = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      dbName: "DegreeNft",
    });
    console.log("MongoDB connected successfully..");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
};
