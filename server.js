import "dotenv/config";
import app from "./app.js";
import { connectDatabase } from "./utils/database.js";
import seedRoles from "./utils/seedRoles.js";

if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
  console.error("JWT_SECRET is required in production");
  process.exit(1);
}

// Connect to database (if using MongoDB)
if (process.env.MONGODB_URI) {
  connectDatabase()
    .then(() => seedRoles())
    .then(() => console.log("Default roles ready"))
    .catch((error) => console.error("Role seeding failed:", error));
}

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
