// AI provider registry — the single SWAP POINT.
// ----------------------------------------------------------------------------
// Screens import from here ONLY (e.g. `import { ai } from "@/lib/ai"`), never a
// concrete adapter. To swap a provider — e.g. Azure STT -> a Whisper Edge
// Function, or the Edge LLM tutor -> another backend — change ONE line below to
// point at the new adapter (which must satisfy the same interface in types.ts).
// No screen code changes; Capacitor-portable by construction.

import { azurePronunciation } from "./pronunciation/azurePronunciation";
import { azureStt } from "./stt/azureStt";
import { edgeConversation } from "./conversation";
import { edgeTts } from "./tts/edgeTts";

export const ai = {
  pronunciation: azurePronunciation, // PronunciationProvider
  stt: azureStt, // SpeechToTextProvider
  conversation: edgeConversation, // ConversationProvider
  tts: edgeTts, // TtsProvider
};

// Re-export the interfaces + shared types so screens can type against them
// without reaching into individual files.
export type {
  ConversationFinalize,
  ConversationProvider,
  ConversationReply,
  ConversationStart,
  Goal,
  Level,
  PronunciationProvider,
  PronunciationResult,
  SpeechToTextProvider,
  TtsProvider,
  WordResult,
} from "./types";
