import express from "express";
import pkg from "pg";
import { v4 as uuidv4 } from "uuid";

const { Pool } = pkg;
const app = express();
const PORT = process.env.PORT || 10000;

/* ================= DATABASE ================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ================= MIDDLEWARE ================= */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

/* ================= ROOT ================= */
app.get("/", (req, res) => {
  res.redirect("/login.html");
});

/* ================= SESSION VALIDATION (15 MIN) ================= */
async function validateSession(req, res, next) {
  try {
    const sessionId = req.headers.sessionid;

    if (!sessionId) {
      return res.status(401).json({ error: "No sessionId provided" });
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
    console.error("Session validation error:", err);
    res.status(500).json({ error: "Session validation failed" });
  }
}

/* ================= SALESFORCE TOKEN (CLIENT CREDENTIALS) ================= */
async function getSalesforceToken() {
  try {
    if (!process.env.SF_AUTH_URL) {
      throw new Error("SF_AUTH_URL is not set in Render ENV");
    }

    console.log("🔄 Fetching NEW Salesforce Access Token...");

    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SF_CLIENT_ID,
      client_secret: process.env.SF_CLIENT_SECRET
    });

    const response = await fetch(process.env.SF_AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });

    const data = await response.json();
    console.log("🔐 Salesforce Token Response:", data);

    if (!data.access_token) {
      throw new Error("Access token not received: " + JSON.stringify(data));
    }

    return {
      accessToken: data.access_token,
      instanceUrl: process.env.SF_INSTANCE_URL
    };
  } catch (err) {
    console.error("❌ Salesforce Token Error:", err.message);
    throw err;
  }
}

/* ================= LOGIN (ADMIN + SALES) ================= */
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
      return res.json({ success: false, message: "Invalid credentials" });
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
    console.error("Login error:", err);
    res.status(500).json({ success: false });
  }
});

/* ================= FETCH USERS (ADMIN PANEL) ================= */
app.get("/api/users", validateSession, async (req, res) => {
  try {
    const users = await pool.query(
      `SELECT salesforce_id, firstname, lastname, 
              emailid, phone, status
       FROM sfdc_contacts
       WHERE role='Sales'
       ORDER BY created_at DESC`
    );

    res.json(users.rows);
  } catch (err) {
    console.error("Fetch users error:", err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

/* ================= SALESFORCE SYNC (FIXED + PROGRESS SAFE) ================= */
app.post("/api/sync", validateSession, async (req, res) => {
  try {
    console.log("🚀 Sync Started...");

    // Step 1: Get Token
    const { accessToken, instanceUrl } = await getSalesforceToken();
    console.log("✅ Salesforce Auth Success");

    // Step 2: Query Salesforce Contacts
    const soql = `
      SELECT Id, FirstName, LastName, Email, Phone, Sync__c
      FROM Contact
      WHERE Sync__c = true
    `;

    const queryUrl = `${instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`;
    console.log("📡 Fetching Contacts from Salesforce...");

    const sfResponse = await fetch(queryUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const sfData = await sfResponse.json();

    if (!sfData.records) {
      throw new Error("Invalid Salesforce response: " + JSON.stringify(sfData));
    }

    console.log(`📊 Contacts Fetched: ${sfData.records.length}`);

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

    console.log(`💾 Rows Inserted in Postgres: ${inserted}`);

    res.json({
      success: true,
      message: "Salesforce Sync Completed Successfully",
      fetched: sfData.records.length,
      inserted: inserted
    });

  } catch (err) {
    console.error("❌ SYNC ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Salesforce Sync Failed",
      error: err.message
    });
  }
});

/* ================= STATUS UPDATE ================= */
app.post("/api/status", validateSession, async (req, res) => {
  const { id, status } = req.body;
  await pool.query(
    `UPDATE sfdc_contacts SET status=$1 WHERE salesforce_id=$2`,
    [status, id]
  );
  res.json({ success: true });
});

/* ================= PASSWORD RESET ================= */
app.post("/api/password", validateSession, async (req, res) => {
  const { id, password } = req.body;
  await pool.query(
    `UPDATE sfdc_contacts SET contact_password=$1 WHERE salesforce_id=$2`,
    [password, id]
  );
  res.json({ success: true });
});

/* ================= LOGOUT ================= */
app.post("/api/logout", validateSession, async (req, res) => {
  await pool.query(
    `UPDATE sfdc_contacts 
     SET session_id=NULL, session_expiry=NULL 
     WHERE session_id=$1`,
    [req.headers.sessionid]
  );
  res.json({ success: true });
});

/* ================= SERVER ================= */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
