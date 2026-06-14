// Progress mutations — the ONLY write path for trusted columns.
// ----------------------------------------------------------------------------
// Every function here is a thin, typed wrapper over a SECURITY DEFINER RPC. The
// client NEVER updates trusted columns (XP, pass flags, learned, unit status,
// streak …) directly — those writes are rejected by guard triggers and only
// these RPCs may flip `app.trusted`. Each wrapper throws on error and returns
// the parsed RPC result.

import { supabase } from "../client";
import type { Json, QuizKind, UnitSection } from "../types";

// ---- grade_quiz ------------------------------------------------------------

/** Arguments for grading a spelling / meaning / full_words / grammar quiz. */
export interface GradeQuizArgs {
  quizType: QuizKind;
  /** Required for grammar / full_words(question-style). */
  questionId?: string;
  /** { selected_option_index } or { text_response }. */
  userAnswer: Json;
  unitId?: string;
  /** Required for spelling / meaning. */
  wordId?: string;
}

/** Server-graded quiz result. */
export interface GradeQuizResult {
  correct: boolean;
  score: number;
  xp_awarded: number;
  learned: boolean;
}

/** Grade a (non-pronunciation) quiz server-side. */
export async function gradeQuiz(
  args: GradeQuizArgs,
): Promise<GradeQuizResult> {
  const { data, error } = await supabase.rpc("grade_quiz", {
    p_quiz_type: args.quizType,
    p_question_id: args.questionId,
    p_user_answer: args.userAnswer,
    p_unit_id: args.unitId,
    p_word_id: args.wordId,
  });
  if (error) throw error;
  return data as unknown as GradeQuizResult;
}

// ---- record_pronunciation --------------------------------------------------

/** Arguments for recording a pronunciation attempt (server decides passed). */
export interface RecordPronunciationArgs {
  wordId: string;
  unitId: string;
  /** Overall score 0..100 from the assessment provider. */
  score: number;
  accuracy?: number;
  fluency?: number;
  /** Phoneme-level error detail (highlighted in the UI). */
  phonemes?: Json;
  recordingPath?: string;
}

/** Server-decided pronunciation result. */
export interface RecordPronunciationResult {
  passed: boolean;
  score: number;
  best: number;
  attempt_no: number;
  learned: boolean;
  xp_awarded: number;
}

/** Record a pronunciation attempt. The server decides passed = score >= 70. */
export async function recordPronunciation(
  args: RecordPronunciationArgs,
): Promise<RecordPronunciationResult> {
  const { data, error } = await supabase.rpc("record_pronunciation", {
    p_word_id: args.wordId,
    p_unit_id: args.unitId,
    p_score: args.score,
    p_accuracy: args.accuracy,
    p_fluency: args.fluency,
    p_phonemes: args.phonemes,
    p_recording_path: args.recordingPath,
  });
  if (error) throw error;
  return data as unknown as RecordPronunciationResult;
}

// ---- advance_position ------------------------------------------------------

/** Arguments for saving the user's resume point (UI pointer; never unlocks). */
export interface AdvancePositionArgs {
  unitId: string;
  step: UnitSection;
  /** 1..5 when inside the words section. */
  wordPosition?: number;
  subScreen?: string;
}

/** Save the user's resume point inside a unit. Returns nothing. */
export async function advancePosition(
  args: AdvancePositionArgs,
): Promise<void> {
  const { error } = await supabase.rpc("advance_position", {
    p_unit_id: args.unitId,
    p_step: args.step,
    p_word_position: args.wordPosition,
    p_sub_screen: args.subScreen,
  });
  if (error) throw error;
}

// ---- complete_section ------------------------------------------------------

/** Result of marking a section complete. */
export interface CompleteSectionResult {
  section: UnitSection;
  xp_awarded: number;
}

/** Mark one unit section complete (and award its XP idempotently). */
export async function completeSection(
  unitId: string,
  section: UnitSection,
): Promise<CompleteSectionResult> {
  const { data, error } = await supabase.rpc("complete_section", {
    p_unit_id: unitId,
    p_section: section,
  });
  if (error) throw error;
  return data as unknown as CompleteSectionResult;
}

// ---- complete_unit ---------------------------------------------------------

/** Result of completing a unit (server verifies all sections first). */
export interface CompleteUnitResult {
  completed: boolean;
  just_completed: boolean;
  xp_awarded: number;
  next_unit_id: string | null;
}

/** Complete a unit: server checks all five section flags, unlocks the next. */
export async function completeUnit(
  unitId: string,
): Promise<CompleteUnitResult> {
  const { data, error } = await supabase.rpc("complete_unit", {
    p_unit_id: unitId,
  });
  if (error) throw error;
  return data as unknown as CompleteUnitResult;
}

// ---- touch_streak ----------------------------------------------------------

/** Result of touching today's streak. */
export interface TouchStreakResult {
  today: string;
  current_streak_days: number;
  longest_streak_days: number;
  bonus_awarded: number;
}

/** Register today's activity for the streak (idempotent per local day). */
export async function touchStreak(): Promise<TouchStreakResult> {
  const { data, error } = await supabase.rpc("touch_streak", {});
  if (error) throw error;
  return data as unknown as TouchStreakResult;
}
