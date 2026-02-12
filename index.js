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
   SALESFORCE TOKEN (24 Hour Stored)
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
      const age = Date.now() - new Date(token_last_fetched).getTime();
      if (age < 24 * 60 * 60 * 1000) {
        return {
          sfAccessToken: sfdc_token,
          sfInstanceUrl: "https://capsule2.my.salesforce.com"
        };
      }
    }
  }

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

  await pool.query(`
    UPDATE sfdc_contacts
    SET sfdc_token=$1,
        token_last_fetched=CURRENT_TIMESTAMP
    WHERE role='Admin'
  `,[data.access_token]);

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

  // Admin
  if (username === "admin" && password === "admin") {
    return res.redirect("/home.html");
  }

  // Sales
  const user = await pool.query(`
    SELECT * FROM sfdc_contacts
    WHERE emailid=$1
      AND contact_password=$2
      AND role='Sales'
      AND status='Active'
  `,[username,password]);

  if(user.rowCount === 0){
    return res.status(401).send("Invalid credentials or inactive account");
  }

  res.redirect(`/dashboard.html?id=${user.rows[0].salesforce_id}`);
});

/* =====================================================
   SYNC CONTACTS (Default Inactive)
===================================================== */
app.post("/api/sync", async (req,res)=>{

  const { sfAccessToken, sfInstanceUrl } =
    await getSalesforceSession();

  const soql = `
    SELECT Id, FirstName, LastName, Email, Phone
    FROM Contact
    WHERE Sync__c = true
  `;

  const sfResponse = await fetch(
    `${sfInstanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`,
    { headers:{ Authorization:`Bearer ${sfAccessToken}` } }
  );

  const sfData = await sfResponse.json();
  const records = sfData.records || [];

  for(const c of records){
    await pool.query(`
      INSERT INTO sfdc_contacts
      (salesforce_id, firstname, lastname,
       emailid, phone, role, status)
      VALUES ($1,$2,$3,$4,$5,'Sales','Inactive')
      ON CONFLICT (salesforce_id)
      DO UPDATE SET
        firstname=$2,
        lastname=$3,
        emailid=$4,
        phone=$5
    `,[c.Id,c.FirstName,c.LastName,c.Email,c.Phone]);
  }

  res.json({success:true,count:records.length});
});

/* =====================================================
   GET SALES USERS (NO ADMIN)
===================================================== */
app.get("/api/users", async (req,res)=>{

  const users = await pool.query(`
    SELECT salesforce_id, firstname, lastname,
           emailid, phone, status
    FROM sfdc_contacts
    WHERE role='Sales'
    ORDER BY created_at DESC
  `);

  res.json(users.rows);
});

/* =====================================================
   ACTIVATE / DEACTIVATE
===================================================== */
app.post("/api/status", async (req,res)=>{

  const { id,status } = req.body;

  await pool.query(`
    UPDATE sfdc_contacts
    SET status=$1
    WHERE salesforce_id=$2
  `,[status,id]);

  res.json({success:true});
});

/* =====================================================
   RESET PASSWORD
===================================================== */
app.post("/api/password", async (req,res)=>{

  const { id,password } = req.body;

  await pool.query(`
    UPDATE sfdc_contacts
    SET contact_password=$1
    WHERE salesforce_id=$2
  `,[password,id]);

  res.json({success:true});
});

/* =====================================================
   PROFILE
===================================================== */
app.get("/api/profile/:id", async (req,res)=>{

  const user = await pool.query(`
    SELECT firstname, lastname,
           emailid, phone, status
    FROM sfdc_contacts
    WHERE salesforce_id=$1
  `,[req.params.id]);

  res.json(user.rows[0]);
});

app.listen(PORT, ()=>{
  console.log(`Server running on port ${PORT}`);
});
