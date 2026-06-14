// Edge Function: generate-lesson
// ----------------------------------------------------------------------------
// Generates a full mini-lesson for ONE chapter via OpenAI, REUSING the chapter's
// 5 words (CLAUDE.md hard rule 4). Difficulty scales with CEFR level:
//   A1/A2  -> short, simple; MCQ comprehension; single-word / short answers.
//   B1/B2/C1 -> longer, more abstract; comprehension answers and the writing
//               task require FULL SENTENCES (open-ended), progressively harder.
// Returns listening + reading + grammar + writing in one JSON payload so the
// client makes ONE call per chapter and caches it.
//
// Provider: OpenAI (gpt-4o-mini). Key SERVER-ONLY. Auth: verify_jwt + fail-closed.
// Request (POST JSON): { words:[{en,ar}]|string[], level, topic? }
// deno-lint-ignore-file no-explicit-any
import { getAuthedUser, getServiceClient, HttpError } from "../_shared/auth.ts";
import { checkAndIncrement } from "../_shared/quota.ts";
import { fetchWithRetry } from "../_shared/http.ts";
import { corsHeadersFor } from "../_shared/cors.ts";

// Clamp to the expected shape (max 5 words per chapter) so a malicious client
// can't balloon input/output tokens with a huge words array.
function normWords(input: any): { en: string; ar?: string }[] {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 8)
    .map((w) => (typeof w === "string" ? { en: w } : { en: String(w?.en ?? ""), ar: w?.ar }))
    .map((w) => ({ en: w.en.slice(0, 60), ar: typeof w.ar === "string" ? w.ar.slice(0, 60) : w.ar }))
    .filter((w) => w.en);
}

function difficultyRules(level: string): string {
  const hi = ["B1", "B2", "C1"].includes(level);
  if (!hi) {
    return [
      "This is a LOW level (A1/A2): keep English short and simple (1-2 short sentences per item).",
      "Listening transcript: 2-4 short lines. Reading passage: 2-3 short sentences.",
      "Comprehension questions: multiple choice (kind:'mcq') with 3 options. Short.",
      "Writing task: ask the learner to write ONE simple sentence (or a couple of words) using a target word.",
    ].join(" ");
  }
  return [
    `This is a HIGH level (${level}): make it genuinely challenging and longer.`,
    "Listening transcript: a richer 6-10 line dialogue or monologue on an abstract/real-world topic.",
    "Reading passage: a substantial paragraph (5-8 sentences) with some abstract ideas.",
    "Comprehension: MIX multiple choice with at least one OPEN question (kind:'write') whose answer must be a FULL SENTENCE in English (provide sample_answer_en).",
    "Writing task: require the learner to write 3-5 FULL SENTENCES (not single words) on a real prompt, naturally using the target words.",
  ].join(" ");
}

function buildSystem(words: { en: string; ar?: string }[], level: string, topic: string): string {
  const list = words.map((w) => (w.ar ? `"${w.en}" (${w.ar})` : `"${w.en}"`)).join(", ");
  return [
    "You create mini English lessons for an Arabic-speaking learner. Output is shown in an Arabic-first RTL app:",
    "all explanations/instructions in ARABIC, all English content in English.",
    `CEFR level: ${level}. Topic: ${topic || "everyday English"}.`,
    `You MUST naturally reuse ALL of these 5 target words: ${list}.`,
    difficultyRules(level),
    "Return STRICT JSON only, exactly this shape:",
    '{"listening":{"transcript_en":"...","translation_ar":"...","questions":[{"prompt_ar":"...","kind":"mcq","options":["..."],"options_ar":["..."],"answer_index":0,"explanation_ar":"..."}]},' +
    '"reading":{"title_en":"...","passage_en":"...","translation_ar":"...","questions":[{"prompt_ar":"...","kind":"mcq","options":["..."],"options_ar":["..."],"answer_index":0,"explanation_ar":"..."}]},' +
    '"grammar":{"title_ar":"...","explanation_ar":"...","examples":[{"en":"...","ar":"..."}],"questions":[{"prompt_ar":"...","kind":"mcq","options":["..."],"options_ar":["..."],"answer_index":0,"explanation_ar":"..."}]},' +
    '"writing":{"prompt_ar":"...","instructions_ar":"...","target_words":["..."],"min_sentences":1,"sample_en":"..."},' +
    '"vocab":[{"en":"<each target word EXACTLY as given>","examples":[{"en":"...","ar":"..."},{"en":"...","ar":"..."},{"en":"...","ar":"..."}]}]}',
    'For OPEN questions use {"kind":"write","prompt_ar":"...","sample_answer_en":"..."} (no options/answer_index).',
    'vocab MUST contain ALL 5 target words, each with EXACTLY 3 natural example sentences (en + Arabic translation) at this level.',
    "listening AND reading MUST each have EXACTLY 3 multiple-choice questions (kind:'mcq', 3 options each). grammar: 2-3 questions.",
    "HARD RULES for every mcq question (follow EXACTLY):",
    "1) options = an array of EXACTLY 3 strings. Each string is written ONLY in English (Latin letters). NEVER put any Arabic text inside an options entry, and NEVER interleave English and Arabic. Wrong: [\"To rest\",\"للراحة\",\"To finish\"]. Right: [\"To rest\",\"To finish\",\"To wait\"].",
    "2) options_ar = an array of EXACTLY 3 strings, the Arabic translation of options[i] at the SAME index (options_ar[0] translates options[0], etc.). Same length (3), same order. Never reorder.",
    "3) answer_index = an integer 0, 1, or 2 pointing at the correct option. For listening/reading the correct option MUST be explicitly supported by a sentence in the transcript/passage; do not invent it. Keep prompt_ar in Arabic. Do not add any text outside the JSON.",
  ].join("\n");
}

async function llm(system: string, user: string, maxTokens = 2600): Promise<any> {
  const key = Deno.env.get("LLM_API_KEY");
  if (!key) throw new HttpError(500, "Server misconfigured: LLM_API_KEY missing");
  const res = await fetchWithRetry("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new HttpError(502, `LLM request failed (${res.status})`); }
  const data = await res.json().catch(() => null) as any;
  const text = typeof data?.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content.trim() : "";
  if (!text) throw new HttpError(502, "LLM returned empty");
  try { return JSON.parse(text); } catch { throw new HttpError(502, "LLM returned invalid JSON"); }
}

Deno.serve(async (req: Request) => {
  const cors = corsHeadersFor(req);
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const { user } = await getAuthedUser(req); // signed-in users only
    const body = await req.json().catch(() => null) as any;
    if (!body) throw new HttpError(400, "Invalid body");
    const words = normWords(body.words);
    if (!words.length) throw new HttpError(400, "Missing 'words'");
    const level = String(body.level || "A1");
    const topic = String(body.topic || "");

    // Per-user daily quota (abuse/cost control) — fail closed BEFORE any paid LLM call.
    await checkAndIncrement(getServiceClient(), user.id, "generate_lesson");

    // FAST path: examples only (called eagerly so word examples appear quickly).
    if (String(body.only || "") === "examples") {
      const list = words.map((w) => (w.ar ? `"${w.en}" (${w.ar})` : `"${w.en}"`)).join(", ");
      const sys = [
        `You are an expert English tutor for an Arabic speaker. For EACH of these 5 words write EXACTLY 3 short, natural example sentences at CEFR ${level}, each with an Arabic translation.`,
        `Words: ${list}.`,
        "Every English example MUST naturally use the target word (or a normal inflected form of it).",
        "TRANSLATION FIDELITY (critical): each Arabic translation MUST exactly match its English sentence — same TENSE (past/present/future), same SUBJECT and PRONOUN (I/you/he/she/we/they), and the correct GENDER and NUMBER agreement. For example, translate \"She has four cats\" as \"لديها أربع قطط\" (NOT \"لدينا\"); translate \"I take medicine\" as a present-tense \"آخُذ\" (NOT past \"أخذت\"). Use clear, correct Modern Standard Arabic with proper verb/adjective agreement.",
        'Return STRICT JSON only: {"vocab":[{"en":"<word exactly as given>","examples":[{"en":"...","ar":"..."},{"en":"...","ar":"..."},{"en":"...","ar":"..."}]}]}',
      ].join("\n");
      const out = await llm(sys, "Generate the examples now.", 1100);
      return json({ vocab: Array.isArray(out.vocab) ? out.vocab : [] });
    }

    const system = buildSystem(words, level, topic);
    const lesson = await llm(system, `Create the lesson for topic "${topic}" at level ${level}. Reuse all 5 target words.`);
    return json(lesson);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    return json({ error: "Internal error" }, 500);
  }
});
