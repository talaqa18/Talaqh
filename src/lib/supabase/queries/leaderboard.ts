// Leaderboard query.
// ----------------------------------------------------------------------------
// Calls the get_leaderboard RPC, which returns ONLY public-safe columns
// (rank, display_name, avatar_url, total_xp, is_me) — no PII. v1 ranks all-time
// by total_xp; `period` is a reserved hook for a future weekly board.

import { supabase } from "../client";
import type { LeaderboardPeriod } from "../types";

/** One row on the leaderboard. */
export interface LeaderboardEntry {
  rank: number;
  display_name: string | null;
  avatar_url: string | null;
  total_xp: number;
  is_me: boolean;
}

/**
 * Fetch the leaderboard. `period` defaults to all_time; `limit` caps the rows
 * (server clamps to 1..200).
 */
export async function getLeaderboard(
  period: LeaderboardPeriod = "all_time",
  limit?: number,
): Promise<LeaderboardEntry[]> {
  const { data, error } = await supabase.rpc("get_leaderboard", {
    p_period: period,
    ...(limit !== undefined ? { p_limit: limit } : {}),
  });

  if (error) throw error;
  return (data ?? []) as LeaderboardEntry[];
}
