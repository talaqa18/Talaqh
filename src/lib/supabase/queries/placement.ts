// Placement query — the placement test.
// ----------------------------------------------------------------------------
// Lists the placement questions (prompt + options only — the answer keys live
// in placement_answer_keys with no client select policy) and submits the user's
// answers for server-side grading via score_placement.

import { supabase } from "../client";
import type { ContentLevel, Json, PlacementQuestionRow } from "../types";

/** A placement question exposed to the client (prompt + options only). */
export type PlacementQuestionPublic = Pick<
  PlacementQuestionRow,
  "id" | "level" | "position" | "kind" | "prompt_ar" | "options"
>;

/** One submitted placement answer (matches score_placement's expected shape). */
export interface PlacementAnswer {
  question_id: string;
  selected_option_index?: number | null;
  text_response?: string | null;
}

/** The graded placement outcome returned by score_placement. */
export interface PlacementResult {
  determined_level: ContentLevel;
  is_complete_beginner: boolean;
  recommended_start_unit_id: string | null;
  score: number;
  total: number;
}

/** Load every published placement question in order. */
export async function getPlacementQuestions(): Promise<
  PlacementQuestionPublic[]
> {
  const { data, error } = await supabase
    .from("placement_questions")
    .select("id, level, position, kind, prompt_ar, options")
    .eq("status", "published")
    .order("position", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * Submit the placement answers for server-side grading. Returns the determined
 * level, beginner flag, and recommended starting unit.
 */
export async function submitPlacement(
  answers: PlacementAnswer[],
): Promise<PlacementResult> {
  const { data, error } = await supabase.rpc("score_placement", {
    answers: answers as unknown as Json,
  });
  if (error) throw error;
  return data as unknown as PlacementResult;
}
