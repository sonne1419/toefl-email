// functions/email-why-not-5.js
// Explains how a student's email falls short of the Band 5 sample.
// Ported from the Academic Discussion tool's why-not-5.js.
//
// Does NOT assign, mention, or change a band — the grader (email-analyze.js) has
// already done that. This call only explains the gap, and is only worth making
// when the band is below 5 (the caller gates on that).
//
// The Band 5 sample answers a DIFFERENT scenario, so the prompt is explicit that
// the student must never be faulted for not covering the sample's topic. Only
// structure, development and language are compared.
//
// Input:  POST { question, answer, sample, band, language }
// Output: { explanation: string }

const https = require("https");

function callOpenAI(systemPrompt, userPrompt) {
  const apiKey = process.env.ALT_OPENAI_KEY || "";
  if (!apiKey) throw new Error("ALT_OPENAI_KEY not set in environment variables.");

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "gpt-4o",
      temperature: 0.4,
      max_tokens: 1200,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   }
      ]
    });
    const req = https.request({
      hostname: "api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const data = Buffer.concat(chunks).toString("utf8");
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          resolve(parsed.choices?.[0]?.message?.content || "");
        } catch (e) {
          reject(new Error("Failed to parse OpenAI response: " + data.slice(0, 200)));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Two aspects only. Grammar, spelling and punctuation are checked separately by
// grammar.js, so naming them here would duplicate that feedback and crowd out
// the things this call exists to surface.
const ASPECTS = `Compare the student's email to the Band 5 sample on these TWO aspects, and for each, say what specifically is weaker in the student's email than in the sample:
1. Content (Purpose & Elaboration): whether each bullet point is addressed with specific detail, and how fully each idea is developed.
2. Syntactic & Lexical Variety: range of sentence structures and vocabulary.
Do NOT comment on grammar, spelling, punctuation, or word-form errors — those are handled separately.`;

// Stage 4, exam and paste compare against ONE universal Band 5 reference, which
// answers a different scenario from the student's task.
const DIFF_TOPIC_NOTE = `

The sample answers a DIFFERENT scenario. It shows what a top-band email looks like, not what this student should have written. Compare only structure, development and language — never fault the student for not covering the sample's topic or content.`;

// Stage 0 compares against the model answer to the SAME question, so content is
// fair game: the two are answering the same task and can be compared directly.
const SAME_TOPIC_NOTE = `

The sample answers the SAME task as the student. You may compare content directly — how fully each bullet point is covered, and how much specific detail supports each one. Frame it as what a strong answer to this task contains, not as a list of the student's failures.`;

// An email task supplies its bullet points, so covering them is the task, not a
// lack of originality. Without this the model reliably scolds students for
// "just following the prompt".
const BULLET_NOTE = `

IMPORTANT: In an email task the bullet points define what the student must write about, so addressing them is expected and correct — never treat it as unoriginal or as copying the prompt. Placeholders such as [Name] or a bracketed signature are normal stand-ins, not a weakness.`;

function buildSystem(language, sameTopic) {
  let s = `A student's email has already been scored by a separate grader. Your job is ONLY to explain how it falls short of the Band 5 sample — you must NOT assign, mention, or change any band or score.

${ASPECTS}

Be specific to THIS email: point to the actual parts you mean. Keep it brief. Only point out specific, concrete problems in the actual text. Do NOT give generic writing advice that could apply to any email (for example, "your closing is too simple", "add more detail"). Do NOT mention band numbers or scores. Do NOT rewrite the whole email for them.`;
  s += sameTopic ? SAME_TOPIC_NOTE : DIFF_TOPIC_NOTE;
  s += BULLET_NOTE;
  if (language && language.trim().toLowerCase() !== "english") {
    s += `\n\nIMPORTANT: Write your entire explanation in ${language.trim()}. Keep any quoted student words in their original English.`;
  }
  return s;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }
  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const { question, answer, sample, band, language, same_topic } = body;
  if (!answer) {
    return { statusCode: 400, body: JSON.stringify({ error: "answer is required" }) };
  }

  let userContent = "";
  if (sample) userContent += same_topic
    ? `BAND 5 SAMPLE (same task — shows top-band quality):\n${sample}\n\n`
    : `BAND 5 SAMPLE (different scenario — shows top-band quality):\n${sample}\n\n`;
  if (question) userContent += `Task context (for reference only — do not evaluate it):\n${question}\n\n`;
  if (band != null) userContent += `(The grader scored this email as band ${band}.)\n\n`;
  userContent += `Student's email:\n${answer}`;

  try {
    const explanation = await callOpenAI(buildSystem(language, !!same_topic), userContent);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ explanation })
    };
  } catch (e) {
    console.error("email-why-not-5 error:", e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
