// Pronunciation provider — Azure AI Speech adapter.
// ----------------------------------------------------------------------------
// Implements PronunciationProvider using Azure's Pronunciation Assessment, which
// returns an overall score plus accuracy/fluency and phoneme-level errors — a
// direct fit for the scope (score 0–100 + highlight the mispronounced part +
// retry). The raw Azure key NEVER reaches the browser: we mint a short-lived
// authorization token via getSpeechToken() (the speech-token Edge Function).
//
// Mic capture lives INSIDE this adapter (AudioConfig.fromDefaultMicrophoneInput).
// It will later be wrapped by `src/features/audio` to enforce the one-source
// rule (stop any other clip before recording). Keep platform mic access behind
// this adapter so a Capacitor-native provider can replace it transparently.
//
// To swap the pronunciation provider, write a new PronunciationProvider and
// register it in `src/lib/ai/index.ts`.

import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { getSpeechToken } from "../speechToken";
import type {
  Level,
  PronunciationProvider,
  PronunciationResult,
  WordResult,
} from "../types";

// Below this per-item accuracy we mark a word/phoneme as mispronounced even when
// Azure's coarse errorType is "None".
const MISPRONOUNCED_ACCURACY_THRESHOLD = 60;
// Local UI pass threshold (mirrors the server's record_pronunciation RPC).
const PASS_THRESHOLD = 70;

export const azurePronunciation: PronunciationProvider = {
  async assess(
    audio: Blob | ArrayBuffer | undefined,
    expectedText: string,
    _level?: Level,
  ): Promise<PronunciationResult> {
    const { authorizationToken, region } = await getSpeechToken();

    const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(
      authorizationToken,
      region,
    );
    speechConfig.speechRecognitionLanguage = "en-US";

    // Microphone capture (audio undefined) or assess a supplied buffer.
    const audioConfig = await buildAudioConfig(audio);

    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    // Configure pronunciation assessment against the expected reference text.
    const paConfig = new sdk.PronunciationAssessmentConfig(
      expectedText,
      sdk.PronunciationAssessmentGradingSystem.HundredMark,
      sdk.PronunciationAssessmentGranularity.Phoneme,
      /* enableMiscue */ true,
    );
    paConfig.applyTo(recognizer);

    try {
      const result = await recognizeOnce(recognizer);
      return mapResult(result);
    } finally {
      // Always release the mic / native resources.
      recognizer.close();
    }
  },
};

// ----------------------------------------------------------------------------
// Build an AudioConfig: from the default microphone when no audio is given,
// otherwise push the supplied bytes through an in-memory stream.
// ----------------------------------------------------------------------------
async function buildAudioConfig(
  audio: Blob | ArrayBuffer | undefined,
): Promise<sdk.AudioConfig> {
  if (audio === undefined) {
    return sdk.AudioConfig.fromDefaultMicrophoneInput();
  }
  const bytes = audio instanceof Blob ? await audio.arrayBuffer() : audio;
  const pushStream = sdk.AudioInputStream.createPushStream();
  pushStream.write(bytes.slice(0));
  pushStream.close();
  return sdk.AudioConfig.fromStreamInput(pushStream);
}

// ----------------------------------------------------------------------------
// Promisify recognizeOnceAsync and surface SDK cancellation/errors clearly.
// ----------------------------------------------------------------------------
function recognizeOnce(
  recognizer: sdk.SpeechRecognizer,
): Promise<sdk.SpeechRecognitionResult> {
  return new Promise((resolve, reject) => {
    recognizer.recognizeOnceAsync(
      (result) => {
        if (result.reason === sdk.ResultReason.Canceled) {
          const details = sdk.CancellationDetails.fromResult(result);
          reject(
            new Error(
              `Pronunciation assessment canceled: ${details.reason}` +
                (details.errorDetails ? ` — ${details.errorDetails}` : ""),
            ),
          );
          return;
        }
        resolve(result);
      },
      (err) => reject(new Error(`Pronunciation assessment failed: ${err}`)),
    );
  });
}

// ----------------------------------------------------------------------------
// Map Azure's result into our PronunciationResult.
//
// IMPORTANT — `passed` is computed LOCALLY here for INSTANT UI feedback ONLY.
// The TRUSTED pass decision is the SERVER's `record_pronunciation` RPC (which
// also uses score >= 70). The screen MUST persist the attempt via that RPC and
// use ITS returned `passed`, NOT this client-side value — the client value can
// be tampered with and must never gate progression.
// ----------------------------------------------------------------------------
function mapResult(
  result: sdk.SpeechRecognitionResult,
): PronunciationResult {
  // No speech recognized → zero score, empty word list (let the UI prompt retry).
  if (result.reason !== sdk.ResultReason.RecognizedSpeech) {
    return { score: 0, passed: false, words: [] };
  }

  const pa = sdk.PronunciationAssessmentResult.fromResult(result);
  const score = Math.round(pa.pronunciationScore ?? 0);

  const words: WordResult[] = (pa.detailResult?.Words ?? []).map((w: any) => {
    const accuracy = Math.round(w?.PronunciationAssessment?.AccuracyScore ?? 0);
    const errorType: string = w?.PronunciationAssessment?.ErrorType ?? "None";
    const isMispronounced =
      errorType !== "None" || accuracy < MISPRONOUNCED_ACCURACY_THRESHOLD;

    const phonemes = Array.isArray(w?.Phonemes)
      ? w.Phonemes.map((p: any) => ({
          phoneme: String(p?.Phoneme ?? ""),
          accuracy: Math.round(p?.PronunciationAssessment?.AccuracyScore ?? 0),
        }))
      : undefined;

    return {
      text: String(w?.Word ?? ""),
      accuracy,
      isMispronounced,
      ...(phonemes && phonemes.length > 0 ? { phonemes } : {}),
    };
  });

  return {
    score,
    // CLIENT-ONLY convenience flag — see the comment above. Server RPC is truth.
    passed: score >= PASS_THRESHOLD,
    accuracy: pa.accuracyScore != null ? Math.round(pa.accuracyScore) : undefined,
    fluency: pa.fluencyScore != null ? Math.round(pa.fluencyScore) : undefined,
    words,
  };
}
