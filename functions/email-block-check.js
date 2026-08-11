// functions/email-block-check.js
// Per-bullet DISCOURSE evaluator for Stage 4 (Email writing).
// Checks one bullet (Bullet 1 / Bullet 2 / Bullet 3) against:
//   - the email task (scenario + all three bullet points) for context
//   - the per-question SAMPLE for that bullet (benchmark for discourse moves)
// Does NOT check grammar/punctuation — that is handled separately by grammar.js.
// Opening and Closing are NOT checked here (grammar only).
//
// Input:  POST {
//            bullet_label,     // "Bullet 1" | "Bullet 2" | "Bullet 3"
//            bullet_type,      // e.g. "Problem", "Reason", "Request"
//            bullet_q,         // the specific instruction for this bullet
//            scenario,         // the full email task prompt (with all bullet points)
//            sample_block,     // the model sample shown next to this bullet
//            student_block,    // what the student wrote for this bullet
//            language
//          }
// Output: { feedback: string }

const https = require("https");

const BLOCK_SYSTEM = `You check ONE section of a student's email (e.g. "Bullet 1"). Do NOT check grammar, spelling, or punctuation.

You receive:
- THE TASK: the email scenario and what each task point requires (context).
- THIS SECTION: which section you are checking and the task point it must cover.
- THE SAMPLE: a model for this section, written for a DIFFERENT scenario. Use it ONLY to benchmark moves and syntax — NEVER for content. A different topic is fine and must never be flagged.
- THE STUDENT'S SECTION: what the student wrote.

For each check below, reason first, then decide. Every verdict must follow FROM its reasoning — never decide the verdict first and justify it afterwards.

1. on_topic: Does the student's section cover the task point it must address?
2. moves: Compare the number of discourse moves (distinct developing steps) in the student's section vs THE SAMPLE. "roughly_same" is normal; only report "less" when clearly and substantially fewer. Fewer details does not mean fewer moves.

Do NOT comment on sentence structure or syntactic variety — a separate check reports the sentence patterns used, and duplicating it here gives the student two verdicts on the same thing.

Output ONLY a JSON object, no markdown fences (reasoning FIRST in each verdict):
{"on_topic": {"reasoning": "one sentence, before deciding", "pass": true|false, "note": "empty if pass; briefly what is missing if fail"},
 "moves": {"reasoning": "one sentence, before deciding", "verdict": "more"|"less"|"roughly_same", "note": "brief reason"}}

Keep each field to one sentence. Do not output a band or score.`;

function callOpenAI(apiKey, systemPrompt, userContent) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userContent  }
      ],
      temperature: 0,
      max_tokens: 700,
      // Reasoning-first JSON schema — enforce it at the API level rather than
      // relying on the model to follow the "no markdown fences" instruction.
      response_format: { type: "json_object" }
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

  const {
    bullet_label,   // "Bullet 1" | "Bullet 2" | "Bullet 3"
    bullet_type,    // e.g. "Problem", "Reason", "Request"
    bullet_q,       // the specific instruction for this bullet
    scenario,       // full email task prompt (with all bullet points)
    sample_block,   // model sample for THIS bullet
    student_block,  // what the student wrote
    language
  } = body;

  if (!student_block || !student_block.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing student_block" }) };
  }

  const systemPrompt = (language && language.trim().toLowerCase() !== "english")
    ? BLOCK_SYSTEM + `\n\nWrite every "reasoning" and "note" value in ${language.trim()}, never in English. The ONLY things that stay in English are the JSON keys themselves (on_topic, moves, reasoning, pass, note, verdict) and the JSON literal values true/false/"more"/"less"/"roughly_same" — these are required for parsing.`
    : BLOCK_SYSTEM;

  // Build the user content
  let userContent = `THE TASK (for context):\n${scenario || "(not provided)"}\n`;
  userContent += `\nTHIS SECTION: ${bullet_label || "(section)"}`;
  if (bullet_type) userContent += ` (${bullet_type})`;
  userContent += `\nTask point it must cover: ${bullet_q || "(not provided)"}\n`;
  userContent += `\nTHE SAMPLE (a model for this section, written for a DIFFERENT scenario — benchmark for moves and syntax ONLY, never content):\n${sample_block || "(not provided)"}\n`;
  userContent += `\nTHE STUDENT'S SECTION:\n${student_block}`;

  try {
    const feedback = await callOpenAI(apiKey, systemPrompt, userContent);
    const clean = (feedback || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ feedback: clean })
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
