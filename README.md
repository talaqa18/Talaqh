# Arabic-first English Learning App

An installable **PWA** (later wrapped as **native iOS/Android via Capacitor**) that teaches English
to **Arabic speakers**, with a fully **Arabic, right-to-left** interface.

- **Stack:** Vite · React + TypeScript · Tailwind (RTL) · Zustand · Supabase · vite-plugin-pwa · Capacitor
- **Spec:** see [`docs/app-scope.md`](docs/app-scope.md) (full feature scope)
- **Build guide for Claude Code:** see [`CLAUDE.md`](CLAUDE.md)

## Getting started

```bash
npm install
cp .env.example .env      # then fill in your Supabase + AI provider values
npm run dev
```

## Going native (Phase 2)

```bash
npm run build
npx cap add ios
npx cap add android
npx cap sync
```

## Project layout

See the **Folder map** section in `CLAUDE.md`.
