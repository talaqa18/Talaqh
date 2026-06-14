# CLAUDE.md — Project Guide for Claude Code

> Read this first. The full feature spec is in **`docs/app-scope.md`** — that file is the
> source of truth for *what* to build. This file covers *how* we build it: stack, conventions,
> hard rules, and where each piece lives.

---

## What this is

An **Arabic-first English learning app**. The entire UI is in **Arabic, right-to-left (RTL)**.
English words and sentences appear **left-to-right (LTR)** inside the Arabic layout.

The app takes an Arabic speaker from *understanding* English to *speaking it with confidence*,
through a journey of **units**. Each unit combines: words → listening → reading → conversation → grammar.

## Delivery strategy (important)

1. **Phase 1 — PWA first.** Build as an installable Progressive Web App. This is what we ship and
   test initially. It must be installable (manifest + service worker) and feel like a native app.
2. **Phase 2 — Native via Capacitor.** Later we wrap the same web build with **Capacitor**
   (`npx cap add ios`, `npx cap add android`) to produce native binaries for the **App Store and
   Play Store**. Do not introduce web-only APIs that Capacitor can't bridge for the core flows
   (mic recording, audio playback, storage). Keep platform-specific code behind the abstractions in
   `src/lib` and `src/features`.

## Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Build tool | **Vite** | Fast dev server, easy PWA + Capacitor integration |
| UI | **React 19 + TypeScript** | Function components + hooks only |
| Routing | **React Router** | One route per screen (see "Hard rules") |
| Styling | **Tailwind CSS** | RTL-configured; design tokens in `src/styles/tokens.css` |
| State | **Zustand** | Lightweight global store in `src/store` |
| Backend / Auth / DB / Storage | **Supabase** | Postgres + Auth + Storage (for audio). Client in `src/lib/supabase`. The React + Supabase stack is the **target backend** — see `docs/backend.md`. The `tools/*.cjs` harness belongs to an **older single-file prototype** (kept for reference, not extended). |
| PWA | **vite-plugin-pwa** | Installable shell. NOTE: full offline content sync is **out of scope** |
| Native shell | **Capacitor** | Phase 2 only. Config in `capacitor.config.ts` |
| Arabic font | **Cairo / Tajawal** | UI text |
| English font | **Inter** | English words/sentences. (Chosen deliberately for clean Latin pairing.) |

> Versions are not pinned in `package.json` yet — install latest stable and pin once running:
> `npm install`. Network may be disabled in this environment; the user/agent installs deps locally.

## AI & audio services (swappable — keep behind `src/lib/ai`)

The hard parts of the scope need external services. Wrap each one behind a thin interface so the
provider can be swapped without touching screens. **Never hardcode keys** — read from env (see
`.env.example`).

- **Pronunciation assessment** (score 0–100 + highlight the mispronounced part + retry):
  recommended **Azure AI Speech – Pronunciation Assessment**, which returns accuracy/fluency plus
  phoneme-level errors that map directly to the scope's requirement. Interface lives in
  `src/features/pronunciation`.
- **Speech-to-text** (the conversation screen accepts **voice only**): Azure Speech or Whisper.
- **Conversation tutor** (AI starts the chat and *types* its messages; 3-minute timer; user must use
  the unit's 5 words): an LLM behind `src/lib/ai/conversation.ts`.
- **Text-to-speech / clip audio**: prefer **pre-generating audio for each unit's fixed words and
  example sentences** and storing it in Supabase Storage (cheaper, consistent, installable). Use a
  TTS API as fallback. All playback goes through the single-source player in `src/features/audio`.

## Hard rules (do not violate)

1. **One purpose per screen.** Teaching is its own screen. A quiz is a separate screen. *Each question
   type has its own dedicated screen.* Never put two purposes on one screen. → one React Router route
   per screen.
2. **RTL everywhere.** `<html dir="rtl" lang="ar">`. Layout, navigation, and spacing are mirrored.
   English content is wrapped LTR (`dir="ltr"`) inside the Arabic layout.
3. **A progress indicator appears on every learning screen.** Use the shared `<ProgressBar>` in
   `src/components/layout`.
4. **Unit-word reuse.** Listening clips, the reading passage, conversation, and grammar examples
   **must use the current unit's 5 words.** This is a content constraint Claude Code must enforce in
   both the data model and any generation.
5. **One audio source at a time.** No overlapping playback — the player in `src/features/audio` owns
   this and stops any other clip before starting.
6. **Sequential locking, no skipping.** Content unlocks in order; the user's position auto-saves.
   Logic lives in `src/features/progress`.
7. **Level-based difficulty (A1–C1).** Content and Arabic explanations adapt to the user's level.
8. **All Arabic UI strings live in `src/strings/ar.ts`** — one source, no hardcoded Arabic literals
   scattered in components.

## Design system

Clean **light theme**. Primary **emerald/teal green**; warm **gold** accent for points, streak, and
rewards; warm-gray backgrounds; rounded cards; generous whitespace; large touch targets. Tokens are
defined once in `src/styles/tokens.css` and consumed via Tailwind — don't use raw hex values in
components.

## Navigation

Bottom nav with **3 sections** (RTL order): **Home (الرئيسية) · Journey (الرحلة) · Settings (الإعدادات)**.
The unit flow and all teaching/quiz screens push **on top** of this shell as their own routes.

## Folder map

```
docs/app-scope.md      ← full feature spec (source of truth)
public/                ← PWA manifest, icons, fonts, prebuilt audio
supabase/              ← SQL migrations + seed content (units, words)
src/
  app/                 ← SCREENS (one purpose per screen)
    auth/              ← sign in / sign up
    onboarding/        ← name, age, goal
    placement/         ← placement test (one question per screen)
    foundations/       ← phonics + simple words (complete beginners only)
    home/              ← الرئيسية (progress, word of the day, leaderboard)
    journey/           ← الرحلة (unit list + the unit flow)
      words/           ←   teaching screen + 3 quiz screens (spelling / pronunciation / meaning)
      listening/       ←   الاستماع (clip per screen + comprehension)
      reading/         ←   القراءة (passage + translate toggle + comprehension)
      conversation/    ←   المحادثة (3-min AI tutor, voice-only replies)
      grammar/         ←   القواعد (lesson screen + quiz)
      completion/      ←   "words finished" / unit-complete screens
    settings/          ← الإعدادات
  components/          ← shared UI (ui primitives, layout shell/nav/progress, feedback)
  features/            ← cross-cutting logic (audio, pronunciation, translation, gamification, progress)
  lib/                 ← supabase client, ai providers, utils
  store/               ← Zustand global state
  hooks/  types/  content/  strings/  styles/
```

## Build order (from the scope)

1. Structure & navigation + onboarding + placement test.
2. Journey: words (teaching + their quizzes), then the full words quiz.
3. Listening and reading (reusing the unit's words).
4. Voice conversation (3 minutes) + grammar.
5. Home (progress + word of the day + leaderboard) + settings.
6. Polish: advanced pronunciation assessment, gamification, notifications.

## Out of scope (this version)

Standalone Writing practice · offline content sync · admin dashboard · UI languages other than
Arabic · social features beyond the leaderboard.

## Conventions for Claude Code

- TypeScript everywhere; no `any` without reason.
- One screen = one route = one folder under `src/app/...`.
- Keep components presentational; put data access in `src/lib` and logic in `src/features`.
- Never commit secrets. Copy `.env.example` → `.env` locally and fill values there.
- Before building UI, read `docs/app-scope.md` for the exact behavior of that screen.
