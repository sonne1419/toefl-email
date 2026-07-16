// functions/email-total-check.js
// WHOLE-EMAIL total discourse-move count + total syntactic-variety comparison (Stage 4).
// Compares the student's ENTIRE email (all sections combined) against the fixed
// Band 5 model email — for TOTAL discourse moves and TOTAL syntactic variety only.
// Rationale: individual sections can each be fine, yet overlap in form/content so
// the email as a whole has fewer distinct moves / less variety than it should.
// Does NOT check on-topic, originality, or grammar (handled per-section elsewhere).
//
// Input:  POST { student_email, language }
// Output: { feedback: string }  — two lines: MOVES:, SYNTAX:

const https = require("https");

// The fixed Band 5 model email (same text as email-analyze.js Band 5 sample).
// Used ONLY as a quantity/variety benchmark — a different scenario is fine.
const BAND5_SAMPLE = `Hi Mr. Taylor,
I hope you are well. I would like to request assistance with repairing the Wi-Fi system at the co-working space.
When I connect to the network in the morning, the internet sometimes become extreamly slow.
This has really affected my progress at the office. As a result, my work as a software engineer has been significently affected, and many others have also expressed similar complains.
Would it be possible for you to arrange for a technician to check the system in the next few days? It would also be great if you could let me know when this issue might be resolved so that everyone can send files easily.
Thank you in advance for your response.
Best regards, Chen`;

const TOTAL_SYSTEM = `You compare a student's COMPLETE email against a MODEL email, for the WHOLE email only.
You do NOT check grammar, spelling, punctuation, on-topic, or content. A different topic is fine and must never be flagged — you are only comparing quantity and range.

You receive:
- THE MODEL: a complete, well-formed model email (a DIFFERENT scenario). Use it only as a benchmark for total discourse moves and total syntactic variety.
- THE STUDENT'S EMAIL: the student's complete email.

Output exactly these two lines, in this order:

MOVES: Compare the TOTAL number of distinct discourse moves across the WHOLE student email vs THE MODEL. A "move" is a distinct developing step; sections that overlap or repeat the same move count once. Verdict: MORE / LESS / ROUGHLY THE SAME, with a brief reason. ROUGHLY THE SAME is normal; say LESS only when the whole email clearly and substantially develops fewer distinct moves than the model.
SYNTAX: Compare the TOTAL range of sentence structures across the WHOLE student email vs THE MODEL. Verdict: MORE / LESS / ROUGHLY THE SAME, with a brief reason. ROUGHLY THE SAME is normal; say LESS only when the whole email clearly and substantially uses a narrower range than the model. No quotes, no construction names.

Keep each line to one sentence. Do not output a band or score. Keep the labels (MOVES:, SYNTAX:) and the words MORE / LESS / ROUGHLY THE SAME in English exactly as written.`;

function callOpenAI(apiKey, systemPrompt, userContent) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userContent  }
      ],
      temperature: 0,
      max_tokens: 400
    });
    const req = https.request(
      {
        hostname: "api.openai.com",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => {
          try {
          const data = Buffer.concat(chunks).toString("utf8");
            const json = JSON.parse(data);
            if (json.error) reject(new Error(json.error.message));
            else resolve(json.choices[0].message.content.trim());
          } catch(e) {
            reject(new Error("Failed to parse GPT response"));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKey = process.env.ALT_OPENAI_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "ALT_OPENAI_KEY not set" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request" }) };
  }

  const { student_email, language } = body;
  if (!student_email || !student_email.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing student_email" }) };
  }

  const systemPrompt = (language && language.trim().toLowerCase() !== "english")
    ? TOTAL_SYSTEM + `\n\nWrite all your explanations in ${language.trim()}, but keep the labels (MOVES:, SYNTAX:) and the words MORE / LESS / ROUGHLY THE SAME in English exactly as written — these are required for parsing.`
    : TOTAL_SYSTEM;

  const userContent =
    `THE MODEL (benchmark for total moves and total syntactic variety only — a DIFFERENT scenario):\n${BAND5_SAMPLE}\n\n` +
    `THE STUDENT'S EMAIL:\n${student_email}`;

  try {
    const feedback = await callOpenAI(apiKey, systemPrompt, userContent);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ feedback: (feedback || "").trim() })
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
