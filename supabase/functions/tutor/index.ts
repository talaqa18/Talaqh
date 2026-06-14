// Edge Function: tutor
// ----------------------------------------------------------------------------
// Lightweight, CONTENT-AGNOSTIC conversation tutor for the single-file Talaqa
// app, whose lesson content lives locally (no DB unit ids). Unlike the strict
// `conversation` function, this one does NOT create a DB session — the client
// passes the target words + level, manages the 3-minute timer / turn tracking
// itself, and we just generate the next tutor message via the LLM.
//
// Provider: OpenAI Chat Completions (gpt-4o-mini). Key is SERVER-ONLY.
// Auth: verify_jwt + fail-closed user resolve.
// Quota: counts one "conversation_session" on the OPENER only (not per turn).
//
// Request (POST JSON):
//   { target_words: (string | {en,ar})[], level?, goal?,
//     history?: {role,content}[], user_text?, opener?: boolean }
// Response: { message, translation_ar, hint_ar, words_used: string[] }
// deno-lint-ignore-file no-explicit-any
import { getAuthedUser, getServiceClient, HttpError } from "../_shared/auth.ts";
import { checkAndIncrement } from "../_shared/quota.ts";
import { fetchWithRetry } from "../_shared/http.ts";
import { corsHeadersFor } from "../_shared/cors.ts";

interface Word { en: string; ar?: string; }

function normWords(input: any): Word[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((w) => (typeof w === "string" ? { en: w } : { en: String(w?.en ?? ""), ar: w?.ar }))
    .filter((w) => w.en);
}

function buildSystem(words: Word[], level: string, goal: string): string {
  const list = words.map((w) => (w.ar ? `- "${w.en}" (${w.ar})` : `- "${w.en}"`)).join("\n");
  return [
    "You are a warm, encouraging English conversation tutor for an Arabic-speaking learner.",
    `The learner's CEFR level is ${level || "A1"}. Their goal: ${goal || "general everyday English"}.`,
    "You TYPE short, friendly English messages (1-3 simple sentences). Be natural and patient.",
    "Gently steer the chat so the learner naturally uses ALL of these target words:",
    list,
    "",
    'ALWAYS reply with STRICT JSON only: {"reply":"<short English message>","translation_ar":"<Arabic translation of your reply>","hint_ar":"<one short Arabic tip nudging toward a target word>"}',
  ].join("\n");
}

function detectUsed(transcript: string, words: Word[]): string[] {
  const used: string[] = [];
  for (const w of words) {
    const esc = w.en.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!esc) continue;
    if (new RegExp(`\\b${esc}(?:'?s)?\\b`, "i").test(transcript)) used.push(w.en);
  }
  return used;
}

async function llm(system: string, messages: { role: "user" | "assistant"; content: string }[]) {
  const key = Deno.env.get("LLM_API_KEY");
  if (!key) throw new HttpError(500, "Server misconfigured: LLM_API_KEY missing");
  const res = await fetchWithRetry("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });
  if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new HttpError(502, `LLM request failed (${res.status})`); }
  const data = await res.json().catch(() => null) as any;
  const text = typeof data?.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content.trim() : "";
  if (!text) throw new HttpError(502, "LLM returned an empty response");
  let o: any = null;
  try { o = JSON.parse(text); } catch { /* not JSON */ }
  if (o && typeof o === "object") {
    const reply = [o.reply, o.message, o.text, o.response].find((x: any) => typeof x === "string" && x.trim());
    if (reply) {
      return { reply, translation_ar: typeof o.translation_ar === "string" ? o.translation_ar : "", hint_ar: typeof o.hint_ar === "string" ? o.hint_ar : "" };
    }
    // Never surface raw JSON to the learner.
    return { reply: "Great — tell me more!", translation_ar: "", hint_ar: "" };
  }
  return { reply: text, translation_ar: "", hint_ar: "" };
}

Deno.serve(async (req: Request) => {
  const cors = corsHeadersFor(req);
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const { user } = await getAuthedUser(req);
    const body = await req.json().catch(() => null) as any;
    if (!body) throw new HttpError(400, "Invalid body");

    const words = normWords(body.target_words);
    const level = String(body.level ?? "A1");
    const goal = String(body.goal ?? "");
    const history = Array.isArray(body.history) ? body.history : [];
    const userText = typeof body.user_text === "string" ? body.user_text : "";
    const opener = !!body.opener || history.length === 0;

    // Quota: one session per opener (not per turn).
    if (opener) {
      const service = getServiceClient();
      await checkAndIncrement(service, user.id, "conversation_session");
    }

    const system = buildSystem(words, level, goal);
    const thread: { role: "user" | "assistant"; content: string }[] = [];
    for (const m of history) {
      const role = m?.role === "assistant" ? "assistant" : "user";
      if (typeof m?.content === "string") thread.push({ role, content: m.content });
    }
    if (opener && thread.length === 0) {
      thread.push({ role: "user", content: "Start with a short, friendly English greeting and an opening question." });
    } else if (userText) {
      thread.push({ role: "user", content: userText });
    }

    const out = await llm(system, thread);
    const wordsUsed = userText ? detectUsed(userText, words) : [];
    return json({ message: out.reply, translation_ar: out.translation_ar, hint_ar: out.hint_ar, words_used: wordsUsed });
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    return json({ error: "Internal error" }, 500);
  }
});
