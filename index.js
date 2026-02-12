import express from "express";
import pkg from "pg";
import { v4 as uuidv4 } from "uuid";

const { Pool } = pkg;
const app = express();
const PORT = process.env.PORT || 3000;

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
   SALESFORCE TOKEN LOGIC (DB STORED)
===================================================== */
async function getSalesforceSession() {

  // Check token stored for admin
  const tokenCheck = await pool.query(`
    SELECT sfdc_token, token_last_fetched
    FROM sfdc_contacts
    WHERE role = 'Admin'
    LIMIT 1
  `);

  if (tokenCheck.rowCount > 0) {
    const { sfdc_token, token_last_fetched } = tokenCheck.rows[0];

    if (sfdc_token && token_last_fetched) {

      const tokenAge = Date.now() - new Date(token_last_fetched).getTime();
      const twentyFourHours = 24 * 60 * 60 * 1000;

      if (tokenAge < twentyFourHours) {
        return {
          sfAccessToken: sfdc_token,
          sfInstanceUrl: "https://capsule2.my.salesforce.com"
        };
      }
    }
  }

  // Fetch new token
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

  // Store token in DB
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
   LOGIN
===================================================== */
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (username !== "admin" || password !== "admin") {
    return res.status(401).send("Invalid credentials");
  }

  const sessionId = uuidv4();

  await pool.query(`
    INSERT INTO sfdc_contacts
      (username, role, session_id, loggedin_at, active)
    VALUES ($1,'Admin',$2,CURRENT_TIMESTAMP,true)
    ON CONFLICT (username)
    DO UPDATE SET session_id = EXCLUDED.session_id,
                  loggedin_at = CURRENT_TIMESTAMP,
                  role='Admin'
  `, [username, sessionId]);

  res.redirect(`/home.html?sessionId=${sessionId}`);
});

/* =====================================================
   FETCH USERS
===================================================== */
app.get("/api/users", async (req, res) => {

  const users = await pool.query(`
    SELECT salesforce_id, emailid, username,
           firstname, lastname, phone,
           role, active
    FROM sfdc_contacts
    ORDER BY created_at DESC
  `);

  res.json(users.rows);
});

/* =====================================================
   SYNC CONTACTS
===================================================== */
app.post("/api/sync-salesforce", async (req, res) => {

  const { sfAccessToken, sfInstanceUrl } =
    await getSalesforceSession();

  const soql = `
    SELECT Id, FirstName, LastName, Email, Phone, Sync__c
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

  for (const c of records) {

    const result = await pool.query(`
      INSERT INTO sfdc_contacts
        (salesforce_id, firstname, lastname,
         emailid, phone, role, active)
      VALUES ($1,$2,$3,$4,$5,'Sales',true)
      ON CONFLICT (salesforce_id)
      DO UPDATE SET
        firstname=$2,
        lastname=$3,
        emailid=$4,
        phone=$5
    `, [c.Id, c.FirstName, c.LastName, c.Email, c.Phone]);

    inserted++;
  }

  res.json({
    success: true,
    contactsFetched: records.length,
    inserted
  });
});

/* =====================================================
   UPDATE CONTACT
===================================================== */
app.post("/api/update-contact", async (req, res) => {

  const { salesforce_id, firstname, lastname, emailid, phone } = req.body;

  const { sfAccessToken, sfInstanceUrl } =
    await getSalesforceSession();

  // Update Salesforce
  await fetch(
    `${sfInstanceUrl}/services/data/v59.0/sobjects/Contact/${salesforce_id}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${sfAccessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        FirstName: firstname,
        LastName: lastname,
        Email: emailid,
        Phone: phone
      })
    }
  );

  // Update Postgres
  await pool.query(`
    UPDATE sfdc_contacts
    SET firstname=$1,
        lastname=$2,
        emailid=$3,
        phone=$4
    WHERE salesforce_id=$5
  `, [firstname, lastname, emailid, phone, salesforce_id]);

  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
