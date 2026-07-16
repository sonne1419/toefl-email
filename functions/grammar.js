// functions/grammar.js
// Grammar check for email writing practice.
// Receives all transcripts from a session, runs grammar check via GPT-4o.
// Returns per-sentence errors; the Original line is always a verbatim student sentence.

const https = require("https");

const GRAMMAR_SYSTEM = `You are an English grammar checker for TOEFL email writing practice.

The student TYPED these responses, so check for genuine errors in grammar, punctuation, capitalization, and spelling — punctuation, capitalization, and spelling are the student's own choices and DO count, so do not skip them.

IGNORE (these are NOT errors — do not flag them):
- Formality or tone issues
- Word choice or style preferences
- Phrasing that is grammatically valid but could merely be smoother or "more natural"
- Acceptable variation in word order or modifier placement
- OPTIONAL changes that are not required: if both the original and a possible alternative are grammatically acceptable (even if they differ slightly in nuance or meaning), the original is NOT an error — leave it alone.

CRITICAL PRINCIPLE — MUST-FIX ONLY: Flag a sentence ONLY if it contains a MUST-FIX error: a mistake that is unambiguously wrong and that a teacher would definitely mark as incorrect. Do NOT flag anything that is merely a possible improvement, an optional adjustment, or a change that would alter meaning rather than fix an error. The test is "Must this be corrected to be grammatically acceptable?" — not "Could this be changed?" If the original is already grammatically acceptable (even if another version is possible or slightly different in nuance), leave it completely alone. When in doubt, treat it as correct and do not flag it. A "correction" of something that was already acceptable is itself an error you must avoid. Do not invent errors to appear thorough.

For each response, go sentence by sentence.
Only include sentences that contain a real, must-fix error.
Skip correct sentences entirely.

If a sentence has MULTIPLE errors, give ONE Original/Revised pair that fixes all of them in the single Revised sentence, and on the Error line name each type, separated by "; ".

IMPORTANT: the Error line must account for EVERY change you made between Original and Revised — including any punctuation fix (e.g. a missing final period), capitalization fix, or spelling fix. If the Revised sentence adds a final period the Original lacked, that punctuation fix must appear on the Error line. Do not silently change something without naming it.

Use this EXACT format:

=== Q{number} ===
Original: [an EXACT, word-for-word copy of a sentence that actually appears in the student response]
Error: [name the type(s) of error in natural, specific terms that genuinely fit the actual mistake. Describe what it actually is in your own words; do not pick from a fixed preset list. If there are several errors, separate them with "; ".]
Revised: [corrected sentence with ALL errors fixed]

[repeat for each error sentence in this question]

Rules:
- CRITICAL — QUOTE THE STUDENT VERBATIM: The "Original:" line MUST be copied word-for-word from the student's actual response. NEVER paraphrase, simplify, shorten, or invent an example sentence. If you cannot quote the exact sentence from the student's text, do not output it at all. Only the "Revised:" line may differ from the student's wording. A fabricated "Original" that the student never wrote is a serious error.
- The "Revised:" line corrects the grammar of the student's original sentence only. It must NOT introduce any new idea compared to the original sentence.
- If a question has no errors, write: === Q{number} ===\n(No grammar errors found)
- The Error label must accurately describe the real mistake. Never mislabel — for example, do NOT call a plural/number issue "spelling". Choose the term that truly fits.
- Keep each error label short (a few words).
- Do not repeat the question text.`;

function callOpenAI(apiKey, systemPrompt, userContent) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userContent  }
      ],
      temperature: 0.2,
      max_tokens: 1500
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
        const _chunks = [];
        res.on("data", chunk => _chunks.push(chunk));
        res.on("end", () => {
          const data = Buffer.concat(_chunks).toString("utf8");
          try {
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

  const { questions, language } = body; // array of { question, transcript }
  if (!questions || !Array.isArray(questions) || questions.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing questions array" }) };
  }

  const lang = (language || "").trim();
  const isEnglish = !lang || /^english$/i.test(lang);
  let systemPrompt = isEnglish
    ? GRAMMAR_SYSTEM
    : GRAMMAR_SYSTEM + `\n\nIMPORTANT — LANGUAGE: Write the error-type names (after "Error:") in ${lang}, not in English. Also write any explanations in ${lang}. Keep the student's sentences inside the "Original:" and "Revised:" lines in ENGLISH exactly (Original is the student's verbatim English; Revised is the corrected English). Keep the format labels "Original:", "Error:", "Revised:" and section markers (=== Q1 ===) in English exactly as specified — these are required for parsing.`;


  const questionBlocks = questions.map((q, i) =>
    `Q${i + 1}:\nQuestion: ${q.question}\nStudent response: ${(q.transcript || "").replace(/\s+/g, " ").trim()}`
  ).join("\n\n");

  try {
    const result = await callOpenAI(apiKey, systemPrompt, questionBlocks);
    const filtered = dropFabricatedOriginals(result, questions);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ grammar: filtered })
    };
  } catch(e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message })
    };
  }
};

// Safety net against hallucinated corrections: drop any Original/Error/Revised triple
// whose "Original:" sentence does not actually appear in the student's transcript.
// Matches per === Qn === block against that question's transcript (whitespace- and
// case-normalized, punctuation-insensitive so minor formatting differences still match).
function dropFabricatedOriginals(result, questions) {
  if (!result || result.indexOf("Original:") === -1) return result;
  const norm = (s) => (s || "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/[^a-z0-9']+/g, " ")   // collapse punctuation/spacing to single spaces
    .replace(/\s+/g, " ").trim();

  // Split into === Qn === sections, keeping each section with its index.
  const sections = result.split(/(?=^===\s*Q\d+\s*===)/m);
  const out = sections.map(sec => {
    const m = sec.match(/^===\s*Q(\d+)\s*===/m);
    if (!m) return sec;
    const qIdx = parseInt(m[1], 10) - 1;
    const transcript = norm((questions[qIdx] && questions[qIdx].transcript) || "");
    if (!transcript) return sec;

    // Walk the triples in this section; keep only those whose Original is in transcript.
    const header = sec.slice(0, m.index + m[0].length);
    const bodyTxt = sec.slice(m.index + m[0].length);
    // Match each Original:/Error:/Revised: triple.
    const triple = /Original:\s*([\s\S]*?)\n\s*Error:\s*([\s\S]*?)\n\s*Revised:\s*([\s\S]*?)(?=\n\s*Original:|\s*$)/g;
    let kept = "", t, any = false, sawTriple = false;
    while ((t = triple.exec(bodyTxt)) !== null) {
      sawTriple = true;
      const original = t[1].trim();
      if (norm(original) && transcript.indexOf(norm(original)) !== -1) {
        kept += "Original: " + original + "\nError: " + t[2].trim() + "\nRevised: " + t[3].trim() + "\n\n";
        any = true;
      }
      // else: fabricated Original — silently dropped.
    }
    if (!sawTriple) return sec;                 // section had no triples (e.g. "No grammar errors found") — leave as-is
    if (!any) return header + "\n(No grammar errors found)\n\n";
    return header + "\n" + kept;
  });
  return out.join("");
}
