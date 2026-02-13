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
  try {
    const sessionId = req.headers["sessionid"];

    if (!sessionId) {
      return res.status(401).json({ error: "No session provided" });
    }

    const result = await pool.query(
      `SELECT * FROM sfdc_contacts 
       WHERE session_id=$1 
       AND session_expiry > CURRENT_TIMESTAMP`,
      [sessionId]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ error: "Session expired" });
    }

    req.user = result.rows[0];
    next();

  } catch (err) {
    console.error("Session Validation Error:", err);
    return res.status(500).json({ error: "Session validation failed" });
  }
}

/* ================= SALESFORCE TOKEN FUNCTION (FIXED) ================= */
async function getSalesforceSession() {
  try {

    // Check cached token first (24 hours)
    const tokenRow = await pool.query(`
      SELECT sfdc_token, token_last_fetched
      FROM sfdc_contacts
      WHERE role='Admin'
      LIMIT 1
    `);

    if (tokenRow.rowCount > 0) {
      const { sfdc_token, token_last_fetched } = tokenRow.rows[0];

      if (sfdc_token && token_last_fetched) {
        const age = Date.now() - new Date(token_last_fetched).getTime();
        const hours24 = 24 * 60 * 60 * 1000;

        if (age < hours24) {
          console.log("Using Cached Salesforce Token");
          return {
            access_token: sfdc_token,
            instance_url: process.env.SF_INSTANCE_URL
          };
        }
      }
    }

    console.log("Fetching New Salesforce Token...");

    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SF_CLIENT_ID,
      client_secret: process.env.SF_CLIENT_SECRET
    });

    const response = await fetch(process.env.SF_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params
    });

    const data = await response.json();

    if (!data.access_token) {
      console.error("Salesforce Token Error:", data);
      throw new Error("Failed to get Salesforce token");
    }

    // Save token in DB (Admin row)
    await pool.query(`
      UPDATE sfdc_contacts
      SET sfdc_token=$1,
          token_last_fetched=NOW()
      WHERE role='Admin'
    `, [data.access_token]);

    console.log("New Salesforce Token Stored");

    return data;

  } catch (error) {
    console.error("Salesforce Auth Failure:", error.message);
    throw error;
  }
}

/* ================= LOGIN ================= */
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (username === "admin" && password === "admin") {
      const sessionId = uuidv4();

      await pool.query(`
        UPDATE sfdc_contacts
        SET session_id=$1,
            session_expiry=NOW() + INTERVAL '15 minutes'
        WHERE role='Admin'
      `, [sessionId]);

      return res.json({ success: true, role: "Admin", sessionId });
    }

    const user = await pool.query(`
      SELECT * FROM sfdc_contacts
      WHERE emailid=$1 AND contact_password=$2
        AND role='Sales' AND status='Active'
    `, [username, password]);

    if (user.rowCount === 0) {
      return res.status(401).json({ success: false, message: "Invalid login" });
    }

    const sessionId = uuidv4();

    await pool.query(`
      UPDATE sfdc_contacts
      SET session_id=$1,
          session_expiry=NOW() + INTERVAL '15 minutes'
      WHERE salesforce_id=$2
    `, [sessionId, user.rows[0].salesforce_id]);

    res.json({ success: true, role: "Sales", sessionId });

  } catch (err) {
    console.error("Login Error:", err);
    res.status(500).json({ success: false, message: "Login failed" });
  }
});

/* ================= SALESFORCE SYNC (CRASH-PROOF) ================= */
app.post("/api/sync", validateSession, async (req, res) => {

  if (req.user.role !== "Admin") {
    return res.status(403).json({ success: false, message: "Admin only" });
  }

  try {
    console.log("SYNC STARTED");

    const sfSession = await getSalesforceSession();
    const accessToken = sfSession.access_token;
    const instanceUrl = sfSession.instance_url || process.env.SF_INSTANCE_URL;

    console.log("Token Received, Fetching Contacts...");

    const soql = `
      SELECT Id, FirstName, LastName, Email, Phone, Sync__c
      FROM Contact
      WHERE Sync__c = true
    `;

    const sfResponse = await fetch(
      `${instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    const sfData = await sfResponse.json();

    if (!sfData.records) {
      console.error("SF Query Failed:", sfData);
      return res.status(500).json({
        success: false,
        message: "Salesforce query failed",
        details: sfData
      });
    }

    let saved = 0;

    for (const c of sfData.records) {
      await pool.query(`
        INSERT INTO sfdc_contacts
        (salesforce_id, firstname, lastname, emailid, username, phone, role, status)
        VALUES ($1,$2,$3,$4,$4,$5,'Sales','Inactive')
        ON CONFLICT (salesforce_id)
        DO UPDATE SET
          firstname=$2,
          lastname=$3,
          emailid=$4,
          username=$4,
          phone=$5
      `, [c.Id, c.FirstName, c.LastName, c.Email, c.Phone]);

      saved++;
    }

    console.log("SYNC COMPLETED:", saved);

    res.json({
      success: true,
      message: "Salesforce Sync Completed Successfully",
      totalFetched: sfData.records.length,
      totalSaved: saved
    });

  } catch (error) {
    console.error("SYNC CRASH ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Sync failed",
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
