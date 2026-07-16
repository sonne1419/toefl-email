// functions/upload-to-drive.js
// Uploads files to Google Drive using only built-in Node.js modules.
// No npm dependencies required.

const https  = require("https");
const crypto = require("crypto");

const ROOT_FOLDER_ID  = "0AI6u38BRaU6NUk9PVA";
const SHARED_DRIVE_ID = "0AI6u38BRaU6NUk9PVA";

function b64url(str) {
  return Buffer.from(str).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function makeJWT(credentials) {
  const now     = Math.floor(Date.now() / 1000);
  const header  = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss:   credentials.client_email,
    scope: "https://www.googleapis.com/auth/drive.file",
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

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "POST", headers }, (res) => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "GET", headers }, (res) => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function getAccessToken(credentials) {
  const jwt  = makeJWT(credentials);
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const res  = await httpsPost("oauth2.googleapis.com", "/token",
    { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    body
  );
  const data = JSON.parse(res.body);
  if (!data.access_token) throw new Error("Auth failed: " + res.body);
  return data.access_token;
}

async function findFolder(token, name, parentId) {
  const safe  = name.replace(/'/g, "\\'");
  const query = encodeURIComponent(
    `name='${safe}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
  );
  const path  = `/drive/v3/files?q=${query}&driveId=${SHARED_DRIVE_ID}&corpora=drive&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=files(id)`;
  const res   = await httpsGet("www.googleapis.com", path, { Authorization: `Bearer ${token}` });
  const data  = JSON.parse(res.body);
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

async function createFolder(token, name, parentId) {
  const meta = JSON.stringify({
    name,
    mimeType: "application/vnd.google-apps.folder",
    parents:  [parentId]
  });
  const res  = await httpsPost("www.googleapis.com",
    "/drive/v3/files?supportsAllDrives=true&fields=id",
    { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(meta) },
    meta
  );
  const data = JSON.parse(res.body);
  if (!data.id) throw new Error("Folder creation failed: " + res.body);
  return data.id;
}

async function findOrCreateFolder(token, name, parentId) {
  const existing = await findFolder(token, name, parentId);
  return existing || createFolder(token, name, parentId);
}

async function uploadFile(token, filename, content, mimeType, parentId, isBase64, convertToDoc) {
  // Detect binary files by MIME type — don't rely solely on isBase64 flag
  const isTextMime = !mimeType ||
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/javascript";
  const useBase64 = isBase64 || !isTextMime;
  const fileBuffer = useBase64
    ? Buffer.from(content, "base64")
    : Buffer.from(content, "utf8");

  // When convertToDoc is set, tell Drive to convert the uploaded HTML into a
  // native Google Doc (so the link opens a rendered Doc, not raw HTML source).
  const metaObj = { name: filename, parents: [parentId] };
  if (convertToDoc) metaObj.mimeType = "application/vnd.google-apps.document";
  const meta      = JSON.stringify(metaObj);
  const boundary  = "boundary_" + Date.now();
  const delimiter = `\r\n--${boundary}\r\n`;
  const closing   = `\r\n--${boundary}--`;

  const body = Buffer.concat([
    Buffer.from(delimiter + "Content-Type: application/json; charset=UTF-8\r\n\r\n" + meta),
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    fileBuffer,
    Buffer.from(closing)
  ]);

  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "www.googleapis.com",
      path:     "/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink",
      method:   "POST",
      headers:  {
        Authorization:    `Bearer ${token}`,
        "Content-Type":   `multipart/related; boundary=${boundary}`,
        "Content-Length": body.length
      }
    }, (res) => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  const data = JSON.parse(res.body);
  if (!data.id) throw new Error("Upload failed: " + res.body);
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST")
    return { statusCode: 405, body: "Method Not Allowed" };

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) }; }

  const { filename, content, mimeType = "text/plain", studentKey, isBase64 = false, convertToDoc = false } = body;
  if (!filename || !content)
    return { statusCode: 400, body: JSON.stringify({ error: "filename and content required" }) };

  try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const token       = await getAccessToken(credentials);

    let parentId = ROOT_FOLDER_ID;
    if (studentKey) {
      const studentFolder = await findOrCreateFolder(token, studentKey, ROOT_FOLDER_ID);
      // Organize all email-tool files under 03_writing_email inside the student's folder
      parentId = await findOrCreateFolder(token, "03_writing_email", studentFolder);
    }

    const uploaded = await uploadFile(token, filename, content, mimeType, parentId, isBase64, convertToDoc);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, fileId: uploaded.id, name: uploaded.name, link: uploaded.webViewLink })
    };
  } catch(e) {
    console.error("Drive upload error:", e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
