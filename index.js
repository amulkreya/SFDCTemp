import express from "express";
import pkg from "pg";
import { v4 as uuidv4 } from "uuid";

const { Pool } = pkg;
const app = express();
const PORT = process.env.PORT || 3000;

/* =====================================================
   DATABASE
===================================================== */
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

/* =====================================================
   SESSION VALIDATION (15 MIN)
===================================================== */
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

/* =====================================================
   SALESFORCE TOKEN (24 HOURS CACHE)
===================================================== */
async function getSalesforceSession() {

  const tokenCheck = await pool.query(`
    SELECT sfdc_token, token_last_fetched
    FROM sfdc_contacts
    WHERE role = 'Admin'
    LIMIT 1
  `);

  if (tokenCheck.rowCount > 0) {

    const { sfdc_token, token_last_fetched } = tokenCheck.rows[0];

    if (sfdc_token && token_last_fetched) {

      const tokenAge =
        Date.now() - new Date(token_last_fetched).getTime();

      const twentyFourHours = 24 * 60 * 60 * 1000;

      if (tokenAge < twentyFourHours) {
        return {
          sfAccessToken: sfdc_token,
          sfInstanceUrl: process.env.SF_INSTANCE_URL
        };
      }
    }
  }

  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.SF_CLIENT_ID,
    client_secret: process.env.SF_CLIENT_SECRET
  });

  const response = await fetch(
    process.env.SF_AUTH_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params
    }
  );

  const data = await response.json();

  if (!data.access_token) {
    throw new Error("Salesforce authentication failed");
  }

  await pool.query(`
    UPDATE sfdc_contacts
    SET sfdc_token = $1,
        token_last_fetched = CURRENT_TIMESTAMP
    WHERE role = 'Admin'
  `, [data.access_token]);

  return {
    sfAccessToken: data.access_token,
    sfInstanceUrl: data.instance_url
  };
}

/* =====================================================
   SYNC SALESFORCE
===================================================== */
app.post("/api/sync", validateSession, async (req, res) => {

  if (req.user.role !== "Admin") {
    return res.status(403).json({ error: "Only Admin allowed" });
  }

  try {

    const { sfAccessToken, sfInstanceUrl } =
      await getSalesforceSession();

    const soql = `
      SELECT Id, FirstName, LastName, Email, Phone
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

    if (!sfData.records) {
      return res.status(500).json({
        success: false,
        message: "Salesforce query failed",
        error: sfData
      });
    }

    const records = sfData.records;
    let inserted = 0;

    for (const c of records) {

      await pool.query(`
        INSERT INTO sfdc_contacts
        (salesforce_id, firstname, lastname,
         emailid, username, phone,
         role, status)
        VALUES ($1,$2,$3,$4,$4,$5,'Sales','Inactive')
        ON CONFLICT (salesforce_id)
        DO UPDATE SET
          firstname=$2,
          lastname=$3,
          emailid=$4,
          username=$4,
          phone=$5
      `, [
        c.Id,
        c.FirstName,
        c.LastName,
        c.Email,
        c.Phone
      ]);

      inserted++;
    }

    res.json({
      success: true,
      message: "Sync completed successfully",
      totalFetched: records.length,
      totalSaved: inserted
    });

  } catch (err) {
    console.error("Sync Error:", err);
    res.status(500).json({
      success: false,
      message: "Sync failed",
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
