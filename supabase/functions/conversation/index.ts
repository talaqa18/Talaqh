// Edge Function: conversation
// ----------------------------------------------------------------------------
// The 3-minute AI conversation tutor (CLAUDE.md hard rule 4: it reuses the
// CURRENT unit's 5 words). The LLM provider key is SERVER-ONLY — the system
// prompt (with the target words, the learner's level + goal) is constructed
// here and never sent from the browser, so the client can't tamper with the
// teaching contract or read the key.
//
// Three actions, all POST JSON:
//   { action: "start",    unit_id }
//   { action: "reply",    session_id, user_transcript }
//   { action: "finalize", session_id, reason? }   // reason in completed|expired|abandoned
//
// Trust boundary (integrity rule 7):
//   * getAuthedUser  — fail-closed user resolution from the caller's JWT.
//   * getServiceClient — used ONLY to invoke the SECURITY DEFINER conversation_*
//     RPCs (migration 0010) which perform the trusted writes and SERVER-ENFORCE
//     the 180s window + 12-turn cap. We surface those RPC errors as 409/400.
//   * checkAndIncrement — daily quota gate BEFORE any paid LLM work (start only).
//
// XP for the conversation section is awarded by the CLIENT calling complete_section
// with its own JWT — we never award XP here.
//
// Deno runtime — `Deno` globals are provided by the Supabase Edge runtime.
// deno-lint-ignore-file no-explicit-any

import { getAuthedUser, getServiceClient, HttpError } from "../_shared/auth.ts";
import { checkAndIncrement } from "../_shared/quota.ts";
import { fetchWithRetry } from "../_shared/http.ts";
import { corsHeadersFor } from "../_shared/cors.ts";

interface RequiredWord {
  id: string;
  text_en: string;
  translation_ar: string;
}

interface TutorReply {
  reply: string;
  translation_ar: string;
  hint_ar: string;
}

// ----------------------------------------------------------------------------
// LLM helper — SWAPPABLE.
// ----------------------------------------------------------------------------
// The entire conversation provider lives behind this one function. To swap the
// provider (e.g. to OpenAI), reimplement llm() only — no screen / RPC changes.
// Currently targets the Anthropic Messages API with a small, cheap model and a
// hard output cap. The model is instructed to return STRICT JSON; if parsing
// fails we degrade gracefully to a plain reply.
async function llm(
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
): Promise<TutorReply> {
  const key = Deno.env.get("LLM_API_KEY");
  if (!key) {
    throw new HttpError(500, "Server misconfigured: LLM_API_KEY missing");
  }

  // OpenAI Chat Completions with a cheap model + hard output cap. The system
  // prompt is the first message; response_format json_object forces valid JSON
  // so parsing is reliable.
  const res = await fetchWithRetry("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });

  if (!res.ok) {
    // Never leak the provider error body verbatim — status only.
    await res.body?.cancel().catch(() => {});
    throw new HttpError(502, `LLM request failed (${res.status})`);
  }

  const data = await res.json().catch(() => null) as any;
  const text: string = typeof data?.choices?.[0]?.message?.content === "string"
    ? data.choices[0].message.content.trim()
    : "";

  if (!text) {
    throw new HttpError(502, "LLM returned an empty response");
  }

  // The model is asked for STRICT JSON. Be lenient: extract the first {...} block
  // in case the model wraps it in prose / code fences.
  const parsed = tryParseTutorReply(text);
  if (parsed) return parsed;

  // Fallback: treat the whole text as the reply with empty Arabic helpers.
  return { reply: text, translation_ar: "", hint_ar: "" };
}

function tryParseTutorReply(text: string): TutorReply | null {
  const candidates: string[] = [text];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    candidates.push(text.slice(start, end + 1));
  }
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (obj && typeof obj.reply === "string") {
        return {
          reply: obj.reply,
          translation_ar: typeof obj.translation_ar === "string"
            ? obj.translation_ar
            : "",
          hint_ar: typeof obj.hint_ar === "string" ? obj.hint_ar : "",
        };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// System prompt — built SERVER-SIDE only (rule 4 + AI key safety).
// ----------------------------------------------------------------------------
function buildSystemPrompt(
  words: RequiredWord[],
  level: string,
  goal: string,
): string {
  const wordList = words
    .map((w) => `- "${w.text_en}" (${w.translation_ar})`)
    .join("\n");
  return [
    "You are a warm, encouraging English conversation tutor for an Arabic-speaking learner.",
    `The learner's CEFR level is ${level || "A1"}. Their learning goal is: ${
      goal || "general everyday English"
    }.`,
    "You TYPE short, friendly English messages (1-3 sentences). Keep the English simple and",
    "appropriate for the learner's level. Be patient and natural, like a real conversation.",
    "",
    "Your TEACHING GOAL: gently guide the learner to use ALL of these target words in the chat.",
    "Steer the topic so each word fits naturally. Do not lecture; weave them into questions.",
    "Target words (English — Arabic meaning):",
    wordList,
    "",
    "ALWAYS respond with STRICT JSON and nothing else, in exactly this shape:",
    '{"reply":"<your short English message>","translation_ar":"<Arabic translation of your reply>","hint_ar":"<one short Arabic tip nudging them toward a target word>"}',
    "Do not wrap the JSON in code fences. Do not add any text outside the JSON object.",
  ].join("\n");
}

// ----------------------------------------------------------------------------
// Used-word detection.
// ----------------------------------------------------------------------------
// Whole-word, case-insensitive match of each required word's text_en in the
// learner's transcript. Also accepts a simple plural / possessive "s" suffix.
// Returns the ids of the words that were used.
function detectUsedWordIds(
  transcript: string,
  words: RequiredWord[],
): string[] {
  const used: string[] = [];
  for (const w of words) {
    const escaped = w.text_en.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!escaped) continue;
    // \b word boundary; allow an optional trailing 's (plural / possessive).
    const re = new RegExp(`\\b${escaped}(?:'?s)?\\b`, "i");
    if (re.test(transcript)) used.push(w.id);
  }
  return used;
}

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req);

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const { user } = await getAuthedUser(req);
    const service = getServiceClient();

    const body = await req.json().catch(() => null) as any;
    if (!body || typeof body.action !== "string") {
      throw new HttpError(400, "Missing or invalid 'action'");
    }
    const action: string = body.action;

    // ------------------------------------------------------------------ start
    if (action === "start") {
      const unitId = body.unit_id;
      if (!unitId) throw new HttpError(400, "Missing 'unit_id'");

      // Quota gate BEFORE any paid work.
      await checkAndIncrement(service, user.id, "conversation_session");

      // Open the session (RPC sets required_word_ids + ends_at server-side).
      const startRows = await rpc(service, "conversation_start", {
        p_user_id: user.id,
        p_unit_id: unitId,
      });
      const s = startRows?.[0];
      if (!s?.session_id) throw new HttpError(500, "Failed to start session");

      // Fetch the 5 target words for this session.
      const words = await loadWords(service, s.required_word_ids ?? []);

      // Read the learner's level + goal to personalize the system prompt.
      const { data: profile } = await service
        .from("profiles")
        .select("current_level,goal")
        .eq("id", user.id)
        .single();

      const system = buildSystemPrompt(
        words,
        profile?.current_level ?? "A1",
        profile?.goal ?? "",
      );

      // Kick off the conversation: the model produces the OPENING message.
      const opener = await llm(system, [{
        role: "user",
        content:
          "Start the conversation with a short, friendly English greeting and an opening question.",
      }]);

      // Persist the opener as the assistant's first turn.
      await rpc(service, "conversation_append_opener", {
        p_user_id: user.id,
        p_session_id: s.session_id,
        p_assistant_content: opener.reply,
      });

      return json({
        session_id: s.session_id,
        ends_at: s.ends_at,
        required_words: words.map((w) => ({
          id: w.id,
          text_en: w.text_en,
          translation_ar: w.translation_ar,
        })),
        message: opener.reply,
        translation_ar: opener.translation_ar,
        hint_ar: opener.hint_ar,
      });
    }

    // ------------------------------------------------------------------ reply
    if (action === "reply") {
      const sessionId = body.session_id;
      const transcript = body.user_transcript;
      if (!sessionId) throw new HttpError(400, "Missing 'session_id'");
      if (typeof transcript !== "string" || !transcript.trim()) {
        throw new HttpError(400, "Missing 'user_transcript'");
      }

      // Load this session's required words (via conversation_sessions).
      const { data: session, error: sErr } = await service
        .from("conversation_sessions")
        .select("required_word_ids")
        .eq("id", sessionId)
        .eq("user_id", user.id)
        .single();
      if (sErr || !session) throw new HttpError(404, "Session not found");
      const words = await loadWords(service, session.required_word_ids ?? []);

      // Load history to give the model context.
      const { data: history } = await service
        .from("conversation_messages")
        .select("role,content,turn_index")
        .eq("session_id", sessionId)
        .order("turn_index");

      const profileRes = await service
        .from("profiles")
        .select("current_level,goal")
        .eq("id", user.id)
        .single();
      const system = buildSystemPrompt(
        words,
        profileRes.data?.current_level ?? "A1",
        profileRes.data?.goal ?? "",
      );

      // Build the message thread for the model: prior turns + the new user turn.
      const thread: { role: "user" | "assistant"; content: string }[] = [];
      for (const m of (history ?? [])) {
        const role = m.role === "assistant" ? "assistant" : "user";
        thread.push({ role, content: m.content });
      }
      thread.push({ role: "user", content: transcript });

      // Generate the tutor's next reply.
      const next = await llm(system, thread);

      // Detect which target words the learner used (server-side, authoritative).
      const usedWordIds = detectUsedWordIds(transcript, words);

      // Persist the user turn + assistant reply. The RPC ENFORCES the 180s
      // window + 12-turn cap and RAISES if exceeded — map that to 409.
      const appendRows = await rpc(service, "conversation_append_messages", {
        p_user_id: user.id,
        p_session_id: sessionId,
        p_user_content: transcript,
        p_user_used_word_ids: usedWordIds,
        p_assistant_content: next.reply,
      }, /* mapRaiseTo */ 409);
      const appended = appendRows?.[0];

      return json({
        message: next.reply,
        translation_ar: next.translation_ar,
        hint_ar: next.hint_ar,
        words_used: appended?.words_used_ids ?? usedWordIds,
        turns_used: appended?.turns_used ?? null,
      });
    }

    // --------------------------------------------------------------- finalize
    if (action === "finalize") {
      const sessionId = body.session_id;
      if (!sessionId) throw new HttpError(400, "Missing 'session_id'");
      const reason = body.reason ?? "completed";
      if (!["completed", "expired", "abandoned"].includes(reason)) {
        throw new HttpError(400, "Invalid 'reason'");
      }

      const finRows = await rpc(service, "conversation_finalize", {
        p_user_id: user.id,
        p_session_id: sessionId,
        p_reason: reason,
      });
      const f = finRows?.[0];
      if (!f) throw new HttpError(500, "Failed to finalize session");

      return json({
        outcome: f.outcome,
        words_used_count: f.words_used_count,
      });
    }

    throw new HttpError(400, `Unknown action '${action}'`);
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ error: err.message }, err.status);
    }
    // Never leak internals.
    return json({ error: "Internal error" }, 500);
  }
});

// ----------------------------------------------------------------------------
// Small RPC wrapper: invokes a SECURITY DEFINER conversation_* RPC and returns
// the rows. Postgres RAISE errors are surfaced as HttpError. When `mapRaiseTo`
// is given (the turn/window-cap RPC), business-rule violations map to that
// status instead of a generic 400.
// ----------------------------------------------------------------------------
async function rpc(
  service: any,
  name: string,
  args: Record<string, unknown>,
  mapRaiseTo = 400,
): Promise<any[]> {
  const { data, error } = await service.rpc(name, args);
  if (error) {
    // Postgres RAISE shows up as an error; treat as a business-rule violation.
    throw new HttpError(mapRaiseTo, error.message || `RPC ${name} failed`);
  }
  return Array.isArray(data) ? data : (data == null ? [] : [data]);
}

// ----------------------------------------------------------------------------
// Load the unit's target words, preserving order. Returns [] if no ids given.
// ----------------------------------------------------------------------------
async function loadWords(
  service: any,
  ids: string[],
): Promise<RequiredWord[]> {
  if (!ids || ids.length === 0) return [];
  const { data, error } = await service
    .from("words")
    .select("id,text_en,translation_ar")
    .in("id", ids);
  if (error) throw new HttpError(500, "Failed to load unit words");
  const rows: RequiredWord[] = (data ?? []) as RequiredWord[];
  // Preserve the required_word_ids order.
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((w): w is RequiredWord => !!w);
}
