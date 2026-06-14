// Conversation provider — Edge Function adapter.
// ----------------------------------------------------------------------------
// The 3-minute AI tutor (CLAUDE.md hard rule 4: reuses the unit's 5 words).
// All work happens in the `conversation` Supabase Edge Function, which holds the
// LLM key SERVER-SIDE and builds the system prompt with the target words +
// learner level/goal. This adapter NEVER references any LLM key — it only maps
// the typed request/response shapes.
//
// To swap the conversation provider, reimplement the Edge Function's `llm()`
// (see supabase/functions/conversation/index.ts) OR write a new
// ConversationProvider and register it in `src/lib/ai/index.ts`.

import { supabase } from "../supabase/client";
import type {
  ConversationFinalize,
  ConversationProvider,
  ConversationReply,
  ConversationStart,
} from "./types";

// Wire shapes returned by the Edge Function (snake_case). Mapped to the
// camelCase interface results below.
interface StartWire {
  session_id: string;
  ends_at: string;
  required_words: { id: string; text_en: string; translation_ar: string }[];
  message: string;
  translation_ar: string;
  hint_ar: string;
}
interface ReplyWire {
  message: string;
  translation_ar: string;
  hint_ar: string;
  words_used: string[] | null;
  turns_used: number | null;
}
interface FinalizeWire {
  outcome: string;
  words_used_count: number;
}

// Invoke the `conversation` function with a typed body and surface errors.
// `supabase.functions.invoke` attaches the user's JWT automatically; the
// function fails closed if unauthenticated.
async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>("conversation", {
    body,
  });
  if (error) {
    throw new Error(`conversation(${String(body.action)}) failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(`conversation(${String(body.action)}) returned no data`);
  }
  return data;
}

export const edgeConversation: ConversationProvider = {
  async start(unitId: string): Promise<ConversationStart> {
    const d = await invoke<StartWire>({ action: "start", unit_id: unitId });
    return {
      sessionId: d.session_id,
      endsAt: d.ends_at,
      requiredWords: d.required_words ?? [],
      message: d.message,
      translationAr: d.translation_ar,
      hintAr: d.hint_ar,
    };
  },

  async reply(
    sessionId: string,
    userTranscript: string,
  ): Promise<ConversationReply> {
    const d = await invoke<ReplyWire>({
      action: "reply",
      session_id: sessionId,
      user_transcript: userTranscript,
    });
    return {
      message: d.message,
      translationAr: d.translation_ar,
      hintAr: d.hint_ar,
      wordsUsed: d.words_used ?? [],
      turnsUsed: d.turns_used ?? 0,
    };
  },

  async finalize(
    sessionId: string,
    reason: "completed" | "expired" | "abandoned" = "completed",
  ): Promise<ConversationFinalize> {
    const d = await invoke<FinalizeWire>({
      action: "finalize",
      session_id: sessionId,
      reason,
    });
    return {
      outcome: d.outcome,
      wordsUsedCount: d.words_used_count,
    };
  },
};
