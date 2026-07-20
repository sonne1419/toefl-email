// functions/api.js — Email Writing Tool
// Key validation + serves /practice/email/*.json from CDN

const https = require("https");
const http  = require("http");

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchURL(res.headers.location).then(resolve).catch(reject);
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

function parseCSV(text) {
  const lines = text.trim().split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map(line => {
    const values = line.split(",").map(v => v.trim().replace(/^"|"$/g, ""));
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] || ""; });
    return obj;
  });
}

function isExpired(activatedAt, durationDays) {
  if (!activatedAt || !durationDays) return false;
  const start    = new Date(activatedAt);
  const duration = parseInt(durationDays);
  if (isNaN(start.getTime()) || isNaN(duration)) return false;
  const expiry = new Date(start.getTime() + duration * 24 * 60 * 60 * 1000);
  return new Date() > expiry;
}

async function validateKey(key) {
  const csvUrl = process.env.KEYS_CSV_URL;
  if (!csvUrl) return { valid: false, error: "KEYS_CSV_URL not configured" };
  let csvText;
  try { csvText = await fetchURL(csvUrl); }
  catch(e) { return { valid: false, error: "Could not reach key database." }; }
  const rows = parseCSV(csvText);
  const row  = rows.find(r => r.key && r.key.trim().toLowerCase() === key.trim().toLowerCase());
  if (!row) return { valid: false, error: "Invalid access key." };
  if (row.status && row.status.trim().toLowerCase() !== "active")
    return { valid: false, error: "This key is no longer active." };
  if (isExpired(row.activatedAt, row.durationDays))
    return { valid: false, error: "This key has expired." };
  return { valid: true };
}

function getSiteUrl(event) {
  let proto   = (event.headers && (event.headers["x-forwarded-proto"] || event.headers["X-Forwarded-Proto"])) || "https";
  const host  = (event.headers && (event.headers["host"] || event.headers["Host"])) || "";
  // Local dev (netlify dev) serves over http, but x-forwarded-proto may say https → force http for localhost
  if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) proto = "http";
  return host ? `${proto}://${host}` : (process.env.DEPLOY_URL || process.env.URL || "");
}

async function fetchJSON(url) {
  try { return JSON.parse(await fetchURL(url)); } catch(e) { return null; }
}

async function fetchEmailSetsIndex(siteUrl) {
  if (siteUrl) {
    const result = await fetchJSON(siteUrl + "/practice/email/sets/index.json");
    if (result) return result;
  }
  return [];
}

async function fetchEmailStage0Index(siteUrl) {
  if (siteUrl) {
    const result = await fetchJSON(siteUrl + "/practice/email/stage0/index.json");
    if (result) return result;
  }
  return [];
}

async function fetchEmailFile(subdir, file, siteUrl) {
  if (!siteUrl) { console.error("[api] fetchEmailFile: no siteUrl"); return null; }
  const url = `${siteUrl}/practice/email/${subdir}/${file}`;
  try {
    return await fetchURL(url);
  } catch (e) {
    // Logged, not swallowed: a silent null here surfaces to the student as
    // "Could not load question." with no clue whether the file is missing, the
    // URL is wrong, or the request failed.
    console.error("[api] fetchEmailFile failed:", url, "-", e.message);
    return null;
  }
}

async function fetchEmailRootFile(file, siteUrl) {
  if (!siteUrl) { console.error("[api] fetchEmailRootFile: no siteUrl"); return null; }
  const url = `${siteUrl}/practice/email/${file}`;
  try {
    return await fetchURL(url);
  } catch (e) {
    console.error("[api] fetchEmailRootFile failed:", url, "-", e.message);
    return null;
  }
}

const JSON_HEADERS = {
  "Content-Type":  "application/json",
  "Cache-Control": "no-cache, no-store, must-revalidate"
};

exports.handler = async (event) => {
  const method = event.httpMethod;

  // POST — key validation
  if (method === "POST") {
    let body;
    try { body = JSON.parse(event.body); } catch(e) {
      return { statusCode: 400, body: JSON.stringify({ valid: false, error: "Invalid request" }) };
    }
    const result = await validateKey(body.key || "");
    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(result) };
  }

  // GET — data serving
  if (method === "GET") {
    const params  = event.queryStringParameters || {};
    const key     = params.key || "";
    const op      = params.op  || "";
    const siteUrl = getSiteUrl(event);

    const auth = await validateKey(key);
    if (!auth.valid)
      return { statusCode: 403, body: JSON.stringify({ error: auth.error }) };

    // List stage 1–5 questions
    if (op === "list_email_sets") {
      const index = await fetchEmailSetsIndex(siteUrl);
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(index) };
    }

    // List stage 0 questions (independent set)
    if (op === "list_email_stage0") {
      const index = await fetchEmailStage0Index(siteUrl);
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(index) };
    }

    // Serve a stage 1–5 question file
    if (op === "get_email_sets" && params.file) {
      const basename = params.file.replace(/[^a-zA-Z0-9_.\-]/g, "");
      const raw = await fetchEmailFile("sets", basename, siteUrl);
      if (!raw) return { statusCode: 404, body: JSON.stringify({
        error: "Question not found", file: basename, tried: `${siteUrl}/practice/email/sets/${basename}` }) };
      return { statusCode: 200, headers: JSON_HEADERS, body: raw };
    }

    // Serve a stage 0 question file
    if (op === "get_email_stage0" && params.file) {
      const basename = params.file.replace(/[^a-zA-Z0-9_.\-]/g, "");
      const raw = await fetchEmailFile("stage0", basename, siteUrl);
      if (!raw) return { statusCode: 404, body: JSON.stringify({ error: "Stage 0 question not found" }) };
      return { statusCode: 200, headers: JSON_HEADERS, body: raw };
    }

    // Serve bullet type lookup table
    if (op === "get_bullet_types") {
      const raw = await fetchEmailRootFile("bullet_types.json", siteUrl);
      if (!raw) return { statusCode: 404, body: JSON.stringify({ error: "bullet_types.json not found" }) };
      return { statusCode: 200, headers: JSON_HEADERS, body: raw };
    }

    return { statusCode: 400, body: JSON.stringify({ error: "Invalid operation" }) };
  }

  return { statusCode: 405, body: "Method Not Allowed" };
};
