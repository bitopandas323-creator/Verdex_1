// Shared fetch-with-timeout utility. The timeout must cover the FULL
// request lifecycle — connection through body read/parse — not just the
// initial fetch() call. A version of this exact bug hung
// scripts/fetch-nearby-places.mjs indefinitely tonight: the timer was
// cleared as soon as fetch() resolved (i.e. once headers arrived), leaving
// res.json() completely unprotected, so a fast-header/slow-body response
// hung forever with no way out (confirmed live — the script sat stuck on
// one neighbourhood for 10+ minutes with zero progress).
//
// Two variants, because callers need different things from a failed
// response:
//   fetchJsonWithTimeout   — returns parsed JSON regardless of res.ok,
//                            for callers that inspect the JSON body itself
//                            (e.g. WAQI's own `status` field) rather than
//                            the HTTP status.
//   fetchTextWithTimeout   — returns { ok, status, text }, for callers that
//                            need the raw body and status code to build a
//                            detailed error response on failure.
// Both throw (AbortError) on timeout — same as any other fetch/network
// failure — so existing try/catch around call sites already handles it.

export async function fetchJsonWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchTextWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timeoutId);
  }
}
