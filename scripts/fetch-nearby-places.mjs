// Batch job: for each of the 80 neighbourhoods in data/neighbourhoods.json,
// finds up to 4 candidates per place category (hospital, school, grocery,
// transit, etc.) plus major-highway access, via OpenStreetMap (Overpass).
// Writes data/nearby-places.json.
//
// Most categories rank candidates by distance alone. Eight — hospital,
// college, school, mall, grocery, pharmacy, gym, fuel — rank by a curated
// chain-name match first, OSM's wikipedia/wikidata tag presence second,
// distance third: a well-known regional hospital 8km away is often more
// useful than an unnamed clinic 0.3km away, and a chain match or wiki tag is
// a real, independently-verified prominence signal rather than a guess.
// These eight also search at 15km instead of the default 5km, every run —
// prominence ranking needs a wide candidate pool to have anything
// meaningful to rank.
//
// This is NOT called live per user search — it's meant to be re-run
// periodically (e.g. monthly) since these facilities rarely change:
//   node scripts/fetch-nearby-places.mjs                    (full run, all 80)
//   node scripts/fetch-nearby-places.mjs --limit=5          (test run, first N)
//   node scripts/fetch-nearby-places.mjs --retry-failed     (re-query only categories
//                                                             that failed last time)
//   node scripts/fetch-nearby-places.mjs --widen=fire_station (re-search a specific
//                                                             category at its
//                                                             CATEGORY_RADIUS_OVERRIDES
//                                                             radius, only for
//                                                             neighbourhoods currently
//                                                             null for it; --widen=all
//                                                             does every category)
//   node scripts/fetch-nearby-places.mjs --only=Howrah      (fully re-fetch all 18
//                                                             categories for specific
//                                                             neighbourhoods by name —
//                                                             e.g. after correcting a
//                                                             wrong coordinate)
//
// Uses bbox + haversine post-filtering rather than Overpass's `around:`
// filter — `around:` was found to time out under load during this project's
// earlier infrastructure/walkability work, and the same lesson applies here.
//
// All 18 categories (17 point/area types + highway) are requested in a
// SINGLE combined query per neighbourhood, not one query per category —
// v1 of this script ran 2 queries/neighbourhood (160 total) and contributed
// to Overpass throttling. One combined query per neighbourhood means 80
// requests for a full run, even with more than 4x the categories.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NEIGHBOURHOODS = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "neighbourhoods.json"), "utf8")
);

const RADIUS_M = 5000;
const MAX_CANDIDATES = 4;
const USER_AGENT = "Verdex-NearbyPlaces/3.2 (periodic batch job; contact: bitopandas323@gmail.com)";
const REQUEST_DELAY_MS = 1500;
const CANDIDATE_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter"
];
let OVERPASS_ENDPOINTS = CANDIDATE_MIRRORS;

// Bundling 17 categories into one query means a heavier response per
// neighbourhood than v1's smaller per-category queries. The server-side
// [timeout:25] below asks Overpass for up to 25s to process; the client
// timeout must clear that with room for network transfer, or we abort our
// own healthy-but-slow queries (the exact bug found and fixed tonight when
// this was 15s against a 25s server budget).
const OVERPASS_CLIENT_TIMEOUT_MS = 45000;

const outPath = join(__dirname, "..", "data", "nearby-places.json");

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// IMPORTANT: the timeout must cover the full request lifecycle, including
// reading/parsing the response body — not just the initial fetch() call.
// An earlier version cleared the AbortController's timer as soon as fetch()
// resolved (i.e. once headers arrived), leaving res.json() completely
// unprotected — a fast-header/slow-body response could hang indefinitely.
async function fetchJsonWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error("status " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

// Never throws — mirrors fetchNdviForCell's fetchNdviOnce in
// scripts/pilot-grid-hyderabad-core.mjs: internalizes its own try/catch so
// the caller can safely abandon this promise (via the hard-deadline race
// below) without risking an unhandled rejection later, if a stalled
// request eventually settles on its own after the race has already moved
// on.
async function queryOverpassOnce(endpoint, query) {
  try {
    const data = await fetchJsonWithTimeout(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
      body: "data=" + encodeURIComponent(query)
    }, OVERPASS_CLIENT_TIMEOUT_MS);
    return Array.isArray(data.elements) ? data.elements : null;
  } catch (err) {
    return null;
  }
}

// Bangalore grid pilot session 3 proved AbortController's own setTimeout
// isn't sufficient here either — the same OS/network-level stall that hung
// pilot-grid-hyderabad-core.mjs's NDVI calls for 12-75 minutes despite its
// 30s guard also hit this exact function: cell [18,3] returned 0/18
// categories after a 2329s stall, cell [18,4] after 4492s — both far past
// OVERPASS_CLIENT_TIMEOUT_MS's 45s ceiling, on a function that already
// retries twice per mirror. Same fix as the NDVI path: race each attempt
// against an independent hard deadline so this loop keeps moving even if
// the underlying fetch() promise never settles (the abandoned attempt is
// left to resolve on its own in the background; queryOverpassOnce's own
// try/catch above means that's always safe to ignore).
async function queryOverpassWithRetry(query) {
  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const hardDeadline = new Promise(resolve =>
        setTimeout(() => resolve(null), OVERPASS_CLIENT_TIMEOUT_MS + 5000)
      );
      const elements = await Promise.race([queryOverpassOnce(endpoint, query), hardDeadline]);
      if (elements) return elements;
      if (attempt === 1) await sleep(1500);
    }
  }
  return null; // every mirror failed after retry
}

// Picks the fastest of the candidate mirrors with one cheap, identical test
// query before the real run starts, and reorders OVERPASS_ENDPOINTS to try
// the fastest one first (all candidates stay in the fallback chain — this
// only affects order, never reduces resilience below the fixed 2-mirror list
// used before).
async function benchmarkMirrors() {
  const testQuery = `[out:json][timeout:10];node(28.60,77.20,28.601,77.201);out;`;
  const results = [];
  for (const url of CANDIDATE_MIRRORS) {
    const start = Date.now();
    try {
      await fetchJsonWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
        body: "data=" + encodeURIComponent(testQuery)
      }, 10000);
      results.push({ url, ms: Date.now() - start, ok: true });
    } catch (err) {
      results.push({ url, ms: Infinity, ok: false });
    }
  }
  results.sort((a, b) => a.ms - b.ms);
  console.log("Mirror benchmark:");
  results.forEach(r => console.log(`  ${r.url}: ${r.ok ? r.ms + "ms" : "FAILED"}`));
  const usable = results.filter(r => r.ok).map(r => r.url);
  return usable.length > 0 ? usable : CANDIDATE_MIRRORS;
}

// Exported so callers like the Gowlidoddy pilot can opt into the same
// fastest-mirror-first behavior the CLI entry point uses below —
// OVERPASS_ENDPOINTS is a module-private `let`, so an importer can't just
// reassign it directly; this runs the benchmark and applies the result to
// this module's own binding, then returns it for logging.
export async function initOverpassMirrors() {
  OVERPASS_ENDPOINTS = await benchmarkMirrors();
  return OVERPASS_ENDPOINTS;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bboxAround(lat, lon, radiusM) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon]; // south, west, north, east
}

// Confirmed by direct testing: when an Overpass `out` statement requests
// BOTH `center` and `geom` together (needed here since highway ways need
// full geometry while every other category just needs a point), Overpass
// omits `.center` for way/relation elements. Ways fall back to `.geometry`
// (a flat vertex array) — but relations don't get `.geometry` at all in
// that case, they get `.bounds` (a min/max lat/lon bounding box) instead.
// Missed exactly this on AIG Hospitals (mapped as a multipolygon relation,
// confirmed via direct query: `out center tags` gives it a `.center`,
// `out geom tags` gives it `.bounds`, and combining both — what this script
// actually sends — gives it neither) — silently dropped from every
// category despite being 1.87km from Gachibowli, closer than every
// candidate that WAS being shown. Same root cause as the `.geometry`
// fallback below (a college 1.4km from Dwarka was missing the same way,
// before that fix), just a different Overpass element type hitting it.
function coordsOf(el) {
  if (el.lat !== undefined) return [el.lat, el.lon];
  if (el.center) return [el.center.lat, el.center.lon];
  if (Array.isArray(el.geometry) && el.geometry.length > 0) {
    const latSum = el.geometry.reduce((sum, p) => sum + p.lat, 0);
    const lonSum = el.geometry.reduce((sum, p) => sum + p.lon, 0);
    return [latSum / el.geometry.length, lonSum / el.geometry.length];
  }
  if (el.bounds) {
    return [(el.bounds.minlat + el.bounds.maxlat) / 2, (el.bounds.minlon + el.bounds.maxlon) / 2];
  }
  return null;
}

// --- Category definitions: drive both the query and the classification ---

// Ranked by prominence tier then distance instead of pure nearest — see
// fetchPlaces below. Also the only categories that search 15km by default
// (CATEGORY_RADIUS_OVERRIDES), every run, not just via --widen.
const PROMINENCE_CATEGORIES = new Set(["hospital", "college", "school", "mall", "grocery", "pharmacy", "gym", "fuel"]);

// A wiki tag alone missed real, major institutions: AIG Hospitals (Gachibowli)
// has no wikipedia/wikidata/operator:wikidata tag on any element at all, and
// Apollo Hospitals' flagship Jubilee Hills location only carries
// operator:wikidata (the chain's own entry), not a tag on the hospital
// itself — confirmed via direct Overpass query, both genuinely closer than
// every candidate that WAS being shown, neither appearing anywhere in the
// data, not even in the "show more" expansion. This curated list is a
// second, independent signal for exactly that blind spot — no entry for
// college/school (none was asked for), so those two categories keep the
// existing wiki-tag-then-distance behavior unchanged. Kokilaben/Medanta/
// MIOT/Ruby Hall/AMRI/Sterling added after cross-city verification found
// these real, major hospitals landing in the no-signal tier under the
// original list — same blind spot class as AIG, just for different brands.
const CHAIN_NAMES = {
  hospital: ["apollo", "aig", "yashoda", "care hospital", "care hospitals", "continental", "kims", "sunshine", "rainbow", "fortis", "max", "manipal", "narayana", "kokilaben", "medanta", "miot", "ruby hall", "amri", "sterling"],
  mall:     ["phoenix", "forum", "inorbit", "dlf", "nexus", "select citywalk", "lulu", "vr"],
  grocery:  ["dmart", "d-mart", "reliance fresh", "reliance smart", "more", "spencer's", "spencers", "big bazaar"],
  pharmacy: ["apollo pharmacy", "medplus", "netmeds"],
  gym:      ["cult.fit", "cult fit", "gold's gym", "golds gym", "anytime fitness"],
  fuel:     ["indian oil", "hp", "bharat petroleum", "shell"]
};

// Word-boundary, not plain substring — a bare substring check matched
// "care" against "VCare"/"Ambicare" and "vr" against "PVR Icon", none of
// which are the intended chains. Word-boundary matching fixes that whole
// class (confirmed: those three no longer match). It does NOT fix a
// generic word that genuinely stands alone in an unrelated name — "Lakshmi
// Narayana Speciality Clinics" still matches "narayana", and bare "care"
// was found matching "Arogyasree Health Care Trust" and "Eva Care The Every
// Woman's Clinic" in real batch data, neither related to the Care Hospitals
// chain. For "care" specifically, the entry was narrowed from the bare word
// to the two-word phrases "care hospital"/"care hospitals" (both needed:
// the real chain's OSM names are pluralized — "Care Hospitals" — which
// fails a singular-only \bcare hospital\b boundary check on the trailing
// "s"). This fixes the Health-Care-Trust/Eva-Care class entirely (neither
// contains "hospital" at all) but — same inherent limit as "narayana" —
// still can't distinguish the real chain from an unrelated hospital whose
// name happens to contain the same two words together ("Fehmi Care
// Hospital", "Nephroplus Kidney Care Hospitals"); no substring-based
// approach can, short of a curated exclusion list, not attempted here.
// "narayana" was left as a bare word (not narrowed the same way) since
// "Narayana Health"/"Narayana Hrudayalaya" don't share a fixed two-word
// pattern the way "Care Hospitals" does — known, accepted residual
// imprecision for that one.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function matchesChain(key, name) {
  const chains = CHAIN_NAMES[key];
  if (!chains || !name) return false;
  return chains.some(c => new RegExp(`\\b${escapeRegExp(c)}\\b`, "i").test(name));
}

// Explicit tier number rather than sorting on chainMatch and wiki as two
// separate keys — combining them ad hoc (chainMatch desc, wiki desc,
// distance asc) would quietly let a chain-matched-and-wiki-tagged candidate
// edge out a chain-matched-but-not-wiki-tagged one even when the latter is
// closer, which isn't what was asked for. Tier 0 (chain match) always beats
// tier 1 (wiki tag) always beats tier 2 (neither); distance only breaks ties
// within the same tier.
function prominenceTier(c) {
  if (c.chainMatch) return 0;
  if (c.wiki) return 1;
  return 2;
}

// Extracted out of fetchPlaces (pure function, no network) so it can be
// exercised directly — e.g. to compare against the pre-fix behavior on
// identical raw candidate data, rather than two independent live Overpass
// snapshots that could differ from ordinary OSM data drift between fetches.
function selectCandidates(list, key) {
  if (!PROMINENCE_CATEGORIES.has(key)) {
    return list.slice().sort((a, b) => a.distanceKm - b.distanceKm).slice(0, MAX_CANDIDATES);
  }
  list = list.slice().sort((a, b) => (prominenceTier(a) - prominenceTier(b)) || (a.distanceKm - b.distanceKm));
  let selected = list.slice(0, MAX_CANDIDATES);
  // Guarantee the single closest candidate overall always makes the cut,
  // even if its tier is worse than every already-selected one. Confirmed
  // live via the Gowlidoddy pilot: a real gym 0.24km away (no chain match)
  // was silently excluded because 4+ chain-matched gyms existed within the
  // search radius, all farther away but all tier 0 — tier always wins the
  // sort, so a plain top-N slice can drop the nearest real place entirely,
  // not just deprioritize it. Only swaps out the weakest (last)
  // already-selected candidate if the true nearest isn't already present,
  // then re-sorts so display order stays tier-then-distance rather than
  // bolting it on at the end.
  if (list.length > MAX_CANDIDATES) {
    const nearestOverall = list.reduce((min, c) => c.distanceKm < min.distanceKm ? c : min, list[0]);
    if (!selected.includes(nearestOverall)) {
      selected = selected.slice(0, MAX_CANDIDATES - 1).concat(nearestOverall);
      selected.sort((a, b) => (prominenceTier(a) - prominenceTier(b)) || (a.distanceKm - b.distanceKm));
    }
  }
  return selected;
}

const CATEGORY_DEFS = [
  { key: "hospital",        clause: bbox => `nwr["amenity"="hospital"](${bbox});` },
  { key: "clinic",          clause: bbox => `nwr["amenity"~"^(clinic|doctors)$"](${bbox});` },
  { key: "school",          clause: bbox => `nwr["amenity"="school"](${bbox});` },
  { key: "college",         clause: bbox => `nwr["amenity"~"^(college|university)$"](${bbox});` },
  { key: "police",          clause: bbox => `nwr["amenity"="police"](${bbox});` },
  { key: "fire_station",    clause: bbox => `nwr["amenity"="fire_station"](${bbox});` },
  { key: "grocery",         clause: bbox => `nwr["shop"~"^(supermarket|convenience|grocery)$"](${bbox});` },
  { key: "pharmacy",        clause: bbox => `nwr["amenity"="pharmacy"](${bbox});` },
  { key: "atm_bank",        clause: bbox => `nwr["amenity"~"^(atm|bank)$"](${bbox});` },
  { key: "bus_stop",        clause: bbox => `nwr["highway"="bus_stop"](${bbox});\n  nwr["amenity"="bus_station"](${bbox});` },
  { key: "metro_station",   clause: bbox => `nwr["railway"~"^(station|subway_entrance)$"](${bbox});` },
  { key: "restaurant_cafe", clause: bbox => `nwr["amenity"~"^(restaurant|cafe)$"](${bbox});` },
  { key: "park",            clause: bbox => `nwr["leisure"="park"](${bbox});` },
  { key: "gym",             clause: bbox => `nwr["leisure"="fitness_centre"](${bbox});` },
  { key: "mall",            clause: bbox => `nwr["shop"~"^(mall|department_store)$"](${bbox});` },
  { key: "worship",         clause: bbox => `nwr["amenity"="place_of_worship"](${bbox});` },
  { key: "fuel",            clause: bbox => `nwr["amenity"="fuel"](${bbox});` },
  { key: "highway",         clause: bbox => `way["highway"~"^(motorway|trunk|primary|secondary)$"](${bbox});` }
];

const HIGHWAY_RE = /^(motorway|trunk|primary|secondary)$/;

// Classifies a returned element into exactly one of the 17 point/area
// category keys by its own tags (Overpass doesn't tell us which query
// clause produced a result once everything's merged into one union).
// Returns null for elements that don't match any point/area category —
// including highway ways, which are handled separately below since they
// need geometry-walking, not a single coordsOf() point.
function matchPointCategory(tags) {
  if (!tags) return null;
  if (tags.amenity === "hospital") return "hospital";
  if (tags.amenity === "clinic" || tags.amenity === "doctors") return "clinic";
  if (tags.amenity === "school") return "school";
  if (tags.amenity === "college" || tags.amenity === "university") return "college";
  if (tags.amenity === "police") return "police";
  if (tags.amenity === "fire_station") return "fire_station";
  if (tags.shop === "supermarket" || tags.shop === "convenience" || tags.shop === "grocery") return "grocery";
  if (tags.amenity === "pharmacy") return "pharmacy";
  if (tags.amenity === "atm" || tags.amenity === "bank") return "atm_bank";
  if (tags.highway === "bus_stop" || tags.amenity === "bus_station") return "bus_stop";
  if (tags.railway === "station" || tags.railway === "subway_entrance") return "metro_station";
  if (tags.amenity === "restaurant" || tags.amenity === "cafe") return "restaurant_cafe";
  if (tags.leisure === "park") return "park";
  if (tags.leisure === "fitness_centre") return "gym";
  if (tags.shop === "mall" || tags.shop === "department_store") return "mall";
  if (tags.amenity === "place_of_worship") return "worship";
  if (tags.amenity === "fuel") return "fuel";
  return null;
}

// Each category clause gets its OWN bbox, sized from radiusForKey(d.key) —
// not one shared bbox for the whole query. This lets hospital/college/
// school/mall search 15km while the other 14 categories stay at 5km, all
// within a SINGLE combined Overpass request per neighbourhood (not two),
// preserving the one-query-per-neighbourhood design.
function buildQuery(lat, lon, defs, radiusForKey) {
  const clauses = defs.map(d => {
    const [s, w, n, e] = bboxAround(lat, lon, radiusForKey(d.key));
    return d.clause(`${s},${w},${n},${e}`);
  }).join("\n  ");
  return `[out:json][timeout:25];\n(\n  ${clauses}\n);\nout center geom tags;`;
}

// Fire stations are legitimately sparser than every other nearest-only
// category (they serve a wide area by design, unlike a grocery store or
// ATM) — confirmed by direct testing: multiple "no_match_found"
// neighbourhoods had a real fire station just past 5km (5.1-5.6km). This
// radius is only used when explicitly widened (--widen=fire_station), not
// baked into every run — unlike PROMINENCE_CATEGORIES below, whose wide
// radius applies unconditionally, every run (see radiusForKey in
// fetchPlaces).
const CATEGORY_RADIUS_OVERRIDES = {
  fire_station: 15000,
  hospital: 15000,
  college: 15000,
  school: 15000,
  mall: 15000,
  grocery: 15000,
  pharmacy: 15000,
  gym: 15000,
  fuel: 15000
};

// Runs one combined query for the given category subset (all 18 for a full
// run, a smaller subset for --retry-failed/--widen) and returns
// { key: { candidates, reason, radiusKm? } } for exactly those keys.
// candidates is always an array (0-MAX_CANDIDATES items), already sorted in
// display order:
//   - PROMINENCE_CATEGORIES: wiki tag presence descending, then distance
//     ascending — a farther candidate WITH a wikipedia/wikidata tag can
//     outrank a closer one without.
//   - every other category: distance ascending, unchanged from before.
//
// radiusOverrideM, when given, applies to EVERY def in this call regardless
// of its own registered radius — used by --widen to test a single category
// at a custom radius. When omitted (the normal full-run path), each
// category looks up its own radius: PROMINENCE_CATEGORIES always use
// CATEGORY_RADIUS_OVERRIDES, everything else (including fire_station)
// defaults to RADIUS_M unless explicitly widened.
// options.includeRaw: when true, also returns the raw (unsorted,
// unsliced) per-category candidate lists alongside the normal result —
// used by diagnostics that need to compare selection algorithms against
// identical underlying data instead of two separately-timed live fetches.
async function fetchPlaces(lat, lon, defs, radiusOverrideM, options) {
  function radiusForKey(key) {
    if (radiusOverrideM) return radiusOverrideM;
    if (PROMINENCE_CATEGORIES.has(key)) return CATEGORY_RADIUS_OVERRIDES[key] || RADIUS_M;
    return RADIUS_M;
  }

  const query = buildQuery(lat, lon, defs, radiusForKey);
  const elements = await queryOverpassWithRetry(query);

  const result = {};
  if (!elements) {
    defs.forEach(d => { result[d.key] = { candidates: [], reason: "retry_exhausted" }; });
    return result;
  }

  const wantHighway = defs.some(d => d.key === "highway");
  const candidatesByKey = {};
  defs.forEach(d => { candidatesByKey[d.key] = []; });

  for (const el of elements) {
    const pointKey = matchPointCategory(el.tags);
    if (pointKey && candidatesByKey.hasOwnProperty(pointKey)) {
      const c = coordsOf(el);
      if (!c) continue;
      const dist = haversineKm(lat, lon, c[0], c[1]);
      if (dist > radiusForKey(pointKey) / 1000) continue; // bbox is a square superset — enforce true circular radius
      const candidate = { distanceKm: dist, name: (el.tags && el.tags.name) || null };
      if (PROMINENCE_CATEGORIES.has(pointKey)) {
        candidate.wiki = Boolean(el.tags.wikipedia || el.tags.wikidata || el.tags["operator:wikidata"]);
        candidate.chainMatch = matchesChain(pointKey, candidate.name);
      }
      candidatesByKey[pointKey].push(candidate);
      continue;
    }
    // Each matching way contributes at most one candidate (its own nearest
    // point) — otherwise "top 4 highway candidates" could secretly be 4
    // different points on the same road instead of 4 distinct roads.
    if (wantHighway && el.type === "way" && el.tags && HIGHWAY_RE.test(el.tags.highway || "")) {
      if (!Array.isArray(el.geometry)) continue;
      let nearestOnWay = null;
      for (const pt of el.geometry) {
        const dist = haversineKm(lat, lon, pt.lat, pt.lon);
        if (dist > radiusForKey("highway") / 1000) continue;
        if (nearestOnWay === null || dist < nearestOnWay) nearestOnWay = dist;
      }
      if (nearestOnWay !== null) {
        candidatesByKey.highway.push({ distanceKm: nearestOnWay, name: (el.tags.name || el.tags.ref) || null });
      }
    }
  }

  defs.forEach(d => {
    const selected = selectCandidates(candidatesByKey[d.key], d.key);
    const candidates = selected.map(c => {
      const out = { distanceKm: Math.round(c.distanceKm * 10) / 10, name: c.name };
      if (c.wiki !== undefined) out.wiki = c.wiki;
      if (c.chainMatch !== undefined) out.chainMatch = c.chainMatch;
      return out;
    });

    result[d.key] = { candidates, reason: candidates.length > 0 ? null : "no_match_found" };
    const usedRadius = radiusForKey(d.key);
    if (usedRadius !== RADIUS_M) result[d.key].radiusKm = usedRadius / 1000;
  });
  if (options && options.includeRaw) return { result, raw: candidatesByKey };
  return result;
}

function logFailures(name, city, places, radiusM) {
  radiusM = radiusM || RADIUS_M;
  const failed = Object.entries(places).filter(([, v]) => v.reason);
  failed.forEach(([k, v]) => {
    const label = v.reason === "retry_exhausted" ? "Overpass retry exhausted (transient failure)" : `genuine empty result (no match within ${radiusM / 1000}km)`;
    console.log(`    ${k}: ${label}`);
  });
  return failed.length;
}

// --- Full run ---

async function runFull(limit) {
  const neighbourhoods = limit ? NEIGHBOURHOODS.slice(0, limit) : NEIGHBOURHOODS;
  console.log(`Fetching nearby places for ${neighbourhoods.length} neighbourhoods (${CATEGORY_DEFS.length} categories, 1 query each — ${RADIUS_M / 1000}km default, ${[...PROMINENCE_CATEGORIES].join("/")} at 15km)...\n`);
  console.log(`Watch total query time this run — prominence radius now applies to 4 denser categories (grocery/pharmacy/gym/fuel) in addition to hospital/college/school/mall; flag if any neighbourhood approaches the ${OVERPASS_CLIENT_TIMEOUT_MS / 1000}s client timeout.\n`);

  const results = [];
  let totalFailed = 0, totalEmpty = 0;

  for (let i = 0; i < neighbourhoods.length; i++) {
    const n = neighbourhoods[i];
    console.log(`[${i + 1}/${neighbourhoods.length}] ${n.name}, ${n.city}`);

    const places = await fetchPlaces(n.lat, n.lon, CATEGORY_DEFS);
    results.push({ name: n.name, city: n.city, places });

    logFailures(n.name, n.city, places);
    totalFailed += Object.values(places).filter(v => v.reason === "retry_exhausted").length;
    totalEmpty += Object.values(places).filter(v => v.reason === "no_match_found").length;

    // Checkpoint after every neighbourhood — an 80-stop unattended run is
    // long enough that losing all progress to one hang/interrupt near the
    // end is expensive. Cheap to write (a few KB), so no reason not to.
    writeFileSync(outPath, JSON.stringify(results, null, 2));

    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`\nWrote ${results.length} entries to ${outPath}`);
  console.log(`${totalFailed} category lookups failed due to Overpass retry exhaustion (transient — NOT evidence of absence). Re-run with --retry-failed to retry just these.`);
  console.log(`${totalEmpty} category lookups genuinely found nothing within 5km (real sparse-OSM-tagging case).`);
}

// --- Only run: fully re-fetches all 18 categories for specific
// neighbourhoods by name (e.g. after correcting a wrong coordinate, where
// every category needs re-querying, not just the ones that were null).
// Unlike runFull, this merges into the existing file rather than
// overwriting it from scratch — runFull's write-as-you-go checkpointing
// only contains neighbourhoods processed so far in that run, which would
// silently wipe out the other 79 entries if used for a partial run.

async function runOnly(namesArg) {
  if (!existsSync(outPath)) {
    console.error(`${outPath} doesn't exist yet — run a full pass first.`);
    process.exit(1);
  }
  const names = namesArg.split(",").map(n => n.trim()).filter(Boolean);
  const existing = JSON.parse(readFileSync(outPath, "utf8"));

  for (const name of names) {
    const n = NEIGHBOURHOODS.find(x => x.name === name);
    if (!n) {
      console.warn(`Skipping "${name}" — not found in data/neighbourhoods.json.`);
      continue;
    }
    const entryIdx = existing.findIndex(e => e.name === name && e.city === n.city);
    console.log(`Fully re-fetching ${n.name}, ${n.city} (${n.lat}, ${n.lon})...\n`);

    const places = await fetchPlaces(n.lat, n.lon, CATEGORY_DEFS);
    const entry = { name: n.name, city: n.city, places };
    if (entryIdx === -1) existing.push(entry);
    else existing[entryIdx] = entry;

    logFailures(n.name, n.city, places);
    writeFileSync(outPath, JSON.stringify(existing, null, 2));
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`\nUpdated ${outPath}`);
}

// --- Retry-failed run: only re-queries categories marked retry_exhausted ---

async function runRetryFailed() {
  if (!existsSync(outPath)) {
    console.error(`${outPath} doesn't exist yet — run a full pass first.`);
    process.exit(1);
  }
  const existing = JSON.parse(readFileSync(outPath, "utf8"));

  const toRetry = existing
    .map(entry => ({
      entry,
      failedKeys: Object.entries(entry.places).filter(([, v]) => v.reason === "retry_exhausted").map(([k]) => k)
    }))
    .filter(x => x.failedKeys.length > 0);

  console.log(`${toRetry.length}/${existing.length} neighbourhoods have at least one retry_exhausted category. Retrying only those categories for those neighbourhoods.\n`);

  for (let i = 0; i < toRetry.length; i++) {
    const { entry, failedKeys } = toRetry[i];
    const n = NEIGHBOURHOODS.find(x => x.name === entry.name && x.city === entry.city);
    if (!n) {
      console.warn(`  Skipping ${entry.name}, ${entry.city} — not found in data/neighbourhoods.json (renamed/removed?).`);
      continue;
    }
    console.log(`[${i + 1}/${toRetry.length}] ${entry.name}, ${entry.city} — retrying: ${failedKeys.join(", ")}`);

    const defs = CATEGORY_DEFS.filter(d => failedKeys.includes(d.key));
    const updated = await fetchPlaces(n.lat, n.lon, defs);
    Object.assign(entry.places, updated); // only overwrites the retried keys — everything else in `entry.places` is untouched

    const stillFailed = logFailures(entry.name, entry.city, updated);
    if (stillFailed === 0) console.log("    all retried categories resolved");

    writeFileSync(outPath, JSON.stringify(existing, null, 2));
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`\nUpdated ${outPath}`);
}

// --- Widen/recheck run: re-searches specific categories for neighbourhoods
// where that category currently has no value (either reason), at that
// category's configured radius — CATEGORY_RADIUS_OVERRIDES[key] if one
// exists (e.g. fire_station's 15km), otherwise the standard RADIUS_M. With
// no override this is a plain re-query at the same radius as before, useful
// for checking whether a null result was genuine or a one-off Overpass
// hiccup. Categories already resolved are left untouched — a match already
// found is by definition also the nearest within any larger radius, so
// re-checking it would be wasted work. `--widen=all` rechecks every
// category's nulls in one pass. Results found at a non-default radius get
// a `radiusKm` field recorded alongside them; default-radius results
// (including ones resolved on a plain recheck) carry no such field.

async function runWiden(keysArg) {
  if (!existsSync(outPath)) {
    console.error(`${outPath} doesn't exist yet — run a full pass first.`);
    process.exit(1);
  }
  const keys = keysArg === "all"
    ? CATEGORY_DEFS.map(d => d.key)
    : keysArg.split(",").map(k => k.trim()).filter(Boolean);
  const unknown = keys.filter(k => !CATEGORY_DEFS.some(d => d.key === k));
  if (unknown.length > 0) {
    console.error(`Unknown categor${unknown.length > 1 ? "ies" : "y"}: ${unknown.join(", ")}`);
    process.exit(1);
  }

  const existing = JSON.parse(readFileSync(outPath, "utf8"));

  for (const key of keys) {
    const radiusM = CATEGORY_RADIUS_OVERRIDES[key] || RADIUS_M;
    const def = CATEGORY_DEFS.find(d => d.key === key);
    const toWiden = existing.filter(entry => entry.places[key].candidates.length === 0);
    if (toWiden.length === 0) continue;

    console.log(`\n=== Widening "${key}" to ${radiusM / 1000}km for ${toWiden.length}/${existing.length} neighbourhoods currently null ===\n`);

    for (let i = 0; i < toWiden.length; i++) {
      const entry = toWiden[i];
      const n = NEIGHBOURHOODS.find(x => x.name === entry.name && x.city === entry.city);
      if (!n) {
        console.warn(`  Skipping ${entry.name}, ${entry.city} — not found in data/neighbourhoods.json.`);
        continue;
      }
      console.log(`[${i + 1}/${toWiden.length}] ${entry.name}, ${entry.city}`);

      const updated = await fetchPlaces(n.lat, n.lon, [def], radiusM);
      const widenedResult = updated[key];
      entry.places[key] = widenedResult;

      logFailures(entry.name, entry.city, { [key]: widenedResult }, radiusM);
      if (widenedResult.candidates.length > 0) console.log(`    found at ${widenedResult.candidates[0].distanceKm}km (within ${radiusM / 1000}km search)`);

      writeFileSync(outPath, JSON.stringify(existing, null, 2));
      await sleep(REQUEST_DELAY_MS);
    }
  }

  console.log(`\nUpdated ${outPath}`);
}

// --- Reusable exports ---
//
// fetchPlaces + CATEGORY_DEFS are exported so other scripts (e.g. the
// Gowlidoddy grid-caching pilot) can reuse the exact same Overpass query
// construction, prominence ranking, chain-name matching, and wiki-tag
// detection instead of reimplementing/copy-pasting it — one source of
// truth, no drift risk. Importing this module does NOT run the CLI (see
// the entry-point guard below), so this is safe to import with zero
// side effects beyond module-level const/function declarations.
export { fetchPlaces, CATEGORY_DEFS, selectCandidates, PROMINENCE_CATEGORIES };

// --- Entry point ---
//
// Guarded so `import`ing this module (see above) never also triggers the
// CLI's default runFull() — only running it directly via
// `node scripts/fetch-nearby-places.mjs` does. pathToFileURL (not a plain
// string comparison) handles Windows path separators correctly.
const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  (async () => {
    OVERPASS_ENDPOINTS = await benchmarkMirrors();
    console.log(`Using mirror order: ${OVERPASS_ENDPOINTS.join(", ")}\n`);

    const args = process.argv.slice(2);
    const retryFailed = args.includes("--retry-failed");
    const widenArg = args.find(a => a.startsWith("--widen="));
    const onlyArg = args.find(a => a.startsWith("--only="));
    const limitArg = args.find(a => a.startsWith("--limit="));
    const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;

    if (onlyArg) {
      await runOnly(onlyArg.split("=")[1]);
    } else if (widenArg) {
      await runWiden(widenArg.split("=")[1]);
    } else if (retryFailed) {
      await runRetryFailed();
    } else {
      await runFull(limit);
    }
  })();
}
