import express from "express";
import pkg from "pg";
import { v4 as uuidv4 } from "uuid";

const { Pool } = pkg;
const app = express();
const PORT = process.env.PORT || 10000;

/* =====================================================
   DATABASE CONNECTION
===================================================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =====================================================
   MIDDLEWARE
===================================================== */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

/* =====================================================
   ROOT
===================================================== */
app.get("/", (req, res) => {
  res.redirect("/login.html");
});

/* =====================================================
   SESSION VALIDATION (15 MIN EXPIRY)
===================================================== */
async function validateSession(req, res, next) {
  try {
    const sessionId = req.headers.sessionid;

    if (!sessionId) {
      return res.status(401).json({ error: "No session" });
    }

    const result = await pool.query(
      `SELECT * FROM sfdc_contacts 
       WHERE session_id = $1 
       AND session_expiry > NOW()`,
      [sessionId]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ error: "Session expired" });
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    console.error("Session Validation Error:", err);
    res.status(500).json({ error: "Session validation failed" });
  }
}

/* =====================================================
   SALESFORCE TOKEN (24H CACHE IN DB)
===================================================== */
async function getSalesforceToken() {
  try {
    // Check existing token (stored against Admin)
    const existing = await pool.query(
      `SELECT sfdc_token, token_fetched_at 
       FROM sfdc_contacts 
       WHERE role='Admin' LIMIT 1`
    );

    if (existing.rowCount > 0) {
      const token = existing.rows[0].sfdc_token;
      const fetchedAt = existing.rows[0].token_fetched_at;

      if (token && fetchedAt) {
        const diffHours =
          (new Date() - new Date(fetchedAt)) / (1000 * 60 * 60);

        if (diffHours < 24) {
          console.log("Using cached Salesforce token");
          return token;
        }
      }
    }

    console.log("Fetching NEW Salesforce token...");

    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SF_CLIENT_ID,
      client_secret: process.env.SF_CLIENT_SECRET
    });

    const response = await fetch(process.env.SF_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params
    });

    const data = await response.json();

    if (!data.access_token) {
      throw new Error(
        "Salesforce Token Error: " + JSON.stringify(data)
      );
    }

    // Store token in DB
    await pool.query(
      `UPDATE sfdc_contacts 
       SET sfdc_token=$1, token_fetched_at=NOW() 
       WHERE role='Admin'`,
      [data.access_token]
    );

    return data.access_token;
  } catch (err) {
    console.error("Salesforce Token Error:", err.message);
    throw err;
  }
}

/* =====================================================
   LOGIN (ADMIN + SALES)
===================================================== */
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    // ADMIN LOGIN
    if (username === "admin" && password === "admin") {
      const sessionId = uuidv4();

      await pool.query(
        `UPDATE sfdc_contacts 
         SET session_id=$1, 
             session_expiry=NOW() + INTERVAL '15 minutes'
         WHERE role='Admin'`,
        [sessionId]
      );

      return res.json({
        success: true,
        role: "Admin",
        sessionId
      });
    }

    // SALES LOGIN
    const user = await pool.query(
      `SELECT * FROM sfdc_contacts 
       WHERE username=$1 
       AND contact_password=$2 
       AND status='Active'`,
      [username, password]
    );

    if (user.rowCount === 0) {
      return res.json({ success: false });
    }

    const sessionId = uuidv4();

    await pool.query(
      `UPDATE sfdc_contacts 
       SET session_id=$1, 
           session_expiry=NOW() + INTERVAL '15 minutes'
       WHERE salesforce_id=$2`,
      [sessionId, user.rows[0].salesforce_id]
    );

    res.json({
      success: true,
      role: "Sales",
      sessionId
    });
  } catch (err) {
    console.error("Login Error:", err);
    res.status(500).json({ success: false });
  }
});

/* =====================================================
   GET USERS (ADMIN PANEL - NO ADMIN ROWS)
===================================================== */
app.get("/api/users", validateSession, async (req, res) => {
  try {
    const users = await pool.query(
      `SELECT salesforce_id, firstname, lastname,
              emailid, phone, status
       FROM sfdc_contacts
       WHERE role='Sales'
       ORDER BY firstname ASC`
    );

    res.json(users.rows);
  } catch (err) {
    console.error("Fetch Users Error:", err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

/* =====================================================
   SALESFORCE SYNC (WITH PROGRESS SAFE HANDLING)
===================================================== */
app.post("/api/sync", validateSession, async (req, res) => {
  try {
    console.log("Sync Started...");

    const token = await getSalesforceToken();

    const soql = `
      SELECT Id, FirstName, LastName, Email, Phone, Sync__c
      FROM Contact
      WHERE Sync__c = true
    `;

    const sfResponse = await fetch(
      `https://capsule2.my.salesforce.com/services/data/v59.0/query?q=${encodeURIComponent(
        soql
      )}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    const sfData = await sfResponse.json();

    if (!sfData.records) {
      throw new Error("Invalid Salesforce response");
    }

    let inserted = 0;

    for (const c of sfData.records) {
      const result = await pool.query(
        `INSERT INTO sfdc_contacts
        (salesforce_id, firstname, lastname, emailid, username, phone, role, status)
        VALUES ($1,$2,$3,$4,$4,$5,'Sales','Inactive')
        ON CONFLICT (salesforce_id) DO NOTHING`,
        [c.Id, c.FirstName, c.LastName, c.Email, c.Phone]
      );

      if (result.rowCount > 0) inserted++;
    }

    res.json({
      success: true,
      message: "Sync completed successfully",
      totalFetched: sfData.records.length,
      inserted
    });
  } catch (err) {
    console.error("SYNC ERROR:", err.message);
    res.status(500).json({
      success: false,
      message: "Salesforce Sync Failed",
      error: err.message
    });
  }
});

/* =====================================================
   ACTIVATE / DEACTIVATE USER
===================================================== */
app.post("/api/status", validateSession, async (req, res) => {
  try {
    const { id, status } = req.body;

    await pool.query(
      `UPDATE sfdc_contacts SET status=$1 WHERE salesforce_id=$2`,
      [status, id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Status Update Error:", err);
    res.status(500).json({ error: "Status update failed" });
  }
});

/* =====================================================
   RESET PASSWORD
===================================================== */
app.post("/api/password", validateSession, async (req, res) => {
  try {
    const { id, password } = req.body;

    await pool.query(
      `UPDATE sfdc_contacts 
       SET contact_password=$1 
       WHERE salesforce_id=$2`,
      [password, id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Password Update Error:", err);
    res.status(500).json({ error: "Password update failed" });
  }
});

/* =====================================================
   LOGOUT
===================================================== */
app.post("/api/logout", validateSession, async (req, res) => {
  try {
    await pool.query(
      `UPDATE sfdc_contacts 
       SET session_id=NULL, session_expiry=NULL 
       WHERE session_id=$1`,
      [req.headers.sessionid]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Logout Error:", err);
    res.status(500).json({ error: "Logout failed" });
  }
});

/* =====================================================
   HEALTH CHECK
===================================================== */
app.get("/health", (req, res) => {
  res.json({ status: "UP" });
});

/* =====================================================
   START SERVER
===================================================== */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
