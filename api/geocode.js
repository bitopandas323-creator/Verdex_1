import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { fetchJsonWithTimeout } from "./_lib/http.js";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// data/neighbourhoods.json is the same static snapshot api/snapshot.js
// already reads (there's no shared-module system between index.html and
// these serverless functions, so it must be kept in sync manually if
// baseline neighbourhoods change — an existing, already-documented
// caveat, not new here). Reused rather than hardcoding a second copy of
// city coordinates.
const NEIGHBOURHOODS = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "neighbourhoods.json"), "utf8")
);

// Bare min/max across the ~10 sampled neighbourhoods per city is tighter
// than the real metro area (e.g. Hyderabad's sampled extent is Old City to
// Uppal, but the city itself extends well past both) — padded so a real
// address near the edge of a metro area isn't excluded by bounded=1 below.
const CITY_BBOX_PADDING_DEG = 0.2;

const CITY_BBOXES = {};
for (const n of NEIGHBOURHOODS) {
  if (!CITY_BBOXES[n.city]) {
    CITY_BBOXES[n.city] = { minLat: n.lat, maxLat: n.lat, minLon: n.lon, maxLon: n.lon };
  }
  const b = CITY_BBOXES[n.city];
  b.minLat = Math.min(b.minLat, n.lat);
  b.maxLat = Math.max(b.maxLat, n.lat);
  b.minLon = Math.min(b.minLon, n.lon);
  b.maxLon = Math.max(b.maxLon, n.lon);
}
for (const city in CITY_BBOXES) {
  const b = CITY_BBOXES[city];
  b.minLat -= CITY_BBOX_PADDING_DEG;
  b.maxLat += CITY_BBOX_PADDING_DEG;
  b.minLon -= CITY_BBOX_PADDING_DEG;
  b.maxLon += CITY_BBOX_PADDING_DEG;
}

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
  const { q, session, city } = req.query;
  if (!q || q.trim().length < 3) {
    return res.status(400).json({ error: "q must be at least 3 characters", results: [] });
  }

  const startTime = Date.now();
  let status = "error";
  let results = [];
  let errorDetail = null;

  try {
    let url = "https://nominatim.openstreetmap.org/search"
      + "?q=" + encodeURIComponent(q)
      + "&format=json&addressdetails=1&limit=5&countrycodes=in";

    // Soft preference, not a hard filter: viewbox without bounded=1 boosts
    // the rank of results near the selected city without excluding a real
    // address that's genuinely outside it (e.g. just past a city's rough
    // boundary) — deliberately chosen over bounded=1 so those don't vanish.
    const bbox = CITY_BBOXES[city];
    if (bbox) {
      url += "&viewbox=" + bbox.minLon + "," + bbox.maxLat + "," + bbox.maxLon + "," + bbox.minLat;
    }

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
