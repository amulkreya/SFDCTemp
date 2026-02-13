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
   SESSION VALIDATION MIDDLEWARE
===================================================== */
async function validateSession(req, res, next) {

  const sessionId = req.headers["sessionid"];

  if (!sessionId) {
    return res.status(401).json({ error: "No session" });
  }

  const user = await pool.query(`
    SELECT * FROM sfdc_contacts
    WHERE session_id=$1
      AND session_expiry > CURRENT_TIMESTAMP
  `, [sessionId]);

  if (user.rowCount === 0) {
    return res.status(401).json({ error: "Session expired" });
  }

  req.user = user.rows[0];
  next();
}

/* =====================================================
   LOGIN (ADMIN + SALES)
===================================================== */
app.post("/login", async (req, res) => {

  const { username, password } = req.body;

  // ADMIN
  if (username === "admin" && password === "admin") {

    const sessionId = uuidv4();

    await pool.query(`
      UPDATE sfdc_contacts
      SET session_id=$1,
          session_expiry=NOW() + INTERVAL '15 minutes'
      WHERE role='Admin'
    `,[sessionId]);

    return res.json({ role:"Admin", sessionId });
  }

  // SALES
  const user = await pool.query(`
    SELECT * FROM sfdc_contacts
    WHERE emailid=$1
      AND contact_password=$2
      AND role='Sales'
      AND status='Active'
  `,[username,password]);

  if(user.rowCount===0){
    return res.status(401).json({error:"Invalid login"});
  }

  const sessionId = uuidv4();

  await pool.query(`
    UPDATE sfdc_contacts
    SET session_id=$1,
        session_expiry=NOW() + INTERVAL '15 minutes'
    WHERE salesforce_id=$2
  `,[sessionId,user.rows[0].salesforce_id]);

  res.json({
    role:"Sales",
    sessionId,
    id:user.rows[0].salesforce_id
  });
});

/* =====================================================
   LOGOUT
===================================================== */
app.post("/api/logout", async (req,res)=>{

  const sessionId = req.headers["sessionid"];

  await pool.query(`
    UPDATE sfdc_contacts
    SET session_id=NULL,
        session_expiry=NULL
    WHERE session_id=$1
  `,[sessionId]);

  res.json({success:true});
});

/* =====================================================
   SYNC (USERNAME = EMAIL)
===================================================== */
app.post("/api/sync", validateSession, async (req,res)=>{

  const soql = `
    SELECT Id, FirstName, LastName, Email, Phone
    FROM Contact
    WHERE Sync__c = true
  `;

  // For brevity assume token function exists
  const { sfAccessToken, sfInstanceUrl } =
    await getSalesforceSession();

  const sfResponse = await fetch(
    `${sfInstanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`,
    { headers:{Authorization:`Bearer ${sfAccessToken}`} }
  );

  const sfData = await sfResponse.json();

  for(const c of sfData.records){
    await pool.query(`
      INSERT INTO sfdc_contacts
      (salesforce_id, firstname, lastname,
       emailid, username, phone, role, status)
      VALUES ($1,$2,$3,$4,$4,$5,'Sales','Inactive')
      ON CONFLICT (salesforce_id)
      DO UPDATE SET
        firstname=$2,
        lastname=$3,
        emailid=$4,
        username=$4,
        phone=$5
    `,[c.Id,c.FirstName,c.LastName,c.Email,c.Phone]);
  }

  res.json({success:true});
});

/* =====================================================
   USERS (ADMIN)
===================================================== */
app.get("/api/users", validateSession, async (req,res)=>{

  const users = await pool.query(`
    SELECT salesforce_id, firstname, lastname,
           emailid, phone, status
    FROM sfdc_contacts
    WHERE role='Sales'
  `);

  res.json(users.rows);
});

/* =====================================================
   PROFILE (SALES)
===================================================== */
app.get("/api/profile", validateSession, async (req,res)=>{
  res.json({
    firstname:req.user.firstname,
    lastname:req.user.lastname,
    email:req.user.emailid,
    phone:req.user.phone,
    status:req.user.status
  });
});

app.listen(PORT, ()=>{
  console.log(`Server running on port ${PORT}`);
});
