// Level ranking + fallback helper (mirrors SQL app_level_rank / the content
// fallback used by the RPC layer).
// ----------------------------------------------------------------------------
// Content is authored at a CEFR-ish level (beginner < A1 < … < C1). When we
// fetch content for a user at a desired level we want the rows authored at the
// HIGHEST level that is still <= the desired level (so a B1 learner sees A2/A1
// content if no B1 variant exists). When NO row qualifies (e.g. only higher
// levels exist), we fall back to returning every row so the screen is never
// empty. This mirrors the server-side `app_level_rank` ordering.

import type { ContentLevel } from "../types";

/** Numeric rank of each content level. Higher = more advanced. */
export const LEVEL_RANK: Record<ContentLevel, number> = {
  beginner: 0,
  A1: 1,
  A2: 2,
  B1: 3,
  B2: 4,
  C1: 5,
};

/**
 * Pick the rows at the highest level that is still <= `desired`. If no row sits
 * at or below the desired level, return all rows unchanged (never empty out a
 * screen). Operates on any row carrying a `level: ContentLevel` field.
 */
export function pickByLevel<T extends { level: ContentLevel }>(
  rows: T[],
  desired: ContentLevel,
): T[] {
  const desiredRank = LEVEL_RANK[desired];

  // Find the best (highest) authored level that does not exceed the desired one.
  let bestRank = -1;
  for (const row of rows) {
    const rank = LEVEL_RANK[row.level];
    if (rank <= desiredRank && rank > bestRank) {
      bestRank = rank;
    }
  }

  if (bestRank === -1) {
    // Nothing at/below the desired level — fall back to all rows.
    return rows;
  }

  return rows.filter((row) => LEVEL_RANK[row.level] === bestRank);
}
