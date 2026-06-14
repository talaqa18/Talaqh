// Reading query — القراءة.
// ----------------------------------------------------------------------------
// The unit's reading passage(s) (level-fallback aware) plus their comprehension
// questions. Like listening, only the readable question columns are returned;
// answers live in the no-select-policy answer tables and grade via grade_quiz.

import { supabase } from "../client";
import type { ContentLevel, ReadingPassageRow } from "../types";
import type { ComprehensionQuestionPublic } from "./listening";
import { pickByLevel } from "./_level";

/** One reading passage with its comprehension questions. */
export interface ReadingItem {
  passage: ReadingPassageRow;
  questions: ComprehensionQuestionPublic[];
}

const QUESTION_COLUMNS = "id, level, position, kind, prompt_ar, options";

/**
 * Load the unit's reading passage(s) with comprehension questions. When
 * `targetLevel` is provided, passages are narrowed via the level-fallback helper.
 */
export async function getReading(
  unitId: string,
  targetLevel?: ContentLevel,
): Promise<ReadingItem[]> {
  const passagesRes = await supabase
    .from("reading_passages")
    .select("*")
    .eq("unit_id", unitId)
    .eq("status", "published")
    .order("position", { ascending: true });

  if (passagesRes.error) throw passagesRes.error;

  let passages = passagesRes.data ?? [];
  if (targetLevel) passages = pickByLevel(passages, targetLevel);
  if (passages.length === 0) return [];

  const passageIds = passages.map((p) => p.id);

  const questionsRes = await supabase
    .from("comprehension_questions")
    .select(`reading_passage_id, ${QUESTION_COLUMNS}`)
    .in("reading_passage_id", passageIds)
    .eq("status", "published")
    .order("position", { ascending: true });

  if (questionsRes.error) throw questionsRes.error;

  const questionsByPassage = new Map<string, ComprehensionQuestionPublic[]>();
  for (const row of questionsRes.data ?? []) {
    const { reading_passage_id: passageId, ...question } = row;
    if (!passageId) continue;
    const list = questionsByPassage.get(passageId) ?? [];
    list.push(question);
    questionsByPassage.set(passageId, list);
  }

  return passages.map((passage) => ({
    passage,
    questions: questionsByPassage.get(passage.id) ?? [],
  }));
}
