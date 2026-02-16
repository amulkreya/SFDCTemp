require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true
}));

function isAuthenticated(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/');
}

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/views/login.html');
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query("SELECT * FROM admins WHERE username=$1", [username]);

  if (result.rows.length > 0) {
    const user = result.rows[0];
    if (await bcrypt.compare(password, user.password)) {
      req.session.user = user;
      return res.redirect('/dashboard');
    }
  }
  res.send("Invalid credentials");
});

app.get('/dashboard', isAuthenticated, (req, res) => {
  res.sendFile(__dirname + '/views/dashboard.html');
});

-- DONORS WITH PAGINATION
app.get('/donors', isAuthenticated, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 5;
  const offset = (page - 1) * limit;

  const result = await pool.query(
    "SELECT * FROM donors ORDER BY id DESC LIMIT $1 OFFSET $2",
    [limit, offset]
  );

  res.json(result.rows);
});

-- CREATE DONOR
app.post('/donors/new', isAuthenticated, async (req, res) => {
  const { first_name, last_name, email, mobile, city, state, remarks } = req.body;
  const donorId = 'DN' + Date.now();

  await pool.query(
    "INSERT INTO donors (donor_id, first_name, last_name, email, mobile, city, state, remarks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [donorId, first_name, last_name, email, mobile, city, state, remarks]
  );

  res.redirect('/dashboard');
});

-- SEARCH DONOR BY MOBILE
app.get('/search-donor', isAuthenticated, async (req, res) => {
  const { mobile } = req.query;
  const result = await pool.query("SELECT * FROM donors WHERE mobile=$1", [mobile]);
  res.json(result.rows);
});

-- CREATE PROGRAM
app.post('/programs/new', isAuthenticated, async (req, res) => {
  const { program_name, description } = req.body;

  await pool.query(
    "INSERT INTO programs (program_name, description) VALUES ($1,$2)",
    [program_name, description]
  );

  res.redirect('/dashboard');
});

-- CREATE DONATION
app.post('/donations/new', isAuthenticated, async (req, res) => {
  const { donor_id, program_id, donation_amount, donation_date, payment_mode, remarks } = req.body;

  await pool.query(
    "INSERT INTO donations (donor_id, program_id, donation_amount, donation_date, payment_mode, remarks) VALUES ($1,$2,$3,$4,$5,$6)",
    [donor_id, program_id, donation_amount, donation_date, payment_mode, remarks]
  );

  res.redirect('/dashboard');
});

-- CREATE EXPENSE
app.post('/expenses/new', isAuthenticated, async (req, res) => {
  const { program_id, expense_amount, expense_date, expense_description, submitted_by, status, remarks } = req.body;

  await pool.query(
    "INSERT INTO expenses (program_id, expense_amount, expense_date, expense_description, submitted_by, status, remarks) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [program_id, expense_amount, expense_date, expense_description, submitted_by, status, remarks]
  );

  res.redirect('/dashboard');
});

app.listen(process.env.PORT, () => {
  console.log("Server running...");
});
