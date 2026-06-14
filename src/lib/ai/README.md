# AI providers

Swappable interfaces: conversation tutor (LLM), speech-to-text, text-to-speech.
**Keep secret keys server-side** — they live in Supabase Edge Functions
(`supabase/functions/`), read via `Deno.env.get(...)`, and are **never**
`VITE_`-prefixed (Vite inlines `VITE_` vars into the public browser bundle).

## How the client reaches secret-backed services

- **Azure Speech (pronunciation + STT):** `speechToken.ts` calls the
  `speech-token` Edge Function to mint a short-lived Azure auth token, so the
  raw subscription key never reaches the browser. The token feeds
  `SpeechConfig.fromAuthorizationToken(token, region)`. See
  [`supabase/functions/speech-token/README.md`](../../../supabase/functions/speech-token/README.md).
- **LLM conversation tutor (`conversation.ts`):** call a proxy Edge Function;
  `LLM_API_KEY` stays server-only.
- **TTS:** prefer pre-generated unit audio in Supabase Storage; any live
  synthesis goes through a server-side function holding `TTS_API_KEY`.
