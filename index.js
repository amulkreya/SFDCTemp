import express from "express";
import pkg from "pg";
import { v4 as uuidv4 } from "uuid";

const { Pool } = pkg;
const app = express();
const PORT = process.env.PORT || 3000;

/* DB Connection */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* Middleware */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

/* ---------------- LOGIN API ---------------- */
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  // Hardcoded admin credentials (as requested)
  if (username !== "admin" || password !== "admin") {
    return res.status(401).send("Invalid credentials");
  }

  const sessionId = uuidv4();

  await pool.query(
    `
    UPDATE sfdc_contacts
    SET session_id = $1,
        loggedin_at = CURRENT_TIMESTAMP,
        role = 'Admin'
    WHERE username = $2
    `,
    [sessionId, username]
  );

  res.redirect(`/home.html?sessionId=${sessionId}`);
});

/* ---------------- AUTH CHECK ---------------- */
app.get("/api/users", async (req, res) => {
  const { sessionId } = req.query;

  const sessionCheck = await pool.query(
    `
    SELECT * FROM sfdc_contacts
    WHERE session_id = $1
      AND role = 'Admin'
    `,
    [sessionId]
  );

  if (sessionCheck.rowCount === 0) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const users = await pool.query(
    `
    SELECT salesforce_id, emailid, username, firstname, lastname, role, active
    FROM sfdc_contacts
    ORDER BY created_at DESC
    `
  );

  res.json(users.rows);
});

/* ---------------- HEALTH ---------------- */
app.get("/health", (req, res) => {
  res.json({ status: "UP" });
});

/* Start Server */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
