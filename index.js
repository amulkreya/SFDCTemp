import express from "express";
import pkg from "pg";
import { v4 as uuidv4 } from "uuid";

const { Pool } = pkg;
const app = express();
const PORT = process.env.PORT || 3000;

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
   SALESFORCE SESSION (CACHED)
===================================================== */
let sfAccessToken = null;
let sfInstanceUrl = null;

async function getSalesforceSession() {
  if (sfAccessToken && sfInstanceUrl) {
    return { sfAccessToken, sfInstanceUrl };
  }

  const params = new URLSearchParams({
    grant_type: "password",
    client_id: process.env.SF_CLIENT_ID,
    client_secret: process.env.SF_CLIENT_SECRET,
    username: process.env.SF_USERNAME,
    password: process.env.SF_PASSWORD
  });

  const response = await fetch(
    `${process.env.SF_LOGIN_URL}/services/oauth2/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params
    }
  );

  const data = await response.json();

  if (!data.access_token || !data.instance_url) {
    throw new Error("Salesforce authentication failed");
  }

  sfAccessToken = data.access_token;
  sfInstanceUrl = data.instance_url;

  return { sfAccessToken, sfInstanceUrl };
}

/* =====================================================
   LOGIN (ADMIN ONLY)
===================================================== */
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (username !== "admin" || password !== "admin") {
      return res.status(401).send("Invalid credentials");
    }

    const sessionId = uuidv4();

    await pool.query(
      `
      INSERT INTO sfdc_contacts
        (username, role, session_id, loggedin_at, active)
      VALUES
        ($1, 'Admin', $2, CURRENT_TIMESTAMP, true)
      ON CONFLICT (username)
      DO UPDATE SET
        session_id = EXCLUDED.session_id,
        loggedin_at = CURRENT_TIMESTAMP,
        role = 'Admin'
      `,
      [username, sessionId]
    );

    res.redirect(`/home.html?sessionId=${sessionId}`);
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).send("Login failed");
  }
});

/* =====================================================
   FETCH USERS (ADMIN AUTH)
===================================================== */
app.get("/api/users", async (req, res) => {
  const { sessionId } = req.query;

  const adminCheck = await pool.query(
    `
    SELECT 1
    FROM sfdc_contacts
    WHERE session_id = $1 AND role = 'Admin'
    `,
    [sessionId]
  );

  if (adminCheck.rowCount === 0) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const users = await pool.query(
    `
    SELECT
      salesforce_id,
      emailid,
      username,
      firstname,
      lastname,
      role,
      active
    FROM sfdc_contacts
    ORDER BY created_at DESC
    `
  );

  res.json(users.rows);
});

/* =====================================================
   SALESFORCE → POSTGRES SYNC (BUTTON)
===================================================== */
app.post("/api/sync-salesforce", async (req, res) => {
  try {
    const { sessionId } = req.body;

    /* ---- Admin Validation ---- */
    const adminCheck = await pool.query(
      `
      SELECT 1
      FROM sfdc_contacts
      WHERE session_id = $1 AND role = 'Admin'
      `,
      [sessionId]
    );

    if (adminCheck.rowCount === 0) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    /* ---- Salesforce Login ---- */
    const { sfAccessToken, sfInstanceUrl } =
      await getSalesforceSession();

    /* ---- Fetch Contacts ---- */
    const soql = `
      SELECT Id, FirstName, LastName, Email, Sync__c
      FROM Contact
      WHERE Sync__c = true
    `;

    const sfResponse = await fetch(
      `${sfInstanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`,
      {
        headers: {
          Authorization: `Bearer ${sfAccessToken}`
        }
      }
    );

    const sfData = await sfResponse.json();
    const records = sfData.records || [];

    let inserted = 0;

    /* ---- Insert into PostgreSQL ---- */
    for (const c of records) {
      const result = await pool.query(
        `
        INSERT INTO sfdc_contacts
          (salesforce_id, firstname, lastname, emailid, role, active)
        VALUES
          ($1, $2, $3, $4, 'Sales', true)
        ON CONFLICT (salesforce_id) DO NOTHING
        `,
        [c.Id, c.FirstName, c.LastName, c.Email]
      );

      if (result.rowCount > 0) inserted++;
    }

    /* ---- Response with Progress ---- */
    res.json({
      success: true,
      message: "Salesforce sync completed",
      steps: {
        salesforceConnection: "SUCCESS",
        contactsFetched: records.length,
        rowsInserted: inserted
      }
    });

  } catch (err) {
    console.error("Salesforce sync error:", err);
    res.status(500).json({
      success: false,
      message: "Salesforce sync failed",
      error: err.message
    });
  }
});

/* =====================================================
   HEALTH
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
