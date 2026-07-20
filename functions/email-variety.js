// functions/email-variety.js
// Identifies which sentence patterns a student used in their email.
// Ported from the Academic Discussion tool's ad-variety.js.
//
// TWO THINGS THIS FILE DELIBERATELY DOES NOT DO
//
// 1. It does not elaborate the prompt. The whole prompt is a single line, the
//    student's text, and the pattern skeletons — nothing else. Earlier versions
//    demanded a "PATTERN: name | sentence | clause" output format and
//    post-processed the result; that produced repeated failures (whole sentences
//    highlighted, clauses lost, patterns misclassified). Every added instruction
//    skewed the output further. The plain prompt reasons correctly on its own.
//    Do not add "search carefully", an output format, or field structure here.
//
// 2. It does not parse the reply. The response is returned as-is in `raw` and
//    displayed as it comes back. The front end only translates the grammar TERMS
//    so they read the same everywhere.
//
// The pattern list is the fixed vocabulary shared with the drills stage and the
// student checklist. If these three ever diverge, a student is told they used
// something the drills never taught.
//
// Returns: { raw: string, patterns: string[] }

const https = require("https");

const MODEL = "gpt-4o";

// Target number of DIFFERENT patterns in one email.
const TARGET_DISTINCT = 3;

// The closed list. Kept in sync with the drills stage and the checklist.
const PATTERNS = [
  "Fronted subordinate clause",
  "Non-fronted subordinate clause",
  "Passive voice",
  "Indirect question",
  "Relative clause",
  "Participial phrase",
  "Fronted gerund phrase"
];

const PROMPT_HEADER = `analyze which grammar patterns are in the following text`;

// Sent after the text, exactly as tested by hand.
const PATTERN_LIST =
`Fronted subordinate clause  →  When ___, ___.  /  Although ___, ___.  /  Because ___, ___.
Non-fronted subordinate clause  →  ___ because ___.  /  ___ although ___.
Passive voice  →  ___ was/were [verb-ed].
Indirect question  →  learned how to ___  /  knew what ___  /  asked whether ___
Relative clause  →  the person who ___  /  the school that ___  /  ___, which ___
Participial phrase  →  ___, boosting ___  /  Having finished ___, ___
Fronted gerund phrase  →  By using ___, ___  /  After getting ___, ___`;

function callOpenAI(apiKey, prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,          // classification, not generation
      max_tokens: 500
    });
    const req = https.request({
      hostname: "api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const data = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let msg = data;
          try { const j = JSON.parse(data); if (j.error) msg = j.error.message; } catch (e) {}
          const err = new Error(`OpenAI ${res.statusCode}: ${msg}`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(json.error.message));
          else resolve(json.choices[0].message.content.trim());
        } catch (e) { reject(new Error("Failed to parse response: " + data.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// Which of the closed list the reply mentions. Used only for the "patterns you
// haven't used yet" hint — the reply itself is displayed verbatim, never rebuilt
// from this. Longest name first so "non-fronted subordinate clause" is not
// half-matched as "fronted subordinate clause".
function mentionedPatterns(raw) {
  const text = (raw || "").toLowerCase();
  const byLength = PATTERNS.slice().sort((a, b) => b.length - a.length);
  const found = [];
  const claimed = [];
  byLength.forEach(p => {
    const needle = p.toLowerCase();
    let from = 0, at;
    while ((at = text.indexOf(needle, from)) !== -1) {
      // Skip a span already claimed by a longer pattern name.
      const overlaps = claimed.some(([s, e]) => at < e && (at + needle.length) > s);
      if (!overlaps) {
        claimed.push([at, at + needle.length]);
        if (found.indexOf(p) === -1) found.push(p);
        break;
      }
      from = at + needle.length;
    }
  });
  return found;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const keys = [];
  for (const k of [process.env.ALT_OPENAI_KEY, process.env.OPENAI_API_KEY]) {
    const t = (k || "").trim();
    if (t && t.startsWith("sk-") && keys.indexOf(t) === -1) keys.push(t);
  }
  if (!keys.length) {
    return { statusCode: 500, body: JSON.stringify({ error: "No usable OpenAI API key set" }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: "Invalid request" }) }; }

  const answer = (body.answer || body.text || "").toString().trim();
  if (!answer) return { statusCode: 400, body: JSON.stringify({ error: "answer required" }) };

  const prompt = PROMPT_HEADER + "\n" + answer + "\n\n" + PATTERN_LIST;

  try {
    let raw, lastErr;
    for (const key of keys) {
      try { raw = await callOpenAI(key, prompt); lastErr = null; break; }
      catch (e) {
        lastErr = e;
        if (e.statusCode && e.statusCode !== 401 && e.statusCode !== 403) break;
      }
    }
    if (lastErr) throw lastErr;

    const mentioned = mentionedPatterns(raw);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        raw,                       // displayed as-is by the front end
        patterns: mentioned,
        distinct: mentioned.length,
        target:   TARGET_DISTINCT,
        all:      PATTERNS
      })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
