// functions/translate.js
// Lightweight UI-text translator (tips, hints, how-to / intro messages).
// Uses gpt-4o-mini for speed/cost. Translates plain text into the target language,
// preserving line breaks and not adding commentary.

const https = require("https");

const TRANSLATE_SYSTEM = `You translate text and study material for a TOEFL writing-practice app, for students who will read it in their own language. Write for a native reader of that language.

Translate MEANING, not words. Produce text that reads as if it were originally written by a native speaker of the target language — use that language's own natural word order, grammar, and idiom, NOT the English sentence structure. A literal, word-by-word rendering that mirrors English is wrong even when each word is correct; rephrase so it sounds natural to a native ear. Do NOT add, remove, or reinterpret ideas — keep the same content and the same order of ideas; only the phrasing should become natural.

Rules:
- Output ONLY the translation — no preamble, quotes, explanations, or notes.
- Preserve line breaks and list structure exactly.
- Natural and clear, in a neutral, instructional register.
- If REFERENCE CONTEXT is provided, use it only to understand what the text means and what it refers to (so pronouns, connectives, and compressed notes translate coherently). Do NOT translate the context itself and do NOT add any of it to your output — translate ONLY the text given under "Text to translate".
- Do NOT translate the proper noun "TOEFL".
- If the text is already in the target language, return it unchanged.`;

// Default model for short, high-volume UI strings; stronger model for long
// Stage 0 study material (samples, spines, how-to). Swap here in one place.
const TRANSLATE_MODEL_DEFAULT = "gpt-4o-mini";
const TRANSLATE_MODEL_LONG = "gpt-5.6-sol";

const BATCH_SYSTEM = `You translate a TOEFL writing-practice app's strings into a target language, for students who will read them in their own language.

Translate MEANING, not words — each string should read as if originally written by a native speaker of the target language, using that language's natural word order and idiom, not English structure. Do NOT add, remove, or reinterpret ideas.

Rules:
- Return ONLY a JSON array of strings — no keys, no numbering, no commentary, no code fences.
- The array MUST have EXACTLY the same number of items as the input, in the SAME order.
- Within a string, write any line breaks as \\n (a backslash followed by n).
- Natural and clear, in a neutral, instructional register.
- Do NOT translate the proper noun "TOEFL".
- If an item is already in the target language, return it unchanged.`;

function callOpenAI(apiKey, systemPrompt, userContent, maxTokens, model) {
  return new Promise((resolve, reject) => {
    const chosenModel = model || TRANSLATE_MODEL_DEFAULT;
    // GPT-5.x renamed "max_tokens" -> "max_completion_tokens" and may reject an
    // explicit temperature. Older 4o models keep the old param names.
    const isGpt5 = /^gpt-5/.test(chosenModel);
    const tokenCap = maxTokens || 800;
    const payloadObj = {
      model: chosenModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userContent  }
      ]
    };
    if (!isGpt5) payloadObj.temperature = 0.2;
    if (isGpt5) payloadObj.max_completion_tokens = tokenCap;
    else        payloadObj.max_tokens = tokenCap;
    const payload = JSON.stringify(payloadObj);

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

  const { text, texts, language, context, long } = body;
  const ctx = (context && String(context).trim()) ? String(context).trim() : "";
  const model = long ? TRANSLATE_MODEL_LONG : TRANSLATE_MODEL_DEFAULT;
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
    const userContent =
      (ctx ? `REFERENCE CONTEXT (do not translate — use only to understand the items):\n${ctx}\n\n` : "") +
      `Target language: ${language.trim()}\n\nTranslate each numbered item. Return a JSON array of exactly ${texts.length} strings in the same order.\n\nItems:\n${numbered}`;
    try {
      let raw = await callOpenAI(apiKey, BATCH_SYSTEM, userContent, 4000, model);
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

  const userContent =
    (ctx ? `REFERENCE CONTEXT (do not translate — use only to understand the text):\n${ctx}\n\n` : "") +
    `Target language: ${language.trim()}\n\nText to translate:\n${text}`;

  try {
    const translation = await callOpenAI(apiKey, TRANSLATE_SYSTEM, userContent, 800, model);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ translation })
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
