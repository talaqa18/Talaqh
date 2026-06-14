// Listening query — الاستماع.
// ----------------------------------------------------------------------------
// One clip per screen: each listening_clip for the unit (level-fallback aware)
// with its audio storage path and its comprehension questions. We read ONLY the
// readable question columns (prompt_ar + options) — the answer tables have no
// client select policy and grading goes through grade_quiz.

import { supabase } from "../client";
import type {
  ComprehensionQuestionRow,
  ContentLevel,
  ListeningClipRow,
} from "../types";
import { pickByLevel } from "./_level";

/** A comprehension question exposed to the client (prompt + options only). */
export type ComprehensionQuestionPublic = Pick<
  ComprehensionQuestionRow,
  "id" | "level" | "position" | "kind" | "prompt_ar" | "options"
>;

/** One listening clip: the row, its audio path, and its questions. */
export interface ListeningItem {
  clip: ListeningClipRow;
  audioPath: string | null;
  questions: ComprehensionQuestionPublic[];
}

const QUESTION_COLUMNS = "id, level, position, kind, prompt_ar, options";

/**
 * Load the unit's listening clips with audio + comprehension questions. When
 * `targetLevel` is provided, clips are narrowed via the level-fallback helper.
 */
export async function getListening(
  unitId: string,
  targetLevel?: ContentLevel,
): Promise<ListeningItem[]> {
  const clipsRes = await supabase
    .from("listening_clips")
    .select("*")
    .eq("unit_id", unitId)
    .eq("status", "published")
    .order("position", { ascending: true });

  if (clipsRes.error) throw clipsRes.error;

  let clips = clipsRes.data ?? [];
  if (targetLevel) clips = pickByLevel(clips, targetLevel);
  if (clips.length === 0) return [];

  const clipIds = clips.map((c) => c.id);

  // We include listening_clip_id in the select (for grouping) on top of the
  // public projection, then strip it when building each item.
  const [audioRes, questionsRes] = await Promise.all([
    supabase
      .from("audio_clips")
      .select("owner_id, storage_path")
      .eq("owner_type", "listening_clip")
      .in("owner_id", clipIds),
    supabase
      .from("comprehension_questions")
      .select(`listening_clip_id, ${QUESTION_COLUMNS}`)
      .in("listening_clip_id", clipIds)
      .eq("status", "published")
      .order("position", { ascending: true }),
  ]);

  if (audioRes.error) throw audioRes.error;
  if (questionsRes.error) throw questionsRes.error;

  const audioByClip = new Map<string, string>(
    (audioRes.data ?? []).map((a) => [a.owner_id, a.storage_path]),
  );

  const questionsByClip = new Map<string, ComprehensionQuestionPublic[]>();
  for (const row of questionsRes.data ?? []) {
    const { listening_clip_id: clipId, ...question } = row;
    if (!clipId) continue;
    const list = questionsByClip.get(clipId) ?? [];
    list.push(question);
    questionsByClip.set(clipId, list);
  }

  return clips.map((clip) => ({
    clip,
    audioPath: audioByClip.get(clip.id) ?? null,
    questions: questionsByClip.get(clip.id) ?? [],
  }));
}
