import { fetchJsonWithTimeout } from "./_lib/http.js";
import { createClient } from "@supabase/supabase-js";

// Proxied server-side rather than called directly from the browser for one
// concrete reason: Nominatim's usage policy requires a descriptive
// User-Agent (or a valid Referer) identifying the calling application, and
// browsers refuse to let client-side fetch() set a custom User-Agent header
// at all (it's a forbidden header name) — a server-side call can set both.
//
// The 1 request/second rate limit Nominatim's policy requires is enforced
// client-side (a 1000ms debounce in index.html) rather than here, since the
// actual constraint is one person's typing cadence, not concurrent users —
// each visitor's own browser has its own IP, so there's no shared quota to
// coordinate server-side without adding external state (Redis/KV) this app
// doesn't otherwise need.
const NOMINATIM_TIMEOUT_MS = 8000;
const SUPABASE_TIMEOUT_MS = 5000;
const USER_AGENT = "Verdex-AddressSearch/1.0 (https://verdex-1.vercel.app; contact: bitopandas323@gmail.com)";

function withTimeout(promise, ms, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

export default async function handler(req, res) {
  const { q, session } = req.query;
  if (!q || q.trim().length < 3) {
    return res.status(400).json({ error: "q must be at least 3 characters", results: [] });
  }

  const startTime = Date.now();
  let status = "error";
  let results = [];
  let errorDetail = null;

  try {
    const url = "https://nominatim.openstreetmap.org/search"
      + "?q=" + encodeURIComponent(q)
      + "&format=json&addressdetails=1&limit=5&countrycodes=in";

    const data = await fetchJsonWithTimeout(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Referer": "https://verdex-1.vercel.app/"
      }
    }, NOMINATIM_TIMEOUT_MS);

    if (Array.isArray(data)) {
      results = data.map(r => ({
        displayName: r.display_name,
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon)
      }));
      status = results.length > 0 ? "ok" : "zero_results";
    } else {
      errorDetail = "Unexpected Nominatim response shape";
    }
  } catch (err) {
    status = err.name === "AbortError" ? "timeout" : "error";
    errorDetail = err.message;
  }

  const durationMs = Date.now() - startTime;

  // geocode_attempts is a TEMPORARY diagnostic table (per explicit
  // decision) to get real numbers on how often Nominatim struggles with
  // Indian addresses before deciding whether Google Places is needed —
  // plan to clear it out once that call is made, not a permanent log.
  // Awaited (not fire-and-forget) because a Vercel function's execution
  // context isn't guaranteed to survive after the response is sent, so an
  // un-awaited insert here could silently be dropped — defeating the whole
  // point of collecting reliable numbers.
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
      const { error } = await withTimeout(
        supabase.from("geocode_attempts").insert({
          session_id: session || null,
          query: q,
          result_count: results.length,
          status,
          duration_ms: durationMs,
          error_detail: errorDetail
        }),
        SUPABASE_TIMEOUT_MS,
        "Supabase insert timed out"
      );
      if (error) console.warn("geocode_attempts insert failed:", error.message);
    } catch (logErr) {
      console.warn("geocode_attempts insert threw:", logErr.message);
    }
  }

  if (status === "error" || status === "timeout") {
    return res.status(status === "timeout" ? 504 : 502).json({ error: errorDetail || "Geocoding failed", results: [] });
  }
  return res.status(200).json({ results });
}
