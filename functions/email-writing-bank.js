// functions/email-writing-bank.js
// Per-student "Email Writing Bank": a Google Spreadsheet inside the student's Drive
// folder (named by the first 3 chars of their key), storing one row per analysis
// upload: [serial, timestamp, link]. Used to show the learner their last few
// writings to review before starting a new session.
//
// Interface (matches the bas-wrongbank pattern):
//   POST { action: "write", studentKey, serial?, timestamp?, link }
//   POST { action: "read",  studentKey, limit? }   -> { items: [{serial,timestamp,link}, ...] }
//
// Reuses only built-in Node modules. Auth scope drive.file covers Drive + Sheets
// operations on files this service account creates.

const https  = require("https");
const crypto = require("crypto");

const ROOT_FOLDER_ID  = "0AI6u38BRaU6NUk9PVA";
const SHARED_DRIVE_ID = "0AI6u38BRaU6NUk9PVA";
const BANK_FILENAME   = "email_writing_bank";

function b64url(str) {
  return Buffer.from(str).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function makeJWT(credentials) {
  const now     = Math.floor(Date.now() / 1000);
  const header  = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss:   credentials.client_email,
    scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets",
    aud:   "https://oauth2.googleapis.com/token",
    exp:   now + 3600,
    iat:   now
  }));
  const unsigned  = `${header}.${payload}`;
  const signature = crypto.createSign("RSA-SHA256")
    .update(unsigned)
    .sign(credentials.private_key, "base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return `${unsigned}.${signature}`;
}

function httpsRequest(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, (res) => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken(credentials) {
  const jwt  = makeJWT(credentials);
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const res  = await httpsRequest("POST", "oauth2.googleapis.com", "/token",
    { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    body
  );
  const data = JSON.parse(res.body);
  if (!data.access_token) throw new Error("Auth failed: " + res.body);
  return data.access_token;
}

function authHeaders(token, extra) {
  return Object.assign({ Authorization: `Bearer ${token}` }, extra || {});
}

async function findFolder(token, name, parentId) {
  const safe  = name.replace(/'/g, "\\'");
  const query = encodeURIComponent(
    `name='${safe}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
  );
  const path  = `/drive/v3/files?q=${query}&driveId=${SHARED_DRIVE_ID}&corpora=drive&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=files(id)`;
  const res   = await httpsRequest("GET", "www.googleapis.com", path, authHeaders(token));
  const data  = JSON.parse(res.body);
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

async function createFolder(token, name, parentId) {
  const meta = JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] });
  const res  = await httpsRequest("POST", "www.googleapis.com",
    "/drive/v3/files?supportsAllDrives=true&fields=id",
    authHeaders(token, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(meta) }),
    meta
  );
  const data = JSON.parse(res.body);
  if (!data.id) throw new Error("Folder creation failed: " + res.body);
  return data.id;
}

async function findOrCreateFolder(token, name, parentId) {
  return (await findFolder(token, name, parentId)) || createFolder(token, name, parentId);
}

// Find the bank spreadsheet inside the student's folder
async function findSheet(token, name, parentId) {
  const safe  = name.replace(/'/g, "\\'");
  const query = encodeURIComponent(
    `name='${safe}' and mimeType='application/vnd.google-apps.spreadsheet' and '${parentId}' in parents and trashed=false`
  );
  const path  = `/drive/v3/files?q=${query}&driveId=${SHARED_DRIVE_ID}&corpora=drive&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=files(id)`;
  const res   = await httpsRequest("GET", "www.googleapis.com", path, authHeaders(token));
  const data  = JSON.parse(res.body);
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

// Create the bank spreadsheet via Drive (so it lands in the right folder), with a header row added after.
async function createSheet(token, name, parentId) {
  const meta = JSON.stringify({
    name,
    mimeType: "application/vnd.google-apps.spreadsheet",
    parents: [parentId]
  });
  const res  = await httpsRequest("POST", "www.googleapis.com",
    "/drive/v3/files?supportsAllDrives=true&fields=id",
    authHeaders(token, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(meta) }),
    meta
  );
  const data = JSON.parse(res.body);
  if (!data.id) throw new Error("Sheet creation failed: " + res.body);
  // Add header row
  await appendRow(token, data.id, ["serial", "timestamp", "link", "stage"]);
  return data.id;
}

async function findOrCreateSheet(token, name, parentId) {
  return (await findSheet(token, name, parentId)) || createSheet(token, name, parentId);
}

async function appendRow(token, spreadsheetId, row) {
  const body = JSON.stringify({ values: [row] });
  const path = `/v4/spreadsheets/${spreadsheetId}/values/Sheet1!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res  = await httpsRequest("POST", "sheets.googleapis.com", path,
    authHeaders(token, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }),
    body
  );
  if (res.status >= 300) throw new Error("Append failed: " + res.body);
  return true;
}

async function readRows(token, spreadsheetId) {
  const path = `/v4/spreadsheets/${spreadsheetId}/values/Sheet1!A1:D10000`;
  const res  = await httpsRequest("GET", "sheets.googleapis.com", path, authHeaders(token));
  if (res.status >= 300) throw new Error("Read failed: " + res.body);
  const data = JSON.parse(res.body);
  return data.values || [];
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST")
    return { statusCode: 405, body: "Method Not Allowed" };

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) }; }

  const { action, studentKey, serial, timestamp, link, limit } = body;
  if (!action || !studentKey)
    return { statusCode: 400, body: JSON.stringify({ error: "action and studentKey required" }) };

  try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const token       = await getAccessToken(credentials);

    const studentFolder = await findOrCreateFolder(token, studentKey, ROOT_FOLDER_ID);
    // Keep the bank alongside the analysis Docs, under 03_writing_email in the student's folder
    const folderId = await findOrCreateFolder(token, "03_writing_email", studentFolder);
    const sheetId  = await findOrCreateSheet(token, BANK_FILENAME, folderId);

    if (action === "write") {
      if (!link) return { statusCode: 400, body: JSON.stringify({ error: "link required for write" }) };
      const ts  = timestamp || new Date().toISOString();
      const ser = serial != null ? String(serial) : "";
      const stg = body.stage != null ? String(body.stage) : "";
      await appendRow(token, sheetId, [ser, ts, link, stg]);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ success: true })
      };
    }

    if (action === "read") {
      const rows = await readRows(token, sheetId);
      // Drop header row if present
      const dataRows = rows.filter((r, i) => !(i === 0 && (r[0] === "serial")));
      let items = dataRows
        .map(r => ({ serial: r[0] || "", timestamp: r[1] || "", link: r[2] || "", stage: r[3] || "" }))
        .filter(it => it.link);

      // Filter by stage if requested:
      // Stage 1 → return Stage 1 records only
      // Stage 4 or 5 → return Stage 4 and 5 records
      const reqStage = body.stage != null ? String(body.stage) : null;
      if (reqStage === "1") {
        items = items.filter(it => it.stage === "1");
      } else if (reqStage === "4" || reqStage === "5") {
        items = items.filter(it => it.stage === "4" || it.stage === "5");
      }

      const n = limit && limit > 0 ? limit : 3;
      const last = items.slice(-n).reverse(); // most recent first
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: last })
      };
    }

    return { statusCode: 400, body: JSON.stringify({ error: "Unknown action" }) };
  } catch(e) {
    console.error("email-writing-bank error:", e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
