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
      const twentyFourHours = 24 * 60 * 60 * 1000;

      if (age < twentyFourHours) {
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

  const response = await fetch(
    process.env.SF_AUTH_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params
    }
  );

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
   LOGIN (ADMIN + SALES)
===================================================== */
app.post("/login", async (req, res) => {

  const { username, password } = req.body;

  // Admin login
  if (username === "admin" && password === "admin") {

    const sessionId = uuidv4();

    await pool.query(`
      INSERT INTO sfdc_contacts
      (username, role, session_id, loggedin_at, active)
      VALUES ($1,'Admin',$2,CURRENT_TIMESTAMP,true)
      ON CONFLICT (username)
      DO UPDATE SET session_id=$2,
                    loggedin_at=CURRENT_TIMESTAMP
    `,[username, sessionId]);

    return res.redirect(`/home.html?sessionId=${sessionId}`);
  }

  // Sales login
  const user = await pool.query(`
    SELECT * FROM sfdc_contacts
    WHERE emailid=$1
      AND contact_password=$2
      AND role='Sales'
      AND status='Active'
  `,[username,password]);

  if(user.rowCount === 0){
    return res.status(401).send("Invalid credentials or Inactive account");
  }

  return res.redirect(`/dashboard.html?salesforce_id=${user.rows[0].salesforce_id}`);
});

/* =====================================================
   FETCH USERS (ADMIN PANEL)
===================================================== */
app.get("/api/users", async (req, res) => {

  const users = await pool.query(`
    SELECT salesforce_id, firstname, lastname,
           emailid, phone, role, status
    FROM sfdc_contacts
    ORDER BY created_at DESC
  `);

  res.json(users.rows);
});

/* =====================================================
   SET / RESET PASSWORD
===================================================== */
app.post("/api/set-password", async (req,res)=>{

  const { salesforce_id, new_password } = req.body;

  await pool.query(`
    UPDATE sfdc_contacts
    SET contact_password=$1
    WHERE salesforce_id=$2
  `,[new_password, salesforce_id]);

  res.json({success:true});
});

/* =====================================================
   ACTIVATE / DEACTIVATE
===================================================== */
app.post("/api/toggle-status", async (req,res)=>{

  const { salesforce_id, status } = req.body;

  await pool.query(`
    UPDATE sfdc_contacts
    SET status=$1
    WHERE salesforce_id=$2
  `,[status, salesforce_id]);

  res.json({success:true});
});

/* =====================================================
   PROFILE (SALES DASHBOARD)
===================================================== */
app.get("/api/profile/:id", async (req,res)=>{

  const user = await pool.query(`
    SELECT firstname, lastname, emailid, phone, status
    FROM sfdc_contacts
    WHERE salesforce_id=$1
  `,[req.params.id]);

  res.json(user.rows[0]);
});

app.listen(PORT, ()=>{
  console.log(`Server running on port ${PORT}`);
});
