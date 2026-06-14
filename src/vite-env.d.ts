/// <reference types="vite/client" />

// Typed Vite client env. ONLY publishable, VITE_-prefixed values exist here —
// these are inlined into the browser bundle. Secret keys (SPEECH_API_KEY,
// LLM_API_KEY, TTS_API_KEY) are intentionally ABSENT: they are server-only and
// must never be referenced from client code.
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
