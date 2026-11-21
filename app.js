import express from "express";
import cors from "cors";
import apiRoutes from "./routes/api.js";
import { notFound, errorHandler } from "./middleware/errorHandler.js";

const app = express();

const allowedOrigin = process.env.FRONTEND_URL;

// Middleware
// app.use(cors( {
//   origin: allowedOrigin,
//   optionsSuccessStatus: 200
// }));

app.use(cors());

app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).send("Welcome to DegreeNFT Backend Server !!!");
});

// API Routes
app.use("/api", apiRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
