import express from "express";
import cors from "cors";
import apiRoutes from "./routes/api.js";
import { notFound, errorHandler } from "./middleware/errorHandler.js";

const app = express();
app.set("trust proxy", 1);

export const allowedOrigins = (
  process.env.CORS_ORIGINS ||
  process.env.FRONTEND_URL ||
  ""
)
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);
if (!allowedOrigins.length && process.env.NODE_ENV === "production") {
  console.warn(
    "CORS_ORIGINS / FRONTEND_URL is not set: browsers on other sites cannot call this API.",
  );
}

app.use(
  cors({
    origin: allowedOrigins.length
      ? allowedOrigins
      : process.env.NODE_ENV !== "production",
  }),
);

app.use(express.json());

// The API's home page (also the uptime check: it always answers 200).
app.get("/", (req, res) => {
  res.status(200).type("html").send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>DegreeNFT API</title></head>
<body style="text-align: center">
  <h1>Welcome to DegreeNFT Backend Server</h1>
  <h3>Thank You</h3>
</body>
</html>`);
});

// API Routes
app.use("/api", apiRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
