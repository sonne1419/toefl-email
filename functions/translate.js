// functions/translate.js
// Lightweight UI-text translator (tips, hints, how-to / intro messages).
// Uses gpt-4o-mini for speed/cost. Translates plain text into the target language,
// preserving line breaks and not adding commentary.

const https = require("https");

const TRANSLATE_SYSTEM = `You are a translator for a TOEFL writing-practice app's interface text (study tips and how-to instructions).
Translate the user's text into the requested target language.
Rules:
- Output ONLY the translation. No preamble, no quotes, no explanations, no notes.
- Preserve line breaks and list structure exactly.
- Keep it natural and concise, as UI guidance for a student.
- Do NOT translate the proper noun "TOEFL".
- If the text is already in the target language, return it unchanged.`;

const BATCH_SYSTEM = `You translate a TOEFL writing-practice app's interface strings into a target language.
You are given a numbered list of strings. Translate each one.
Rules:
- Return ONLY a JSON array of strings — no keys, no numbering, no commentary, no code fences.
- The array MUST have EXACTLY the same number of items as the input, in the SAME order.
- Within a string, write any line breaks as \\n (a backslash followed by n).
- Keep each translation natural and concise, as UI guidance for a student.
- Do NOT translate the proper noun "TOEFL".
- If an item is already in the target language, return it unchanged.`;

function callOpenAI(apiKey, systemPrompt, userContent, maxTokens) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userContent  }
      ],
      temperature: 0.2,
      max_tokens: maxTokens || 800
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
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: "Invalid request" }) }; }

  const { text, texts, language } = body;
  const isEnglish = !language || language.trim().toLowerCase() === "english";

  // ── BATCH MODE: { texts: [...], language } → { translations: [...] } in ONE call ──
  if (Array.isArray(texts)) {
    if (!texts.length) {
      return { statusCode: 200, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ translations: [] }) };
    }
    if (isEnglish) {
      // No call needed — return unchanged, same order
      return { statusCode: 200, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ translations: texts }) };
    }
    const numbered = texts.map((t, i) => `[${i}] ${String(t).replace(/\n/g, "\\n")}`).join("\n");
    const userContent = `Target language: ${language.trim()}\n\nTranslate each numbered item. Return a JSON array of exactly ${texts.length} strings in the same order.\n\nItems:\n${numbered}`;
    try {
      let raw = await callOpenAI(apiKey, BATCH_SYSTEM, userContent, 4000);
      raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      let arr = null;
      try { arr = JSON.parse(raw); } catch(_) { arr = null; }
      if (!Array.isArray(arr) || arr.length !== texts.length) {
        // Signal failure so the client falls back to per-string calls
        return { statusCode: 200, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ translations: null }) };
      }
      // Restore literal line breaks (model was told to emit \n as text)
      const translations = arr.map(s => String(s).replace(/\\n/g, "\n"));
      return { statusCode: 200, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ translations }) };
    } catch(e) {
      return { statusCode: 200, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ translations: null }) };
    }
  }

  // ── SINGLE MODE (unchanged): { text, language } → { translation } ──
  if (!text || !text.trim()) {
    return { statusCode: 200, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ translation: "" }) };
  }
  // No language or English → return as-is, no call
  if (isEnglish) {
    return { statusCode: 200, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ translation: text }) };
  }

  const userContent = `Target language: ${language.trim()}\n\nText to translate:\n${text}`;

  try {
    const translation = await callOpenAI(apiKey, TRANSLATE_SYSTEM, userContent, 800);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ translation })
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
