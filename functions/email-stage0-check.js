// functions/email-stage0-check.js
// Compares student's Stage 0 email writing to the model answer.
// Checks each part (opening, bullet1-3, closing) and the overall email.
// Returns per-part feedback + overall similarity rating.

const https = require("https");

const SYSTEM_PROMPT = `You are an English writing coach evaluating a student's attempt to reproduce a model email from memory.

The student was shown a model email, then asked to reproduce it from memory using structural cues only.

Evaluate the student's response against the model for each part provided.

For each part, assess:
1. Structural match — did they follow the same sentence pattern?
2. Syntactic similarity — are the grammatical structures similar?
3. Key language — did they use similar functional phrases (e.g. "I would like to", "Would it be possible")?

Do NOT penalize for different topic-specific words (different names, objects, places).
Do NOT comment on punctuation or capitalization.

Respond in this EXACT format:

OVERALL: High / Moderate / Low
WORDS: [student word count] / [model word count]

OPENING: [one sentence: what matched or differed]
BULLET 1: [one sentence: what matched or differed]
BULLET 2: [one sentence: what matched or differed]
BULLET 3: [one sentence: what matched or differed]
CLOSING: [one sentence: what matched or differed]

SUMMARY: [2 sentences max — key strength and key gap in structural reproduction]`;

function callOpenAI(userContent) {
  const apiKey = process.env.ALT_OPENAI_KEY || "";
  if (!apiKey) throw new Error("ALT_OPENAI_KEY not set.");

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "gpt-4o",
      temperature: 0.3,
      max_tokens: 400,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userContent   }
      ]
    });
    const req = https.request({
      hostname: "api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`
      }
    }, (res) => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        try {
          const data = Buffer.concat(chunks).toString("utf8");
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.choices?.[0]?.message?.content || "");
        } catch(e) { reject(new Error("Failed to parse OpenAI response")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST")
    return { statusCode: 405, body: "Method Not Allowed" };

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: "Invalid request" }) }; }

  const { parts } = body;
  // parts: { opening, bullet1, bullet2, bullet3, closing } each with { model, student }

  if (!parts)
    return { statusCode: 400, body: JSON.stringify({ error: "parts required" }) };

  const partNames = ["opening", "bullet1", "bullet2", "bullet3", "closing"];
  const lines = partNames.map(p => {
    const part = parts[p] || {};
    if (!part.model && !part.student) return null;
    return `${p.toUpperCase()}:\nModel:   ${part.model || "(empty)"}\nStudent: ${part.student || "(empty)"}`;
  }).filter(Boolean).join("\n\n");

  try {
    const feedback = await callOpenAI(lines);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ feedback })
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
