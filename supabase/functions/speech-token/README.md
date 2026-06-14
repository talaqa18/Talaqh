# `speech-token` Edge Function — token-minting pattern

## The problem it solves

Vite **statically inlines every `VITE_`-prefixed env var** into the client
bundle. So a `VITE_SPEECH_API_KEY` would ship the raw Azure subscription key to
every browser — visible in devtools/view-source. That violates CLAUDE.md's
"Never hardcode keys" / "keep secret keys server-side".

## The fix: short-lived authorization tokens

The Azure subscription key stays **server-side only**. The browser never sees
it. Instead:

```
 Browser (pronunciation / STT screen)
   │  supabase.functions.invoke("speech-token")   ← sends user's Supabase JWT
   ▼
 speech-token Edge Function (Deno, server-side)
   │  1. verify_jwt = true  → only signed-in users
   │  2. read SPEECH_API_KEY + SPEECH_REGION via Deno.env.get (never VITE_)
   │  3. POST https://<region>.api.cognitive.microsoft.com/sts/v1.0/issueToken
   │        header: Ocp-Apim-Subscription-Key: <SPEECH_API_KEY>
   ▼
 Azure returns a JWT valid ~10 minutes
   │
   ▼
 Function responds { token, region, expiresInSeconds }
   │
   ▼
 Browser Speech SDK:
   SpeechConfig.fromAuthorizationToken(token, region)
```

The **subscription key never leaves the server**; the browser only ever holds a
disposable ~10-minute token scoped to the Speech service. The client caches it
and refreshes shortly before expiry (`src/lib/ai/speechToken.ts`).

This same token works for **both** flows that need Azure Speech directly in the
browser:

- **Pronunciation assessment** (`src/features/pronunciation`) — the SDK's
  `PronunciationAssessmentConfig` rides on a `SpeechConfig` built from the token.
- **Speech-to-text** (conversation screen, voice-only replies) — `Recognizer`
  built from the same token-based `SpeechConfig`.

### Proxy alternative

For flows where you do **not** want the browser talking to Azure at all (e.g.
LLM conversation tutor, server-side TTS pre-generation), use a **full proxy**
Edge Function instead of a token: the browser sends audio/text to the function,
the function calls the provider with the secret key, and returns only the
result. Tokens are preferred for live mic streaming (lower latency, the SDK
manages the WebSocket); proxying is preferred for request/response calls where
the key must never be exchanged for a client-usable credential.

## Deploy & configure

```bash
# Set the SERVER-ONLY secrets (never VITE_-prefixed, never committed):
supabase secrets set SPEECH_API_KEY=xxxxxxxx SPEECH_REGION=eastus

# Deploy. verify_jwt defaults to true, so only authenticated users can mint.
supabase functions deploy speech-token
```

Local dev: put `SPEECH_API_KEY` / `SPEECH_REGION` in `supabase/functions/.env`
(git-ignored), then `supabase functions serve speech-token`.

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are injected into the function runtime
automatically by the platform — no need to set them as secrets.
