// AI provider contracts — one interface per concern.
// ----------------------------------------------------------------------------
// Screens depend ONLY on these interfaces (consumed via `src/lib/ai/index.ts`),
// never on a concrete provider. Swapping a provider (Azure -> Whisper, Edge LLM
// -> another) means changing one line in index.ts and writing a new adapter that
// satisfies the matching interface here — no screen changes.
//
// Capacitor portability: the interfaces say nothing about *how* audio is
// captured (mic SDK vs. native bridge), so a native adapter can replace a web
// one transparently. Mic capture is owned by the adapters (see each file); it
// will later be wrapped by `src/features/audio` to enforce the one-source rule.

// ---------------------------------------------------------------- shared types

/** Learner CEFR level (plus the pre-A1 "beginner" foundations track). */
export type Level = "beginner" | "A1" | "A2" | "B1" | "B2" | "C1";

/** Learner goal (from onboarding). */
export type Goal = "travel" | "work" | "study_abroad" | "daily_conversation";

// ----------------------------------------------------------- pronunciation

/** Per-word scoring from a pronunciation assessment. */
export interface WordResult {
  text: string;
  /** 0–100 accuracy for this word. */
  accuracy: number;
  /** True when this word should be highlighted as mispronounced in the UI. */
  isMispronounced: boolean;
  /** Optional phoneme-level breakdown (present when the provider supports it). */
  phonemes?: { phoneme: string; accuracy: number }[];
}

/** Full pronunciation assessment result for one spoken attempt. */
export interface PronunciationResult {
  /** Overall pronunciation score, 0–100. */
  score: number;
  /**
   * Client-side convenience flag for INSTANT UI feedback only.
   * The TRUSTED pass decision is the server's `record_pronunciation` RPC
   * (score >= 70). See azurePronunciation.ts for the full caveat.
   */
  passed: boolean;
  /** Overall accuracy component, 0–100 (provider-dependent). */
  accuracy?: number;
  /** Overall fluency component, 0–100 (provider-dependent). */
  fluency?: number;
  /** Per-word results, in spoken order. */
  words: WordResult[];
}

export interface PronunciationProvider {
  /**
   * Assess pronunciation of `expectedText`.
   * When `audio` is undefined the adapter captures from the microphone via the
   * speech SDK; otherwise it assesses the supplied audio buffer/blob.
   * `level` may tune grading strictness in some providers.
   */
  assess(
    audio: Blob | ArrayBuffer | undefined,
    expectedText: string,
    level?: Level,
  ): Promise<PronunciationResult>;
}

// --------------------------------------------------------------- speech-to-text

export interface SpeechToTextProvider {
  /**
   * Transcribe spoken audio to text.
   * When `audio` is undefined the adapter captures from the microphone.
   * `confidence` is null when the provider does not expose a simple score.
   */
  transcribe(
    audio: Blob | ArrayBuffer | undefined,
    langHint?: string,
  ): Promise<{ text: string; confidence: number | null }>;
}

// ----------------------------------------------------------------- conversation

/** Result of opening a 3-minute tutor session (action: "start"). */
export interface ConversationStart {
  sessionId: string;
  /** ISO timestamp when the session window closes (server-enforced). */
  endsAt: string;
  /** The current unit's 5 target words the learner must use. */
  requiredWords: { id: string; text_en: string; translation_ar: string }[];
  /** The tutor's opening English message. */
  message: string;
  /** Arabic translation of the message. */
  translationAr: string;
  /** One short Arabic hint nudging toward a target word. */
  hintAr: string;
}

/** Result of one tutor turn (action: "reply"). */
export interface ConversationReply {
  message: string;
  translationAr: string;
  hintAr: string;
  /** Ids of target words the server detected in the learner's transcript. */
  wordsUsed: string[];
  /** Turns consumed so far (server-authoritative). */
  turnsUsed: number;
}

/** Result of closing a session (action: "finalize"). */
export interface ConversationFinalize {
  outcome: string;
  wordsUsedCount: number;
}

export interface ConversationProvider {
  start(unitId: string): Promise<ConversationStart>;
  reply(sessionId: string, userTranscript: string): Promise<ConversationReply>;
  finalize(
    sessionId: string,
    reason?: "completed" | "expired" | "abandoned",
  ): Promise<ConversationFinalize>;
}

// ------------------------------------------------------------------------- tts

export interface TtsProvider {
  /** Pre-generated clip URL by storage path (PRIMARY path). */
  urlFor(storagePath: string): string;
  /** Dynamic-text fallback synthesis (rare; rate-limited server-side). */
  synthesize(text: string, voice?: string): Promise<Blob>;
}
