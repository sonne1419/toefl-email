// functions/email-analyze.js
// Analyzes email writing. Accepts: POST { user_prompt: string }
// Returns: { feedback: string }

const https = require("https");

const SCORING_RULES = `You are a TOEFL teacher evaluating a student's email writing response.
Compare the student's email to the band samples provided below.
The band samples use a DIFFERENT scenario — they illustrate writing quality only, not topic content. Evaluate the student's email on its own scenario.

Start your response with exactly: BAND:X (e.g. BAND:3)
where X is the band (0, 1, 2, 3, 4, or 5). Choose the band whose sample the student's email most closely resembles in overall effectiveness, development, and language.

Guard against responses that do not genuinely attempt the task. Compare honestly: if the email is blank, off-topic, not in English, or unconnected to the task, it matches the Band 0 sample. If it is only a few words or a single short sentence with no real development (for example "I like it" or "Wi-Fi is bad"), or is largely unintelligible, it matches the Band 0–1 samples. This is about relevance and real development, NOT originality — an email that fully and clearly addresses the task is strong even though it naturally covers the given bullet points.

IMPORTANT: Evaluate ONLY the student's email. The task prompt and bullet points are provided for reference only — do not score them, and do not penalise the student for addressing the bullet points. In an email task the bullet points define what the student must write about, so naturally covering them is expected and correct — it is NOT a lack of originality. Judge how well the email is written and whether it communicates effectively, by comparison with the samples.

Do not use accuracy as a separate criterion that determines the band — judge whether the overall communication is effective and the task is accomplished. A response that fully addresses all bullet points with specific detail, appropriate register, and good syntactic variety should be Band 5 even if it contains a few minor errors like spelling mistakes or subject-verb agreement slips. Do not let minor errors alone prevent Band 5. Placeholders such as [Name], [Your name], or a bracketed signature are normal stand-ins and are NOT a deficiency — do not lower the band for them.

Before evaluating register, determine what register is appropriate for this specific task. Not all email tasks require formal register — a complaint to a co-working space manager, a request to a club organiser, or a message to a university office may call for semi-formal language. Evaluate the student's register against what is actually appropriate for the task context.`;

// The written feedback half. Omitted in band_only mode, where a separate call
// (email-why-not-5) explains the gap instead — so this would only duplicate it.
const FEEDBACK_CATEGORIES = `

After the band assignment, evaluate using these categories, each labelled on its own line:
   - Content & Task Completion: Did the student address all parts of the task with relevant, developed content?
   - Register & Tone: Is the register appropriate for this specific task context?
   - Syntactic/Lexical Variety: Does the student use varied sentence structures and vocabulary?
   - Accuracy/Errors: Are there grammar, spelling, or structural errors? What are the patterns?
Identify error patterns and root causes.`;

// The band reference samples. Shared by both modes — the scoring must be
// identical whether or not written feedback is requested.
const BAND_SAMPLES = `

Sample Question (for band reference only — the student's actual task is different):
You recently started using a co-working space and have experienced problems with the Wi-Fi connection.
Write an email to the manager of the co-working space. In your email:
– Describe the Wi-Fi issues.
– Explain how they affect your daily work.
– Request a repair and ask for a timeline.

Email Band 5 Sample (Fully Successful):
Hi Mr. Taylor,
I hope you are well. I would like to request assistance with repairing the Wi-Fi system at the co-working space.
When I connect to the network in the morning, the internet sometimes become extreamly slow.
This has really affected my progress at the office. As a result, my work as a software engineer has been significently affected, and many others have also expressed similar complains.
Would it be possible for you to arrange for a technician to check the system in the next few days? It would also be great if you could let me know when this issue might be resolved so that everyone can send files easily.
Thank you in advance for your response.
Best regards, Chen

Email Band 4 Sample (Generally Successful):
Dear Mr. Taylor,
There is a problem with the Wi-Fi connection at the co-working space. The internet connection, which many members rely on for their daily work, have been unstable, and several times the network disconnected unexpectedly, which forced me to reconnect repeatly and interrupted my work schedule.
As a result, I can't send electronic files to my clients timely, which is very frustrating and stressful for me.
To help everyone do their work well, would it be possible to improve the Wi-Fi infastructure? Please send someone to check this issue as soon as possible tomorrow. Thanks.
Best regards, Chen

(Band 5 vs Band 4: Both address all bullet points, but Band 5 provides specific details and each sentence clearly advances the discourse. Band 4 covers the points adequately but with less specificity and some sentences add length without advancing the content.)

Email Band 3 Sample (Partially Successful):
Dear Mr. Taylor,
I'm reaching out about an issue with the Wi-Fi connection at the co-working space. Since you are the property manager, you probably know more about the internet setting more than anyone else, which is why I'm writing to you.
The internet at the dorm had always been working well. However, the network disconnected unexpectedly several times yesterday. This really interrupted my work schedule.
I really need you to send someone to fix it asap. When can you do that? Thanx.
Best regards, Chen

Email Band 2 Sample (Mostly Unsuccessful):
Dear Mr. Taylor,
I write because the Wi-Fi in co-working space has problem. Yesterday it stop many times and sometimes very slow. This is not good for me.
I need internet because I work with computer and send file to people. When Wi-Fi not work, my work become late and I feel stress. Other people also say internet is bad.
Please check this problem soon. I want know when it can be better because I cannot work good now.
Best regards, Chen

Email Band 1 Sample (Largely Unsuccessful):
Dear Mr. Taylor,
Wi-Fi is problem. I am working there but internet no good. Yesterday stop many times and very slow.
I need computer and clients. My work is difficult and cannot finish normal. Other people also maybe have this.
Please fix. I want know what time.
Thank you,

Email Band 0 Sample (No Meaningful Original Response):
Hi Mr. Taylor,
I started using co-working space and have experienced problems with the Wi-Fi connection. Wi-The issues affect my daily work. I request a repair and ask for a timeline.
Thanks.`;

// Full analysis: scoring rules + written feedback categories + band samples.
const SYSTEM_PROMPT = SCORING_RULES + FEEDBACK_CATEGORIES + BAND_SAMPLES;

// Band only: the same scoring rules and the same samples, minus the written
// feedback. Used where a separate call explains the gap, so the two would
// otherwise say the same thing twice. Identical rules in, identical band out.
const SYSTEM_PROMPT_BAND_ONLY = SCORING_RULES + BAND_SAMPLES + `

Respond with ONLY the band line, exactly: BAND:X
Give no explanation, no categories, and no other text.`;

function callOpenAI(userPrompt, systemPrompt) {
  const apiKey = process.env.ALT_OPENAI_KEY || "";
  if (!apiKey) throw new Error("ALT_OPENAI_KEY not set.");

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "gpt-4o",
      temperature: 0.4,
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
          if (parsed.error) return reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          resolve(parsed.choices?.[0]?.message?.content || "");
        } catch(e) {
          reject(new Error("Failed to parse OpenAI response"));
        }
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
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) }; }

  const { user_prompt, language, mode } = body;
  if (!user_prompt)
    return { statusCode: 400, body: JSON.stringify({ error: "user_prompt is required" }) };

  const bandOnly = (mode === "band_only");
  const base = bandOnly ? SYSTEM_PROMPT_BAND_ONLY : SYSTEM_PROMPT;

  // Inject language instruction if the student's language isn't English.
  // Band-only output is a single "BAND:X" line with nothing to translate, so
  // the instruction is skipped there — it would only invite stray prose.
  const lang = (language || "").trim();
  const isEnglish = !lang || /^english$/i.test(lang);
  const systemPrompt = (isEnglish || bandOnly)
    ? base
    : base + `\n\nIMPORTANT: Write ALL of your feedback in ${lang}, including the text after each category label (Content & Task Completion, Register & Tone, Syntactic/Lexical Variety, Accuracy/Errors). Keep only the "BAND:X" line and the four category labels themselves in English exactly as written — translate everything else, including all explanations. Keep grammar terminology clear.`;

  try {
    const feedback = await callOpenAI(user_prompt, systemPrompt);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ feedback })
    };
  } catch(e) {
    console.error("[email-analyze] OpenAI error:", e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
