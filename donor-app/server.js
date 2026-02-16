import express from "express";
import session from "express-session";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "pg";

dotenv.config();

const { Pool } = pkg;

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===============================
// DATABASE CONNECTION
// ===============================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ===============================
// MIDDLEWARE
// ===============================
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || "mysecret",
  resave: false,
  saveUninitialized: false
}));

app.use(express.static(path.join(__dirname, "public")));

// ===============================
// AUTH MIDDLEWARE
// ===============================
function isAuthenticated(req, res, next) {
  if (req.session.user) {
    return next();
  }
  res.redirect("/");
}

// ===============================
// PAGE ROUTES
// ===============================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "donorlogin.html"));
});

app.get("/dashboard", isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "dashboard.html"));
});

app.get("/donors-page", isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "donors.html"));
});

app.get("/new-donor-page", isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "new-donor.html"));
});

app.get("/programs-page", isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "programs.html"));
});

app.get("/new-program-page", isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "new-program.html"));
});

app.get("/donations-page", isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "donations.html"));
});

app.get("/new-donation-page", isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "new-donation.html"));
});

app.get("/expenses-page", isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "expenses.html"));
});

app.get("/new-expense-page", isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "new-expense.html"));
});

// ===============================
// LOGIN (PLAIN TEXT)
// ===============================
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await pool.query(
      "SELECT * FROM admins WHERE username = $1",
      [username]
    );

    if (result.rows.length === 0) {
      return res.send("Invalid username");
    }

    const user = result.rows[0];

    if (password !== user.password) {
      return res.send("Invalid password");
    }

    req.session.user = user;
    res.redirect("/dashboard");

  } catch (err) {
    console.error("Login Error:", err);
    res.send("Login error");
  }
});

// ===============================
// LOGOUT
// ===============================
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

// ===============================
// DONORS API
// ===============================

// Pagination (5 per page)
app.get("/donors", isAuthenticated, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 5;
  const offset = (page - 1) * limit;

  try {
    const result = await pool.query(
      "SELECT * FROM donors ORDER BY id DESC LIMIT $1 OFFSET $2",
      [limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error fetching donors" });
  }
});

// Create donor
app.post("/donors/new", isAuthenticated, async (req, res) => {
  const { first_name, last_name, email, mobile, city, state, remarks } = req.body;
  const donorId = "DN" + Date.now();

  try {
    await pool.query(
      `INSERT INTO donors 
      (donor_id, first_name, last_name, email, mobile, city, state, remarks)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [donorId, first_name, last_name, email, mobile, city, state, remarks]
    );

    res.redirect("/donors-page");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error creating donor");
  }
});

// Search donor
app.get("/donors/search", isAuthenticated, async (req, res) => {
  const { mobile } = req.query;

  try {
    const result = await pool.query(
      "SELECT * FROM donors WHERE mobile = $1",
      [mobile]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Search error" });
  }
});

// ===============================
// PROGRAMS API
// ===============================

app.get("/programs", isAuthenticated, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM programs ORDER BY id DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error fetching programs" });
  }
});

app.post("/programs/new", isAuthenticated, async (req, res) => {
  const { program_name, description } = req.body;

  try {
    await pool.query(
      "INSERT INTO programs (program_name, description) VALUES ($1,$2)",
      [program_name, description]
    );

    res.redirect("/programs-page");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error creating program");
  }
});

// ===============================
// DONATIONS API
// ===============================

// Create donation
app.post("/donations/new", isAuthenticated, async (req, res) => {
  const { donor_id, program_id, donation_amount, donation_date, payment_mode, remarks } = req.body;

  try {
    await pool.query(
      `INSERT INTO donations
      (donor_id, program_id, donation_amount, donation_date, payment_mode, remarks)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [donor_id, program_id, donation_amount, donation_date, payment_mode, remarks]
    );

    res.redirect("/donations-page");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error creating donation");
  }
});

// List donations
app.get("/donations-list", isAuthenticated, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.*, dn.first_name, dn.last_name, p.program_name
      FROM donations d
      JOIN donors dn ON d.donor_id = dn.id
      LEFT JOIN programs p ON d.program_id = p.id
      ORDER BY d.id DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error fetching donations" });
  }
});

// ===============================
// EXPENSES API
// ===============================

// Create expense
app.post("/expenses/new", isAuthenticated, async (req, res) => {
  const { program_id, expense_amount, expense_date, expense_description, submitted_by, status, remarks } = req.body;

  try {
    await pool.query(
      `INSERT INTO expenses
      (program_id, expense_amount, expense_date, expense_description, submitted_by, status, remarks)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [program_id, expense_amount, expense_date, expense_description, submitted_by, status, remarks]
    );

    res.redirect("/expenses-page");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error creating expense");
  }
});

// List expenses
app.get("/expenses-list", isAuthenticated, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.*, p.program_name
      FROM expenses e
      LEFT JOIN programs p ON e.program_id = p.id
      ORDER BY e.id DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error fetching expenses" });
  }
});

// ===============================
// SERVER START
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Donor App Running on Port ${PORT}`);
});
