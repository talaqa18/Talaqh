# Backend: target architecture vs. the legacy harness

## The target backend is React + Supabase

The app we ship is the **Vite + React + TypeScript** PWA in `src/`, talking to a
**Supabase** backend (Postgres + Auth + Storage + Edge Functions) through
`src/lib/supabase`. The entry point is `index.html` → `src/main.tsx`. The
database schema, integrity rules, and deploy workflow live under `supabase/`
(see [`../supabase/README.md`](../supabase/README.md)); product constants live
in [`../DECISIONS.md`](../DECISIONS.md).

Everything new — screens, RPCs, Edge Functions, migrations, seed/audio
tooling — belongs in this architecture.

## The `tools/*.cjs` harness is legacy (do not extend, do not delete)

The repo root also contains `tools/_setup.cjs`, `tools/check.cjs`,
`tools/smoke.cjs`, `tools/structure.cjs`, and `tools/serve.cjs`. These belong to
an **older single-file prototype** ("Talaqa") where the entire app lived as an
inline `<script>` inside `index.html`. The harness boots that inline script in a
hand-rolled DOM shim (no browser, no deps) and asserts things like section
order, the unlock chain, and summary XP.

That model **no longer matches the codebase**: the current `index.html` is just
the Vite entry that loads `/src/main.tsx`, with no inline app script. As a
result the harness does not reflect the React + Supabase app and should be
treated as historical reference only.

- **Do not** add new tests or logic to `tools/*.cjs`.
- **Do not** reintroduce app logic as an inline `<script>` to satisfy it.
- **Do not delete** the harness — it is kept intentionally as a reference to the
  earlier flow/structure decisions.

New tests for the React app should use the project's web testing setup (e.g.
Vitest + Testing Library) once added, not this harness.
