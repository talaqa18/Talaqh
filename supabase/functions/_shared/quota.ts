// Per-user daily AI quota enforcement (integrity rule 7 / abuse control).
// ----------------------------------------------------------------------------
// The ai_usage table (0004) is the per-user daily ledger; its rows are TRUSTED
// (guard trigger requires app.trusted='on'). We therefore do NOT write it
// directly — we call the SECURITY DEFINER RPC `ai_usage_check_and_increment`
// (migration 0010) which:
//   * resolves usage_date in the user's timezone (from user_settings),
//   * UPSERTs the (user_id, kind, usage_date) row,
//   * atomically increments count IFF it would stay <= the cap for that kind,
//   * returns { allowed, count, cap }.
//
// DEFAULT daily caps (DECISIONS.md) live in the RPC so client and server can
// never disagree; we mirror them here only for typing / messages.
// deno-lint-ignore-file no-explicit-any

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { HttpError } from "./auth.ts";

export type AiUsageKind =
  | "conversation_session"
  | "speech_token_mint"
  | "stt"
  | "tts_fallback"
  | "generate_lesson"
  | "tts";

/** DEFAULT daily caps — must match migration 0010 + 0015. */
export const DAILY_CAPS: Record<AiUsageKind, number> = {
  conversation_session: 20,
  speech_token_mint: 200,
  stt: 200,
  tts_fallback: 100,
  generate_lesson: 100,
  tts: 800,
};

export interface QuotaResult {
  allowed: boolean;
  count: number;
  cap: number;
}

/**
 * Check + atomically increment the caller's daily quota for `kind`. Returns the
 * post-increment state. Throws HttpError(429) when the cap is reached (so the
 * function fails closed before doing any paid work).
 *
 * Pass the SERVICE-ROLE client (the RPC is SECURITY DEFINER but we still invoke
 * it with the service role to bypass RLS on ai_usage cleanly).
 */
export async function checkAndIncrement(
  service: SupabaseClient,
  userId: string,
  kind: AiUsageKind,
): Promise<QuotaResult> {
  const { data, error } = await service.rpc("ai_usage_check_and_increment", {
    p_user_id: userId,
    p_kind: kind,
  });

  if (error) {
    // A DB error here must NOT silently allow the action — fail closed.
    throw new HttpError(503, `Quota check failed: ${error.message}`);
  }

  // The RPC returns a single row (setof / table). Normalize.
  const row = Array.isArray(data) ? data[0] : data;
  const result: QuotaResult = {
    allowed: Boolean(row?.allowed),
    count: Number(row?.count ?? 0),
    cap: Number(row?.cap ?? DAILY_CAPS[kind]),
  };

  if (!result.allowed) {
    throw new HttpError(
      429,
      `Daily limit reached for ${kind} (${result.cap}/day). Try again tomorrow.`,
    );
  }

  return result;
}
