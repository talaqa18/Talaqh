// Shared HTTP helpers for upstream provider calls (LLM / STT / TTS).
// ----------------------------------------------------------------------------
// Upstream AI providers rate-limit with HTTP 429 (and sometimes transient 5xx).
// fetchWithRetry retries those with EXPONENTIAL BACKOFF + jitter, honoring the
// provider's Retry-After header when present. Non-retryable statuses return
// immediately so the caller can map them to a client response.
// deno-lint-ignore-file no-explicit-any

import { HttpError } from "./auth.ts";

export interface RetryOptions {
  /** Max attempts including the first try. Default 4. */
  maxAttempts?: number;
  /** Base delay in ms for the first backoff. Default 500ms. */
  baseDelayMs?: number;
  /** Cap on any single backoff wait. Default 8000ms. */
  maxDelayMs?: number;
  /** Statuses to retry. Default 429 + 500/502/503/504. */
  retryStatuses?: ReadonlyArray<number>;
}

const DEFAULTS: Required<RetryOptions> = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  retryStatuses: [429, 500, 502, 503, 504],
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse Retry-After (seconds OR an HTTP-date) into ms; null if absent/invalid. */
function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("Retry-After");
  if (!header) return null;
  const asInt = Number(header);
  if (Number.isFinite(asInt)) return Math.max(0, asInt * 1000);
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

/**
 * fetch() with retry + exponential backoff for 429 / transient 5xx. Returns the
 * final Response (which may still be an error if retries are exhausted). Network
 * errors are also retried up to maxAttempts.
 */
export async function fetchWithRetry(
  input: string | URL | Request,
  init?: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const o = { ...DEFAULTS, ...opts };
  let lastErr: unknown;

  for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(input, init);
    } catch (err) {
      lastErr = err;
      // Network failure: retry unless this was the last attempt.
      if (attempt >= o.maxAttempts) break;
    }

    if (res) {
      if (!o.retryStatuses.includes(res.status) || attempt >= o.maxAttempts) {
        return res;
      }
      // Retryable status: prefer the server's Retry-After, else backoff.
      const serverWait = retryAfterMs(res);
      const backoff = Math.min(
        o.maxDelayMs,
        o.baseDelayMs * 2 ** (attempt - 1),
      );
      const jitter = Math.floor(Math.random() * 250);
      // Drain the body so the connection can be reused.
      await res.body?.cancel().catch(() => {});
      await sleep(serverWait ?? backoff + jitter);
      continue;
    }

    // Network error path: backoff before the next attempt.
    const backoff = Math.min(o.maxDelayMs, o.baseDelayMs * 2 ** (attempt - 1));
    await sleep(backoff + Math.floor(Math.random() * 250));
  }

  // Exhausted: surface as a 502 so the caller maps it consistently.
  throw new HttpError(
    502,
    `Upstream request failed after ${o.maxAttempts} attempts` +
      (lastErr ? `: ${(lastErr as Error).message}` : ""),
  );
}
