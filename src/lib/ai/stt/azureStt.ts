// Speech-to-text provider — Azure AI Speech adapter.
// ----------------------------------------------------------------------------
// Used by the conversation screen, where learner replies are VOICE-ONLY
// (CLAUDE.md). The raw Azure key never reaches the browser: we mint a
// short-lived authorization token via getSpeechToken() (the speech-token Edge
// Function).
//
// Mic capture lives INSIDE this adapter (AudioConfig.fromDefaultMicrophoneInput).
// It will later be wrapped by `src/features/audio` to enforce the one-source
// rule (stop any other clip before recording). Keep platform mic access behind
// this adapter so a Capacitor-native provider can replace it transparently.
//
// SWAPPABLE FALLBACK: a Whisper-backed Edge Function (`stt-proxy`) is the
// intended drop-in alternative. To swap, write a new SpeechToTextProvider that
// invokes that function and register it in `src/lib/ai/index.ts` — no screen
// changes.

import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { getSpeechToken } from "../speechToken";
import type { SpeechToTextProvider } from "../types";

export const azureStt: SpeechToTextProvider = {
  async transcribe(
    audio: Blob | ArrayBuffer | undefined,
    langHint = "en-US",
  ): Promise<{ text: string; confidence: number | null }> {
    const { authorizationToken, region } = await getSpeechToken();

    const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(
      authorizationToken,
      region,
    );
    // Conversation replies are English; default to en-US, allow an override.
    speechConfig.speechRecognitionLanguage = langHint || "en-US";

    const audioConfig = await buildAudioConfig(audio);
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    try {
      const result = await recognizeOnce(recognizer);
      const text =
        result.reason === sdk.ResultReason.RecognizedSpeech
          ? (result.text ?? "")
          : "";
      // Azure one-shot recognition does not expose a simple confidence score
      // (it lives only in opt-in detailed N-best JSON), so we return null and
      // let callers treat absence of a score uniformly across providers.
      return { text, confidence: null };
    } finally {
      recognizer.close();
    }
  },
};

// Microphone capture (audio undefined) or transcribe a supplied buffer.
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

// Promisify recognizeOnceAsync; surface cancellation/errors clearly.
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
              `Speech-to-text canceled: ${details.reason}` +
                (details.errorDetails ? ` — ${details.errorDetails}` : ""),
            ),
          );
          return;
        }
        resolve(result);
      },
      (err) => reject(new Error(`Speech-to-text failed: ${err}`)),
    );
  });
}
