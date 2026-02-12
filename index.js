import express from "express";
import pkg from "pg";
import { v4 as uuidv4 } from "uuid";

const { Pool } = pkg;
const app = express();
const PORT = process.env.PORT || 3000;

/* ================= DATABASE ================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.redirect("/login.html");
});

/* ================= SESSION VALIDATION ================= */

async function validateSession(req, res, next) {
  const sessionId = req.headers["sessionid"];

  if (!sessionId) {
    return res.status(401).json({ error: "No session" });
  }

  const user = await pool.query(`
    SELECT *
    FROM sfdc_contacts
    WHERE session_id = $1
      AND session_expiry > CURRENT_TIMESTAMP
  `, [sessionId]);

  if (user.rowCount === 0) {
    return res.status(401).json({ error: "Session expired" });
  }

  req.user = user.rows[0];
  next();
}

/* ================= LOGIN ================= */

app.post("/login", async (req, res) => {

  const { username, password } = req.body;

  // ADMIN LOGIN
  if (username === "admin" && password === "admin") {

    const sessionId = uuidv4();

    await pool.query(`
      UPDATE sfdc_contacts
      SET session_id=$1,
          session_expiry=NOW() + INTERVAL '15 minutes'
      WHERE role='Admin'
    `, [sessionId]);

    return res.json({
      success: true,
      role: "Admin",
      sessionId
    });
  }

  // SALES LOGIN
  const user = await pool.query(`
    SELECT *
    FROM sfdc_contacts
    WHERE emailid=$1
      AND contact_password=$2
      AND role='Sales'
      AND status='Active'
  `, [username, password]);

  if (user.rowCount === 0) {
    return res.status(401).json({
      success: false,
      message: "Invalid credentials"
    });
  }

  const sessionId = uuidv4();

  await pool.query(`
    UPDATE sfdc_contacts
    SET session_id=$1,
        session_expiry=NOW() + INTERVAL '15 minutes'
    WHERE salesforce_id=$2
  `, [sessionId, user.rows[0].salesforce_id]);

  res.json({
    success: true,
    role: "Sales",
    sessionId
  });
});

/* ================= LOGOUT ================= */

app.post("/api/logout", validateSession, async (req, res) => {

  await pool.query(`
    UPDATE sfdc_contacts
    SET session_id=NULL,
        session_expiry=NULL
    WHERE session_id=$1
  `, [req.headers["sessionid"]]);

  res.json({ success: true });
});

/* ================= USERS (ADMIN VIEW) ================= */

app.get("/api/users", validateSession, async (req, res) => {

  if (req.user.role !== "Admin") {
    return res.status(403).json({ error: "Not allowed" });
  }

  const users = await pool.query(`
    SELECT salesforce_id, firstname, lastname,
           emailid, phone, status
    FROM sfdc_contacts
    WHERE role='Sales'
  `);

  res.json(users.rows);
});

/* ================= UPDATE STATUS ================= */

app.post("/api/status", validateSession, async (req, res) => {

  if (req.user.role !== "Admin") {
    return res.status(403).json({ error: "Only Admin allowed" });
  }

  const { id, status } = req.body;

  await pool.query(`
    UPDATE sfdc_contacts
    SET status=$1
    WHERE salesforce_id=$2
  `, [status, id]);

  res.json({ success: true });
});

/* ================= RESET PASSWORD ================= */

app.post("/api/password", validateSession, async (req, res) => {

  if (req.user.role !== "Admin") {
    return res.status(403).json({ error: "Only Admin allowed" });
  }

  const { id, password } = req.body;

  await pool.query(`
    UPDATE sfdc_contacts
    SET contact_password=$1
    WHERE salesforce_id=$2
  `, [password, id]);

  res.json({ success: true });
});

/* ================= PROFILE ================= */

app.get("/api/profile", validateSession, async (req, res) => {

  res.json({
    firstname: req.user.firstname,
    lastname: req.user.lastname,
    email: req.user.emailid,
    phone: req.user.phone,
    status: req.user.status
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
