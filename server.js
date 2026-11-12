import "dotenv/config";
import express from "express";
import cors from "cors";
import apiRoutes from "./routes/api.js";
import { connectDatabase } from "./utils/database.js";
import seedRoles from "./utils/seedRoles.js";
import { notFound, errorHandler } from "./middleware/errorHandler.js";

const app = express();

if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
  console.error("JWT_SECRET is required in production");
  process.exit(1);
}

const allowedOrigin = process.env.FRONTEND_URL;

// Middleware
// app.use(cors( {
//   origin: allowedOrigin,
//   optionsSuccessStatus: 200 
// }));

app.use(cors());

app.use(express.json());

// Connect to database (if using MongoDB)
if (process.env.MONGODB_URI) {
  connectDatabase()
    .then(() => seedRoles())
    .then(() => console.log("Default roles ready"))
    .catch((error) => console.error("Role seeding failed:", error));
}

app.get("/", (req, res) => {
  res.status(200).send("Welcome to DegreeNFT Backend Server !!!");
});

// API Routes
app.use("/api", apiRoutes);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
