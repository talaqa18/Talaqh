// Supabase Database types — HAND-WRITTEN.
// ----------------------------------------------------------------------------
// `supabase gen types typescript` requires a live database (or local CLI +
// Docker). This project's schema is fully defined by the SQL migrations in
// `supabase/migrations/0001..0005`, so we mirror it here BY HAND. Keep this file
// in lockstep with those migrations: it is the single typed contract the client
// query/RPC layer relies on.
//
// Shape conventions follow the official supabase-js generated output so that a
// future `gen types` run is a drop-in replacement:
//   Database["public"]["Tables"][<table>]["Row" | "Insert" | "Update"]
//   Database["public"]["Enums"][<enum>]
//   Database["public"]["Functions"][<rpc>]
//
// `Json` mirrors the supabase-js generated alias for jsonb columns.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// ============================================================================
// ENUMS (0001_enums.sql) — singular type names.
// ============================================================================
export type ContentLevel = "beginner" | "A1" | "A2" | "B1" | "B2" | "C1";
export type UserLevel = "beginner" | "A1" | "A2" | "B1" | "B2" | "C1";
export type LearningGoal = "travel" | "work" | "study_abroad" | "daily_conversation";
export type ContentStatus = "draft" | "published" | "archived";
export type ProgressStatus = "locked" | "in_progress" | "completed";
export type UnitSection = "words" | "listening" | "reading" | "conversation" | "grammar";
export type QuizKind = "spelling" | "pronunciation" | "meaning" | "full_words" | "grammar";
export type QuestionKind = "multiple_choice" | "text_input";
export type MessageRole = "assistant" | "user";
export type ConversationOutcome =
  | "in_progress"
  | "success"
  | "incomplete"
  | "expired"
  | "abandoned";
export type XpSourceType =
  | "word_quiz_pass"
  | "full_words_quiz"
  | "listening"
  | "reading"
  | "grammar_quiz"
  | "conversation"
  | "unit_complete"
  | "streak_daily_bonus"
  | "foundations_lesson"
  | "placement";
export type AudioOwnerType = "word" | "word_example" | "listening_clip" | "word_of_the_day";
export type LeaderboardPeriod = "all_time" | "weekly";
export type SubscriptionTier = "free" | "premium";
export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "expired";
export type DevicePlatform = "ios" | "android" | "web";
export type AiUsageKind =
  | "conversation_session"
  | "speech_token_mint"
  | "stt"
  | "tts_fallback";

// ============================================================================
// Database — the generated-shape root.
// ============================================================================
export interface Database {
  public: {
    Tables: {
      // ----------------------------------------------------------------------
      // CONTENT (0002_content_tables.sql)
      // ----------------------------------------------------------------------
      units: {
        Row: {
          id: string;
          position: number;
          level: ContentLevel;
          slug: string;
          title_ar: string;
          subtitle_ar: string | null;
          description_ar: string | null;
          status: ContentStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          position: number;
          level: ContentLevel;
          slug: string;
          title_ar: string;
          subtitle_ar?: string | null;
          description_ar?: string | null;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          position?: number;
          level?: ContentLevel;
          slug?: string;
          title_ar?: string;
          subtitle_ar?: string | null;
          description_ar?: string | null;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      words: {
        Row: {
          id: string;
          level: ContentLevel;
          text_en: string;
          phonetic: string | null;
          translation_ar: string;
          part_of_speech: string | null;
          status: ContentStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          level: ContentLevel;
          text_en: string;
          phonetic?: string | null;
          translation_ar: string;
          part_of_speech?: string | null;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          level?: ContentLevel;
          text_en?: string;
          phonetic?: string | null;
          translation_ar?: string;
          part_of_speech?: string | null;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      unit_words: {
        Row: {
          unit_id: string;
          word_id: string;
          position: number;
          created_at: string;
        };
        Insert: {
          unit_id: string;
          word_id: string;
          position: number;
          created_at?: string;
        };
        Update: {
          unit_id?: string;
          word_id?: string;
          position?: number;
          created_at?: string;
        };
        Relationships: [
          { foreignKeyName: "unit_words_unit_id_fkey"; columns: ["unit_id"]; referencedRelation: "units"; referencedColumns: ["id"] },
          { foreignKeyName: "unit_words_word_id_fkey"; columns: ["word_id"]; referencedRelation: "words"; referencedColumns: ["id"] },
        ];
      };

      word_examples: {
        Row: {
          id: string;
          word_id: string;
          level: ContentLevel;
          sentence_en: string;
          translation_ar: string;
          position: number;
          status: ContentStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          word_id: string;
          level: ContentLevel;
          sentence_en: string;
          translation_ar: string;
          position?: number;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          word_id?: string;
          level?: ContentLevel;
          sentence_en?: string;
          translation_ar?: string;
          position?: number;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "word_examples_word_id_fkey"; columns: ["word_id"]; referencedRelation: "words"; referencedColumns: ["id"] },
        ];
      };

      audio_clips: {
        Row: {
          id: string;
          owner_type: AudioOwnerType;
          owner_id: string;
          storage_path: string;
          duration_ms: number | null;
          voice: string | null;
          status: ContentStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          owner_type: AudioOwnerType;
          owner_id: string;
          storage_path: string;
          duration_ms?: number | null;
          voice?: string | null;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          owner_type?: AudioOwnerType;
          owner_id?: string;
          storage_path?: string;
          duration_ms?: number | null;
          voice?: string | null;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      listening_clips: {
        Row: {
          id: string;
          unit_id: string;
          level: ContentLevel;
          position: number;
          transcript_en: string;
          translation_ar: string;
          status: ContentStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          unit_id: string;
          level: ContentLevel;
          position: number;
          transcript_en: string;
          translation_ar: string;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          unit_id?: string;
          level?: ContentLevel;
          position?: number;
          transcript_en?: string;
          translation_ar?: string;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "listening_clips_unit_id_fkey"; columns: ["unit_id"]; referencedRelation: "units"; referencedColumns: ["id"] },
        ];
      };

      reading_passages: {
        Row: {
          id: string;
          unit_id: string;
          level: ContentLevel;
          position: number;
          title_en: string | null;
          body_en: string;
          translation_ar: string;
          status: ContentStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          unit_id: string;
          level: ContentLevel;
          position?: number;
          title_en?: string | null;
          body_en: string;
          translation_ar: string;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          unit_id?: string;
          level?: ContentLevel;
          position?: number;
          title_en?: string | null;
          body_en?: string;
          translation_ar?: string;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "reading_passages_unit_id_fkey"; columns: ["unit_id"]; referencedRelation: "units"; referencedColumns: ["id"] },
        ];
      };

      // READABLE prompt + options ONLY. Correct answers live in
      // comprehension_answers (NO client select policy).
      comprehension_questions: {
        Row: {
          id: string;
          listening_clip_id: string | null;
          reading_passage_id: string | null;
          level: ContentLevel;
          position: number;
          kind: QuestionKind;
          prompt_ar: string;
          options: Json | null;
          status: ContentStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          listening_clip_id?: string | null;
          reading_passage_id?: string | null;
          level: ContentLevel;
          position: number;
          kind?: QuestionKind;
          prompt_ar: string;
          options?: Json | null;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          listening_clip_id?: string | null;
          reading_passage_id?: string | null;
          level?: ContentLevel;
          position?: number;
          kind?: QuestionKind;
          prompt_ar?: string;
          options?: Json | null;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "comprehension_questions_listening_clip_id_fkey"; columns: ["listening_clip_id"]; referencedRelation: "listening_clips"; referencedColumns: ["id"] },
          { foreignKeyName: "comprehension_questions_reading_passage_id_fkey"; columns: ["reading_passage_id"]; referencedRelation: "reading_passages"; referencedColumns: ["id"] },
        ];
      };

      // ** ANSWER TABLE — NO client select policy. ** Typed for the grading
      // DEFINER RPC's perspective; client reads will be denied by RLS.
      comprehension_answers: {
        Row: {
          question_id: string;
          correct_option_index: number | null;
          accepted_answers: Json | null;
          explanation_ar: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          question_id: string;
          correct_option_index?: number | null;
          accepted_answers?: Json | null;
          explanation_ar?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          question_id?: string;
          correct_option_index?: number | null;
          accepted_answers?: Json | null;
          explanation_ar?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "comprehension_answers_question_id_fkey"; columns: ["question_id"]; referencedRelation: "comprehension_questions"; referencedColumns: ["id"] },
        ];
      };

      grammar_lessons: {
        Row: {
          id: string;
          unit_id: string;
          level: ContentLevel;
          position: number;
          title_ar: string;
          explanation_ar: string;
          examples: Json | null;
          status: ContentStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          unit_id: string;
          level: ContentLevel;
          position?: number;
          title_ar: string;
          explanation_ar: string;
          examples?: Json | null;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          unit_id?: string;
          level?: ContentLevel;
          position?: number;
          title_ar?: string;
          explanation_ar?: string;
          examples?: Json | null;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "grammar_lessons_unit_id_fkey"; columns: ["unit_id"]; referencedRelation: "units"; referencedColumns: ["id"] },
        ];
      };

      grammar_questions: {
        Row: {
          id: string;
          grammar_lesson_id: string;
          level: ContentLevel;
          position: number;
          kind: QuestionKind;
          prompt_ar: string;
          options: Json | null;
          status: ContentStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          grammar_lesson_id: string;
          level: ContentLevel;
          position: number;
          kind?: QuestionKind;
          prompt_ar: string;
          options?: Json | null;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          grammar_lesson_id?: string;
          level?: ContentLevel;
          position?: number;
          kind?: QuestionKind;
          prompt_ar?: string;
          options?: Json | null;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "grammar_questions_grammar_lesson_id_fkey"; columns: ["grammar_lesson_id"]; referencedRelation: "grammar_lessons"; referencedColumns: ["id"] },
        ];
      };

      // ** ANSWER TABLE — NO client select policy. **
      grammar_answers: {
        Row: {
          question_id: string;
          correct_option_index: number | null;
          accepted_answers: Json | null;
          explanation_ar: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          question_id: string;
          correct_option_index?: number | null;
          accepted_answers?: Json | null;
          explanation_ar?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          question_id?: string;
          correct_option_index?: number | null;
          accepted_answers?: Json | null;
          explanation_ar?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "grammar_answers_question_id_fkey"; columns: ["question_id"]; referencedRelation: "grammar_questions"; referencedColumns: ["id"] },
        ];
      };

      placement_questions: {
        Row: {
          id: string;
          level: ContentLevel;
          position: number;
          kind: QuestionKind;
          prompt_ar: string;
          options: Json | null;
          status: ContentStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          level: ContentLevel;
          position: number;
          kind?: QuestionKind;
          prompt_ar: string;
          options?: Json | null;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          level?: ContentLevel;
          position?: number;
          kind?: QuestionKind;
          prompt_ar?: string;
          options?: Json | null;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      // ** ANSWER TABLE — NO client select policy. **
      placement_answer_keys: {
        Row: {
          question_id: string;
          correct_option_index: number | null;
          accepted_answers: Json | null;
          awards_level: ContentLevel | null;
          weight: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          question_id: string;
          correct_option_index?: number | null;
          accepted_answers?: Json | null;
          awards_level?: ContentLevel | null;
          weight?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          question_id?: string;
          correct_option_index?: number | null;
          accepted_answers?: Json | null;
          awards_level?: ContentLevel | null;
          weight?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "placement_answer_keys_question_id_fkey"; columns: ["question_id"]; referencedRelation: "placement_questions"; referencedColumns: ["id"] },
        ];
      };

      foundations_lessons: {
        Row: {
          id: string;
          level: ContentLevel;
          position: number;
          kind: string;
          title_ar: string;
          body_ar: string | null;
          letter_or_word: string | null;
          status: ContentStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          level?: ContentLevel;
          position: number;
          kind: string;
          title_ar: string;
          body_ar?: string | null;
          letter_or_word?: string | null;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          level?: ContentLevel;
          position?: number;
          kind?: string;
          title_ar?: string;
          body_ar?: string | null;
          letter_or_word?: string | null;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      // --- Unit-word-reuse join tables (composite FK -> unit_words) ----------
      listening_clip_words: {
        Row: {
          listening_clip_id: string;
          unit_id: string;
          word_id: string;
        };
        Insert: {
          listening_clip_id: string;
          unit_id: string;
          word_id: string;
        };
        Update: {
          listening_clip_id?: string;
          unit_id?: string;
          word_id?: string;
        };
        Relationships: [
          { foreignKeyName: "listening_clip_words_listening_clip_id_fkey"; columns: ["listening_clip_id"]; referencedRelation: "listening_clips"; referencedColumns: ["id"] },
          { foreignKeyName: "listening_clip_words_unit_word_fk"; columns: ["unit_id", "word_id"]; referencedRelation: "unit_words"; referencedColumns: ["unit_id", "word_id"] },
        ];
      };

      reading_passage_words: {
        Row: {
          reading_passage_id: string;
          unit_id: string;
          word_id: string;
        };
        Insert: {
          reading_passage_id: string;
          unit_id: string;
          word_id: string;
        };
        Update: {
          reading_passage_id?: string;
          unit_id?: string;
          word_id?: string;
        };
        Relationships: [
          { foreignKeyName: "reading_passage_words_reading_passage_id_fkey"; columns: ["reading_passage_id"]; referencedRelation: "reading_passages"; referencedColumns: ["id"] },
          { foreignKeyName: "reading_passage_words_unit_word_fk"; columns: ["unit_id", "word_id"]; referencedRelation: "unit_words"; referencedColumns: ["unit_id", "word_id"] },
        ];
      };

      grammar_lesson_words: {
        Row: {
          grammar_lesson_id: string;
          unit_id: string;
          word_id: string;
        };
        Insert: {
          grammar_lesson_id: string;
          unit_id: string;
          word_id: string;
        };
        Update: {
          grammar_lesson_id?: string;
          unit_id?: string;
          word_id?: string;
        };
        Relationships: [
          { foreignKeyName: "grammar_lesson_words_grammar_lesson_id_fkey"; columns: ["grammar_lesson_id"]; referencedRelation: "grammar_lessons"; referencedColumns: ["id"] },
          { foreignKeyName: "grammar_lesson_words_unit_word_fk"; columns: ["unit_id", "word_id"]; referencedRelation: "unit_words"; referencedColumns: ["unit_id", "word_id"] },
        ];
      };

      grammar_question_words: {
        Row: {
          grammar_question_id: string;
          unit_id: string;
          word_id: string;
        };
        Insert: {
          grammar_question_id: string;
          unit_id: string;
          word_id: string;
        };
        Update: {
          grammar_question_id?: string;
          unit_id?: string;
          word_id?: string;
        };
        Relationships: [
          { foreignKeyName: "grammar_question_words_grammar_question_id_fkey"; columns: ["grammar_question_id"]; referencedRelation: "grammar_questions"; referencedColumns: ["id"] },
          { foreignKeyName: "grammar_question_words_unit_word_fk"; columns: ["unit_id", "word_id"]; referencedRelation: "unit_words"; referencedColumns: ["unit_id", "word_id"] },
        ];
      };

      conversation_required_words: {
        Row: {
          unit_id: string;
          word_id: string;
        };
        Insert: {
          unit_id: string;
          word_id: string;
        };
        Update: {
          unit_id?: string;
          word_id?: string;
        };
        Relationships: [
          { foreignKeyName: "conversation_required_words_unit_word_fk"; columns: ["unit_id", "word_id"]; referencedRelation: "unit_words"; referencedColumns: ["unit_id", "word_id"] },
        ];
      };

      // ----------------------------------------------------------------------
      // USER (0003_user_tables.sql)
      // ----------------------------------------------------------------------
      profiles: {
        Row: {
          id: string;
          email: string | null;
          display_name: string | null;
          avatar_url: string | null;
          age: number | null;
          goal: LearningGoal | null;
          // TRUSTED — readable, but writes rejected by guard triggers.
          current_level: UserLevel;
          total_xp: number;
          current_streak_days: number;
          longest_streak_days: number;
          words_learned_count: number;
          last_activity_date: string | null;
          onboarding_completed: boolean;
          placement_completed: boolean;
          foundations_completed: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          email?: string | null;
          display_name?: string | null;
          avatar_url?: string | null;
          age?: number | null;
          goal?: LearningGoal | null;
          // Untrusted inserts MUST keep these at their safe defaults.
          current_level?: UserLevel;
          total_xp?: number;
          current_streak_days?: number;
          longest_streak_days?: number;
          words_learned_count?: number;
          last_activity_date?: string | null;
          onboarding_completed?: boolean;
          placement_completed?: boolean;
          foundations_completed?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string | null;
          display_name?: string | null;
          avatar_url?: string | null;
          age?: number | null;
          goal?: LearningGoal | null;
          current_level?: UserLevel;
          total_xp?: number;
          current_streak_days?: number;
          longest_streak_days?: number;
          words_learned_count?: number;
          last_activity_date?: string | null;
          onboarding_completed?: boolean;
          placement_completed?: boolean;
          foundations_completed?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      onboarding_responses: {
        Row: {
          id: string;
          user_id: string;
          display_name: string | null;
          age: number | null;
          native_language: string;
          goal: LearningGoal | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          display_name?: string | null;
          age?: number | null;
          native_language?: string;
          goal?: LearningGoal | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          display_name?: string | null;
          age?: number | null;
          native_language?: string;
          goal?: LearningGoal | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "onboarding_responses_user_id_fkey"; columns: ["user_id"]; referencedRelation: "profiles"; referencedColumns: ["id"] },
        ];
      };

      placement_answers: {
        Row: {
          id: string;
          user_id: string;
          question_id: string;
          selected_option_index: number | null;
          text_response: string | null;
          is_correct: boolean | null; // TRUSTED
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          question_id: string;
          selected_option_index?: number | null;
          text_response?: string | null;
          is_correct?: boolean | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          question_id?: string;
          selected_option_index?: number | null;
          text_response?: string | null;
          is_correct?: boolean | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "placement_answers_user_id_fkey"; columns: ["user_id"]; referencedRelation: "profiles"; referencedColumns: ["id"] },
          { foreignKeyName: "placement_answers_question_id_fkey"; columns: ["question_id"]; referencedRelation: "placement_questions"; referencedColumns: ["id"] },
        ];
      };

      foundations_progress: {
        Row: {
          id: string;
          user_id: string;
          lesson_id: string;
          completed: boolean; // TRUSTED
          completed_at: string | null; // TRUSTED
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          lesson_id: string;
          completed?: boolean;
          completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          lesson_id?: string;
          completed?: boolean;
          completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "foundations_progress_user_id_fkey"; columns: ["user_id"]; referencedRelation: "profiles"; referencedColumns: ["id"] },
          { foreignKeyName: "foundations_progress_lesson_id_fkey"; columns: ["lesson_id"]; referencedRelation: "foundations_lessons"; referencedColumns: ["id"] },
        ];
      };

      unit_progress: {
        Row: {
          id: string;
          user_id: string;
          unit_id: string;
          status: ProgressStatus; // TRUSTED
          words_completed: boolean; // TRUSTED
          listening_completed: boolean; // TRUSTED
          reading_completed: boolean; // TRUSTED
          conversation_completed: boolean; // TRUSTED
          grammar_completed: boolean; // TRUSTED
          xp_awarded: boolean; // TRUSTED
          started_at: string | null;
          completed_at: string | null; // TRUSTED
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          unit_id: string;
          status?: ProgressStatus;
          words_completed?: boolean;
          listening_completed?: boolean;
          reading_completed?: boolean;
          conversation_completed?: boolean;
          grammar_completed?: boolean;
          xp_awarded?: boolean;
          started_at?: string | null;
          completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          unit_id?: string;
          status?: ProgressStatus;
          words_completed?: boolean;
          listening_completed?: boolean;
          reading_completed?: boolean;
          conversation_completed?: boolean;
          grammar_completed?: boolean;
          xp_awarded?: boolean;
          started_at?: string | null;
          completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "unit_progress_user_id_fkey"; columns: ["user_id"]; referencedRelation: "profiles"; referencedColumns: ["id"] },
          { foreignKeyName: "unit_progress_unit_id_fkey"; columns: ["unit_id"]; referencedRelation: "units"; referencedColumns: ["id"] },
        ];
      };

      user_word_status: {
        Row: {
          id: string;
          user_id: string;
          unit_id: string;
          word_id: string;
          spelling_passed: boolean; // TRUSTED
          pronunciation_passed: boolean; // TRUSTED
          meaning_passed: boolean; // TRUSTED
          best_pronunciation_score: number | null; // TRUSTED
          learned: boolean; // TRUSTED
          learned_at: string | null; // TRUSTED
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          unit_id: string;
          word_id: string;
          spelling_passed?: boolean;
          pronunciation_passed?: boolean;
          meaning_passed?: boolean;
          best_pronunciation_score?: number | null;
          learned?: boolean;
          learned_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          unit_id?: string;
          word_id?: string;
          spelling_passed?: boolean;
          pronunciation_passed?: boolean;
          meaning_passed?: boolean;
          best_pronunciation_score?: number | null;
          learned?: boolean;
          learned_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "user_word_status_user_id_fkey"; columns: ["user_id"]; referencedRelation: "profiles"; referencedColumns: ["id"] },
          { foreignKeyName: "user_word_status_unit_word_fk"; columns: ["unit_id", "word_id"]; referencedRelation: "unit_words"; referencedColumns: ["unit_id", "word_id"] },
        ];
      };

      quiz_attempts: {
        Row: {
          id: string;
          user_id: string;
          unit_id: string | null;
          quiz_kind: QuizKind;
          question_id: string | null;
          word_id: string | null;
          selected_option_index: number | null;
          text_response: string | null;
          is_correct: boolean | null; // TRUSTED
          score: number | null; // TRUSTED
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          unit_id?: string | null;
          quiz_kind: QuizKind;
          question_id?: string | null;
          word_id?: string | null;
          selected_option_index?: number | null;
          text_response?: string | null;
          is_correct?: boolean | null;
          score?: number | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          unit_id?: string | null;
          quiz_kind?: QuizKind;
          question_id?: string | null;
          word_id?: string | null;
          selected_option_index?: number | null;
          text_response?: string | null;
          is_correct?: boolean | null;
          score?: number | null;
          created_at?: string;
        };
        Relationships: [
          { foreignKeyName: "quiz_attempts_user_id_fkey"; columns: ["user_id"]; referencedRelation: "profiles"; referencedColumns: ["id"] },
          { foreignKeyName: "quiz_attempts_unit_id_fkey"; columns: ["unit_id"]; referencedRelation: "units"; referencedColumns: ["id"] },
        ];
      };

      pronunciation_attempts: {
        Row: {
          id: string;
          user_id: string;
          unit_id: string;
          word_id: string;
          score: number | null; // TRUSTED
          passed: boolean | null; // TRUSTED
          assessment: Json | null; // TRUSTED
          recording_path: string | null;
          attempt_no: number | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          unit_id: string;
          word_id: string;
          score?: number | null;
          passed?: boolean | null;
          assessment?: Json | null;
          recording_path?: string | null;
          attempt_no?: number | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          unit_id?: string;
          word_id?: string;
          score?: number | null;
          passed?: boolean | null;
          assessment?: Json | null;
          recording_path?: string | null;
          attempt_no?: number | null;
          created_at?: string;
        };
        Relationships: [
          { foreignKeyName: "pronunciation_attempts_user_id_fkey"; columns: ["user_id"]; referencedRelation: "profiles"; referencedColumns: ["id"] },
          { foreignKeyName: "pronunciation_attempts_unit_word_fk"; columns: ["unit_id", "word_id"]; referencedRelation: "unit_words"; referencedColumns: ["unit_id", "word_id"] },
        ];
      };

      conversation_sessions: {
        Row: {
          id: string;
          user_id: string;
          unit_id: string;
          required_word_ids: string[]; // TRUSTED
          outcome: ConversationOutcome; // TRUSTED
          words_used_ids: string[]; // TRUSTED
          turns_used: number; // TRUSTED
          xp_awarded: boolean; // TRUSTED
          started_at: string;
          ends_at: string | null;
          ended_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          unit_id: string;
          required_word_ids?: string[];
          outcome?: ConversationOutcome;
          words_used_ids?: string[];
          turns_used?: number;
          xp_awarded?: boolean;
          started_at?: string;
          ends_at?: string | null;
          ended_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          unit_id?: string;
          required_word_ids?: string[];
          outcome?: ConversationOutcome;
          words_used_ids?: string[];
          turns_used?: number;
          xp_awarded?: boolean;
          started_at?: string;
          ends_at?: string | null;
          ended_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "conversation_sessions_user_id_fkey"; columns: ["user_id"]; referencedRelation: "profiles"; referencedColumns: ["id"] },
          { foreignKeyName: "conversation_sessions_unit_id_fkey"; columns: ["unit_id"]; referencedRelation: "units"; referencedColumns: ["id"] },
        ];
      };

      // ENTIRE ROW trusted (written by the conversation DEFINER RPC only).
      conversation_messages: {
        Row: {
          id: string;
          session_id: string;
          role: MessageRole;
          content: string;
          used_word_ids: string[];
          turn_index: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          session_id: string;
          role: MessageRole;
          content: string;
          used_word_ids?: string[];
          turn_index: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          session_id?: string;
          role?: MessageRole;
          content?: string;
          used_word_ids?: string[];
          turn_index?: number;
          created_at?: string;
        };
        Relationships: [
          { foreignKeyName: "conversation_messages_session_id_fkey"; columns: ["session_id"]; referencedRelation: "conversation_sessions"; referencedColumns: ["id"] },
        ];
      };

      user_settings: {
        Row: {
          user_id: string;
          arabic_support_level: ContentLevel;
          audio_autoplay: boolean;
          sound_effects: boolean;
          notifications_enabled: boolean;
          daily_reminder_time: string | null;
          timezone: string;
          locale: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          arabic_support_level?: ContentLevel;
          audio_autoplay?: boolean;
          sound_effects?: boolean;
          notifications_enabled?: boolean;
          daily_reminder_time?: string | null;
          timezone?: string;
          locale?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          arabic_support_level?: ContentLevel;
          audio_autoplay?: boolean;
          sound_effects?: boolean;
          notifications_enabled?: boolean;
          daily_reminder_time?: string | null;
          timezone?: string;
          locale?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "user_settings_user_id_fkey"; columns: ["user_id"]; referencedRelation: "profiles"; referencedColumns: ["id"] },
        ];
      };

      // ----------------------------------------------------------------------
      // GAMIFICATION (0004_gamification.sql)
      // ----------------------------------------------------------------------
      // ENTIRE ROW trusted (DEFINER RPC only).
      xp_events: {
        Row: {
          id: string;
          user_id: string;
          source_type: XpSourceType;
          source_id: string;
          amount: number;
          unit_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          source_type: XpSourceType;
          source_id: string;
          amount: number;
          unit_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          source_type?: XpSourceType;
          source_id?: string;
          amount?: number;
          unit_id?: string | null;
          created_at?: string;
        };
        Relationships: [
          { foreignKeyName: "xp_events_user_id_fkey"; columns: ["user_id"]; referencedRelation: "profiles"; referencedColumns: ["id"] },
          { foreignKeyName: "xp_events_unit_id_fkey"; columns: ["unit_id"]; referencedRelation: "units"; referencedColumns: ["id"] },
        ];
      };

      // ENTIRE ROW trusted.
      streak_log: {
        Row: {
          id: string;
          user_id: string;
          activity_date: string;
          streak_length: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          activity_date: string;
          streak_length?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          activity_date?: string;
          streak_length?: number;
          created_at?: string;
        };
        Relationships: [
          { foreignKeyName: "streak_log_user_id_fkey"; columns: ["user_id"]; referencedRelation: "profiles"; referencedColumns: ["id"] },
        ];
      };

      word_of_the_day: {
        Row: {
          id: string;
          scheduled_for: string;
          word_id: string;
          example_id: string | null;
          level: ContentLevel;
          status: ContentStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          scheduled_for: string;
          word_id: string;
          example_id?: string | null;
          level?: ContentLevel;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          scheduled_for?: string;
          word_id?: string;
          example_id?: string | null;
          level?: ContentLevel;
          status?: ContentStatus;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "word_of_the_day_word_id_fkey"; columns: ["word_id"]; referencedRelation: "words"; referencedColumns: ["id"] },
          { foreignKeyName: "word_of_the_day_example_id_fkey"; columns: ["example_id"]; referencedRelation: "word_examples"; referencedColumns: ["id"] },
        ];
      };

      subscriptions: {
        Row: {
          id: string;
          user_id: string;
          tier: SubscriptionTier; // TRUSTED
          status: SubscriptionStatus; // TRUSTED
          provider: string | null; // TRUSTED
          provider_ref: string | null; // TRUSTED
          current_period_end: string | null; // TRUSTED
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          tier?: SubscriptionTier;
          status?: SubscriptionStatus;
          provider?: string | null;
          provider_ref?: string | null;
          current_period_end?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          tier?: SubscriptionTier;
          status?: SubscriptionStatus;
          provider?: string | null;
          provider_ref?: string | null;
          current_period_end?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "subscriptions_user_id_fkey"; columns: ["user_id"]; referencedRelation: "profiles"; referencedColumns: ["id"] },
        ];
      };

      device_tokens: {
        Row: {
          id: string;
          user_id: string;
          platform: DevicePlatform;
          token: string;
          last_seen_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          platform: DevicePlatform;
          token: string;
          last_seen_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          platform?: DevicePlatform;
          token?: string;
          last_seen_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "device_tokens_user_id_fkey"; columns: ["user_id"]; referencedRelation: "profiles"; referencedColumns: ["id"] },
        ];
      };

      // ENTIRE ROW trusted (service-role functions only).
      ai_usage: {
        Row: {
          id: string;
          user_id: string;
          kind: AiUsageKind;
          usage_date: string;
          count: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          kind: AiUsageKind;
          usage_date: string;
          count?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          kind?: AiUsageKind;
          usage_date?: string;
          count?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          { foreignKeyName: "ai_usage_user_id_fkey"; columns: ["user_id"]; referencedRelation: "profiles"; referencedColumns: ["id"] },
        ];
      };
    };

    Views: {
      [_ in never]: never;
    };

    // ------------------------------------------------------------------------
    // FUNCTIONS (SECURITY DEFINER RPCs).
    // ----------------------------------------------------------------------------
    // The RPC bodies are owned by another agent (RLS/RPC/storage). We declare
    // the call signatures the typed client layer depends on so `supabase.rpc`
    // calls are checked. Argument names match the conventional `p_<name>` style;
    // adjust here if the RPC author chose different parameter names.
    // ------------------------------------------------------------------------
    Functions: {
      // ----------------------------------------------------------------------
      // SECURITY DEFINER RPCs (0008_rpcs.sql, 0011_progress_sections.sql).
      // Argument names + types mirror the SQL signatures EXACTLY. jsonb returns
      // are typed as `Json`; the only table-returning RPC (get_leaderboard) uses
      // a row-array Returns shape matching its `returns table (...)`.
      // ----------------------------------------------------------------------

      // Grades the placement test vs the secret answer keys, sets the profile
      // level + placement_completed, seeds the first unit_progress row.
      // answers = [{ question_id, selected_option_index?, text_response? }].
      score_placement: {
        Args: {
          answers: Json;
        };
        Returns: Json;
      };

      // Saves the user's resume point on unit_progress (UI pointer; never unlocks).
      advance_position: {
        Args: {
          p_unit_id: string;
          p_step: UnitSection;
          p_word_position?: number;
          p_sub_screen?: string;
        };
        Returns: undefined;
      };

      // Returns shuffled meaning options WITHOUT revealing the correct index.
      // -> { word_id, text_en, phonetic, options: string[] }.
      build_meaning_quiz: {
        Args: {
          p_word_id: string;
        };
        Returns: Json;
      };

      // The single grading entry point for spelling / meaning / full_words /
      // grammar quizzes (NOT pronunciation). -> { correct, score, xp_awarded, learned }.
      grade_quiz: {
        Args: {
          p_quiz_type: QuizKind;
          p_question_id?: string;
          p_user_answer: Json;
          p_unit_id?: string;
          p_word_id?: string;
        };
        Returns: Json;
      };

      // Pronunciation result that GATES progress — never a direct client write.
      // Server decides passed = score >= 70. -> { passed, score, best, attempt_no, learned, xp_awarded }.
      record_pronunciation: {
        Args: {
          p_word_id: string;
          p_unit_id: string;
          p_score: number;
          p_accuracy?: number;
          p_fluency?: number;
          p_phonemes?: Json;
          p_recording_path?: string;
        };
        Returns: Json;
      };

      // Marks one unit section complete + awards that section's XP idempotently.
      // -> { section, xp_awarded }.
      complete_section: {
        Args: {
          p_unit_id: string;
          p_section: UnitSection;
        };
        Returns: Json;
      };

      // Server-side locking gate: verifies all five section flags, unlocks next.
      // -> { completed, just_completed, xp_awarded, next_unit_id }.
      complete_unit: {
        Args: {
          p_unit_id: string;
        };
        Returns: Json;
      };

      // Timezone-aware lazy streak upsert; awards the daily bonus once/day.
      // -> { today, current_streak_days, longest_streak_days, bonus_awarded }.
      touch_streak: {
        Args: Record<string, never>;
        Returns: Json;
      };

      // Public-safe leaderboard projection (no PII). Returns a set of rows.
      get_leaderboard: {
        Args: {
          p_period?: LeaderboardPeriod;
          p_limit?: number;
        };
        Returns: {
          rank: number;
          display_name: string | null;
          avatar_url: string | null;
          total_xp: number;
          is_me: boolean;
        }[];
      };
    };

    Enums: {
      content_level: ContentLevel;
      user_level: UserLevel;
      learning_goal: LearningGoal;
      content_status: ContentStatus;
      progress_status: ProgressStatus;
      unit_section: UnitSection;
      quiz_kind: QuizKind;
      question_kind: QuestionKind;
      message_role: MessageRole;
      conversation_outcome: ConversationOutcome;
      xp_source_type: XpSourceType;
      audio_owner_type: AudioOwnerType;
      leaderboard_period: LeaderboardPeriod;
      subscription_tier: SubscriptionTier;
      subscription_status: SubscriptionStatus;
      device_platform: DevicePlatform;
      ai_usage_kind: AiUsageKind;
    };

    CompositeTypes: {
      [_ in never]: never;
    };
  };
}

// ============================================================================
// Convenience row/insert/update aliases (ergonomic shorthands for the queries
// layer). These read from the canonical `Database` shape above.
// ============================================================================
type PublicSchema = Database["public"];

export type Tables<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Row"];
export type TablesInsert<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Update"];
export type Enums<T extends keyof PublicSchema["Enums"]> =
  PublicSchema["Enums"][T];

// Named row aliases used across the app.
export type UnitRow = Tables<"units">;
export type WordRow = Tables<"words">;
export type UnitWordRow = Tables<"unit_words">;
export type WordExampleRow = Tables<"word_examples">;
export type AudioClipRow = Tables<"audio_clips">;
export type ListeningClipRow = Tables<"listening_clips">;
export type ReadingPassageRow = Tables<"reading_passages">;
export type ComprehensionQuestionRow = Tables<"comprehension_questions">;
export type GrammarLessonRow = Tables<"grammar_lessons">;
export type GrammarQuestionRow = Tables<"grammar_questions">;
export type PlacementQuestionRow = Tables<"placement_questions">;
export type FoundationsLessonRow = Tables<"foundations_lessons">;
export type ProfileRow = Tables<"profiles">;
export type OnboardingResponseRow = Tables<"onboarding_responses">;
export type UnitProgressRow = Tables<"unit_progress">;
export type UserWordStatusRow = Tables<"user_word_status">;
export type ConversationSessionRow = Tables<"conversation_sessions">;
export type ConversationMessageRow = Tables<"conversation_messages">;
export type UserSettingsRow = Tables<"user_settings">;
export type WordOfTheDayRow = Tables<"word_of_the_day">;
