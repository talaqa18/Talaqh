// Grammar query — القواعد.
// ----------------------------------------------------------------------------
// The unit's grammar lesson(s) (level-fallback aware) plus the practice
// questions for each lesson. Only readable question columns are returned;
// grammar_answers has no client select policy and grading goes via grade_quiz.

import { supabase } from "../client";
import type {
  ContentLevel,
  GrammarLessonRow,
  GrammarQuestionRow,
} from "../types";
import { pickByLevel } from "./_level";

/** A grammar question exposed to the client (prompt + options only). */
export type GrammarQuestionPublic = Pick<
  GrammarQuestionRow,
  "id" | "level" | "position" | "kind" | "prompt_ar" | "options"
>;

/** One grammar lesson with its practice questions. */
export interface GrammarItem {
  lesson: GrammarLessonRow;
  questions: GrammarQuestionPublic[];
}

const QUESTION_COLUMNS = "id, level, position, kind, prompt_ar, options";

/**
 * Load the unit's grammar lesson(s) with their questions. When `targetLevel` is
 * provided, lessons are narrowed via the level-fallback helper.
 */
export async function getGrammar(
  unitId: string,
  targetLevel?: ContentLevel,
): Promise<GrammarItem[]> {
  const lessonsRes = await supabase
    .from("grammar_lessons")
    .select("*")
    .eq("unit_id", unitId)
    .eq("status", "published")
    .order("position", { ascending: true });

  if (lessonsRes.error) throw lessonsRes.error;

  let lessons = lessonsRes.data ?? [];
  if (targetLevel) lessons = pickByLevel(lessons, targetLevel);
  if (lessons.length === 0) return [];

  const lessonIds = lessons.map((l) => l.id);

  const questionsRes = await supabase
    .from("grammar_questions")
    .select(`grammar_lesson_id, ${QUESTION_COLUMNS}`)
    .in("grammar_lesson_id", lessonIds)
    .eq("status", "published")
    .order("position", { ascending: true });

  if (questionsRes.error) throw questionsRes.error;

  const questionsByLesson = new Map<string, GrammarQuestionPublic[]>();
  for (const row of questionsRes.data ?? []) {
    const { grammar_lesson_id: lessonId, ...question } = row;
    if (!lessonId) continue;
    const list = questionsByLesson.get(lessonId) ?? [];
    list.push(question);
    questionsByLesson.set(lessonId, list);
  }

  return lessons.map((lesson) => ({
    lesson,
    questions: questionsByLesson.get(lesson.id) ?? [],
  }));
}
