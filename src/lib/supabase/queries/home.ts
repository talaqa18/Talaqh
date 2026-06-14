// Home query — الرئيسية.
// ----------------------------------------------------------------------------
// The signed-in user's profile summary (XP / streak / level / counts) and the
// word of the day for a given date, joined to its word, optional example, and
// the word's spoken audio path.

import { supabase } from "../client";
import type {
  ProfileRow,
  WordExampleRow,
  WordOfTheDayRow,
  WordRow,
} from "../types";

/** Word of the day, resolved to everything the Home card needs to render. */
export interface WordOfTheDay {
  entry: WordOfTheDayRow;
  word: WordRow;
  example: WordExampleRow | null;
  audioPath: string | null;
}

/**
 * The caller's profile row. Returns null if there is no row (e.g. signed out or
 * the trigger has not yet seeded it). RLS limits this to the caller's own row.
 */
export async function getProfileSummary(): Promise<ProfileRow | null> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

/**
 * The word of the day scheduled for `dateISO` (YYYY-MM-DD), with its word,
 * optional example, and the word's audio. Returns null when none is scheduled.
 */
export async function getWordOfTheDay(
  dateISO: string,
): Promise<WordOfTheDay | null> {
  // Disambiguate the example embed by its FK column (word_of_the_day.example_id).
  const { data: entry, error } = await supabase
    .from("word_of_the_day")
    .select("*, words(*), word_examples:example_id(*)")
    .eq("scheduled_for", dateISO)
    .eq("status", "published")
    .maybeSingle();

  if (error) throw error;
  if (!entry) return null;

  const joined = entry as unknown as WordOfTheDayRow & {
    words: WordRow | null;
    word_examples: WordExampleRow | null;
  };

  if (!joined.words) return null;

  // The word's spoken audio (owner_type = 'word').
  const { data: audio, error: audioError } = await supabase
    .from("audio_clips")
    .select("storage_path")
    .eq("owner_type", "word")
    .eq("owner_id", joined.words.id)
    .maybeSingle();

  if (audioError) throw audioError;

  const { words, word_examples, ...row } = joined;

  return {
    entry: row,
    word: words,
    example: word_examples,
    audioPath: audio?.storage_path ?? null,
  };
}
