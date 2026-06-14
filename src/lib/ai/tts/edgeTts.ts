// Text-to-speech provider — Supabase Storage + Edge Function adapter.
// ----------------------------------------------------------------------------
// PRIMARY path: PRE-GENERATED unit audio in Supabase Storage (CLAUDE.md —
// pre-generate each unit's fixed words + example sentences; cheaper, consistent,
// installable). Call `urlFor(storagePath)` to get the public clip URL.
//
// FALLBACK path: `synthesize(text, voice?)` calls the `tts-fallback` Edge
// Function (Azure TTS, server-side key, per-user daily quota) for the rare
// DYNAMIC text that has no prebuilt clip. Use sparingly.
//
// All playback must go through the single-source player in `src/features/audio`
// (one-source rule); this adapter only resolves URLs / synthesizes bytes.
//
// To swap the TTS provider, write a new TtsProvider and register it in
// `src/lib/ai/index.ts`.

import { supabase } from "../../supabase/client";
import type { TtsProvider } from "../types";

// Storage bucket holding the pre-generated unit clips.
const AUDIO_BUCKET = "unit-audio";

export const edgeTts: TtsProvider = {
  urlFor(storagePath: string): string {
    // Public bucket → stable, cacheable URL for the pre-generated clip.
    return supabase.storage.from(AUDIO_BUCKET).getPublicUrl(storagePath).data
      .publicUrl;
  },

  async synthesize(text: string, voice?: string): Promise<Blob> {
    // The function returns audio/mpeg bytes; invoke with a Blob responseType so
    // we get raw audio rather than parsed JSON.
    const { data, error } = await supabase.functions.invoke<Blob>(
      "tts-fallback",
      {
        body: { text, voice },
        headers: { Accept: "audio/mpeg" },
      },
    );
    if (error) {
      throw new Error(`tts-fallback failed: ${error.message}`);
    }
    if (!data) {
      throw new Error("tts-fallback returned no audio");
    }
    // Normalize to an audio/mpeg Blob regardless of how the SDK surfaced it.
    if (data instanceof Blob) {
      return data.type ? data : new Blob([data], { type: "audio/mpeg" });
    }
    return new Blob([data as unknown as BlobPart], { type: "audio/mpeg" });
  },
};
