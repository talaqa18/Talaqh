// Word-teaching query — the unit's 5 words + their examples + audio.
// ----------------------------------------------------------------------------
// Drives the teaching screen and the three word quizzes (spelling /
// pronunciation / meaning). Enforces unit-word reuse (CLAUDE.md rule 4): the
// words come from unit_words for THIS unit, ordered by position. Each word
// carries its (level-filtered) examples and the storage paths for the word's
// own audio + each example's audio (audio_clips by owner_type/owner_id).

import { supabase } from "../client";
import type { ContentLevel, WordExampleRow, WordRow } from "../types";
import { pickByLevel } from "./_level";

/** A word example plus the storage path of its spoken audio (if any). */
export interface TeachingExample {
  example: WordExampleRow;
  audioPath: string | null;
}

/** One taught word: the word row, its examples, and the word's audio path. */
export interface TeachingWord {
  word: WordRow;
  position: number;
  audioPath: string | null;
  examples: TeachingExample[];
}

/** The shuffled meaning multiple-choice payload from build_meaning_quiz. */
export interface MeaningQuiz {
  word_id: string;
  text_en: string;
  phonetic: string | null;
  options: string[];
}

/**
 * Load the 5 unit words (ordered by unit_words.position) with their examples
 * and audio. When `targetLevel` is provided, each word's examples are filtered
 * with the level-fallback helper so an advanced learner still gets simpler
 * examples when no higher-level variant exists.
 */
export async function getUnitWords(
  unitId: string,
  targetLevel?: ContentLevel,
): Promise<TeachingWord[]> {
  // 1) The unit's words in order.
  const unitWordsRes = await supabase
    .from("unit_words")
    .select("word_id, position, words(*)")
    .eq("unit_id", unitId)
    .order("position", { ascending: true });

  if (unitWordsRes.error) throw unitWordsRes.error;

  const unitWords = (unitWordsRes.data ?? []) as unknown as Array<{
    word_id: string;
    position: number;
    words: WordRow | null;
  }>;

  const wordIds = unitWords
    .map((uw) => uw.word_id)
    .filter((id): id is string => Boolean(id));

  if (wordIds.length === 0) return [];

  // 2) All examples for those words (published), then 3) audio for words +
  //    examples — fetched in parallel.
  const examplesRes = await supabase
    .from("word_examples")
    .select("*")
    .in("word_id", wordIds)
    .eq("status", "published")
    .order("position", { ascending: true });

  if (examplesRes.error) throw examplesRes.error;
  const allExamples = examplesRes.data ?? [];
  const exampleIds = allExamples.map((ex) => ex.id);

  const [wordAudioRes, exampleAudioRes] = await Promise.all([
    supabase
      .from("audio_clips")
      .select("owner_id, storage_path")
      .eq("owner_type", "word")
      .in("owner_id", wordIds),
    exampleIds.length
      ? supabase
          .from("audio_clips")
          .select("owner_id, storage_path")
          .eq("owner_type", "word_example")
          .in("owner_id", exampleIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (wordAudioRes.error) throw wordAudioRes.error;
  if (exampleAudioRes.error) throw exampleAudioRes.error;

  const wordAudio = new Map<string, string>(
    (wordAudioRes.data ?? []).map((a) => [a.owner_id, a.storage_path]),
  );
  const exampleAudio = new Map<string, string>(
    (exampleAudioRes.data ?? []).map((a) => [a.owner_id, a.storage_path]),
  );

  // Group examples by word, applying the level fallback when a target is given.
  const examplesByWord = new Map<string, WordExampleRow[]>();
  for (const ex of allExamples) {
    const list = examplesByWord.get(ex.word_id) ?? [];
    list.push(ex);
    examplesByWord.set(ex.word_id, list);
  }

  return unitWords
    .filter((uw): uw is typeof uw & { words: WordRow } => Boolean(uw.words))
    .map((uw) => {
      let examples = examplesByWord.get(uw.word_id) ?? [];
      if (targetLevel) examples = pickByLevel(examples, targetLevel);

      return {
        word: uw.words,
        position: uw.position,
        audioPath: wordAudio.get(uw.word_id) ?? null,
        examples: examples.map((example) => ({
          example,
          audioPath: exampleAudio.get(example.id) ?? null,
        })),
      };
    });
}

/**
 * Build the meaning multiple-choice for a word. The correct option index is NOT
 * returned by the RPC (grading happens server-side in grade_quiz).
 */
export async function getMeaningQuiz(wordId: string): Promise<MeaningQuiz> {
  const { data, error } = await supabase.rpc("build_meaning_quiz", {
    p_word_id: wordId,
  });
  if (error) throw error;
  return data as unknown as MeaningQuiz;
}
