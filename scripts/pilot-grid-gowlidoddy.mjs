// Standalone pilot: proves the grid + snap-to-nearest-cell mechanism works
// at real scale for a 3km x 3km box around Kotlas High Living Serviced
// Apartments, Gowlidoddy, Hyderabad (17.4259203, 78.328301) — NOT one of
// the 80 static neighbourhoods, NOT wired into index.html. Writes
// data/pilot-grid-gowlidoddy.json and nothing else.
//
// Reuses real, already-hardened logic rather than reimplementing it:
//   - NDVI: calls the already-deployed https://verdex-1.vercel.app/api/ndvi
//     (needs SENTINEL_CLIENT_ID/SECRET, which only exist in that
//     deployment's env — this is the credential-free way to reuse its
//     exact fixed logic).
//   - Nearby Places: imports fetchPlaces + CATEGORY_DEFS directly from
//     fetch-nearby-places.mjs (now exported for exactly this purpose) —
//     same Overpass query construction, prominence ranking, chain-name
//     matching, and wiki-tag detection as the production batch script,
//     zero drift risk from copy-pasting.
//
// Run: node scripts/pilot-grid-gowlidoddy.mjs

import { writeFileSync, readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { fetchPlaces, CATEGORY_DEFS, initOverpassMirrors } from "./fetch-nearby-places.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "data", "pilot-grid-gowlidoddy.json");

const CENTER_LAT = 17.4259203;
const CENTER_LON = 78.328301;
const HALF_BOX_M = 1500;      // 1.5km half-width -> 3km x 3km box
const CELL_SPACING_M = 250;
const NDVI_ENDPOINT = "https://verdex-1.vercel.app/api/ndvi";
const NDVI_TIMEOUT_MS = 30000; // server-side worst case is ~23s (8s token + 15s stats); leave headroom
const REQUEST_DELAY_MS = 1500; // matches fetch-nearby-places.mjs's own pacing

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Same meters->degrees conversion as fetch-nearby-places.mjs's bboxAround,
// reimplemented here (not imported) since it's computing a fresh box
// around a new arbitrary point, a distinct concern from that script's
// per-neighbourhood search-radius boxes.
function bboxAround(lat, lon, radiusM) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  return { south: lat - dLat, west: lon - dLon, north: lat + dLat, east: lon + dLon };
}

function buildGrid(centerLat, centerLon, halfBoxM, spacingM) {
  const { south, west, north, east } = bboxAround(centerLat, centerLon, halfBoxM);
  const sideM = halfBoxM * 2;
  const cellsPerSide = Math.round(sideM / spacingM);
  const latStep = (north - south) / cellsPerSide;
  const lonStep = (east - west) / cellsPerSide;
  const cells = [];
  for (let i = 0; i < cellsPerSide; i++) {
    for (let j = 0; j < cellsPerSide; j++) {
      cells.push({
        cellIndex: [i, j],
        lat: south + latStep * (i + 0.5),
        lon: west + lonStep * (j + 0.5)
      });
    }
  }
  return { cells, bbox: { south, west, north, east }, cellsPerSide };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// The actual mechanism being piloted: given any arbitrary point, find the
// nearest stored cell by real distance to its center — not index math off
// the grid formula, so this also correctly handles points slightly outside
// the box (snaps to the nearest edge cell) rather than assuming perfect
// alignment.
export function findNearestCell(lat, lon, cells) {
  let best = null, bestDistKm = Infinity;
  for (const cell of cells) {
    const d = haversineKm(lat, lon, cell.lat, cell.lon);
    if (d < bestDistKm) { bestDistKm = d; best = cell; }
  }
  return { cell: best, distanceKm: bestDistKm };
}

// Three-way failure classification (timeout / non-ok / exception), same
// discipline already applied to every other live fetch tonight — so if
// this starts failing a lot for a specific area, the reason is visible in
// logs, not swallowed into a generic "didn't work".
async function fetchNdviForCell(lat, lon) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NDVI_TIMEOUT_MS);
  try {
    const res = await fetch(`${NDVI_ENDPOINT}?lat=${lat}&lon=${lon}`, { signal: controller.signal });
    const data = await res.json();
    if (!res.ok) {
      return { ndvi: null, reason: `HTTP ${res.status}: ${data.reason || data.error || "unknown"}`, failureKind: "nonOk" };
    }
    if (typeof data.ndvi === "number") return { ndvi: data.ndvi, reason: null, failureKind: null };
    return { ndvi: null, reason: data.reason || "no usable reading", failureKind: "noReading" };
  } catch (e) {
    if (e.name === "AbortError") {
      return { ndvi: null, reason: "client timeout", failureKind: "timeout" };
    }
    return { ndvi: null, reason: `exception: ${e.message}`, failureKind: "exception" };
  } finally {
    clearTimeout(timeoutId);
  }
}

function summarizePlaces(places) {
  if (!places) return "places fetch failed entirely";
  const populated = Object.entries(places).filter(([, v]) => v.candidates && v.candidates.length > 0);
  return `${populated.length}/${CATEGORY_DEFS.length} categories populated`;
}

async function run() {
  const limitArg = process.argv.find(a => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;

  // Without this, OVERPASS_ENDPOINTS defaults to CANDIDATE_MIRRORS' raw
  // order (overpass-api.de first) instead of the benchmarked-fastest one —
  // confirmed live in the first full pilot run: 48/144 cells burned ~91.5s
  // each failing both attempts against a dead mirror before falling
  // through, turning a ~35min run into ~118min. The production batch
  // script always benchmarks first; this pilot originally didn't.
  const mirrors = await initOverpassMirrors();
  console.log(`Using mirror order: ${mirrors.join(", ")}\n`);

  const { cells: allCells, bbox, cellsPerSide } = buildGrid(CENTER_LAT, CENTER_LON, HALF_BOX_M, CELL_SPACING_M);
  const cells = limit ? allCells.slice(0, limit) : allCells;
  console.log(`Bounding box: south=${bbox.south.toFixed(6)} west=${bbox.west.toFixed(6)} north=${bbox.north.toFixed(6)} east=${bbox.east.toFixed(6)}`);
  console.log(`Grid: ${cellsPerSide} x ${cellsPerSide} = ${allCells.length} cells at ${CELL_SPACING_M}m spacing${limit ? ` (running first ${limit} only, --limit)` : ""}\n`);

  const startTime = Date.now();
  const ndviFailures = { timeout: 0, nonOk: 0, exception: 0, noReading: 0 };
  let placesFailures = 0;
  const results = [];

  for (let idx = 0; idx < cells.length; idx++) {
    const cell = cells[idx];
    const cellStart = Date.now();

    const [ndviResult, placesResult] = await Promise.all([
      fetchNdviForCell(cell.lat, cell.lon),
      fetchPlaces(cell.lat, cell.lon, CATEGORY_DEFS).catch(err => {
        placesFailures++;
        console.warn(`  [${idx + 1}/${cells.length}] Places fetch threw an exception: ${err.message}`);
        return null;
      })
    ]);

    if (ndviResult.failureKind) ndviFailures[ndviResult.failureKind]++;

    const elapsedS = ((Date.now() - cellStart) / 1000).toFixed(1);
    console.log(`[${idx + 1}/${cells.length}] cell [${cell.cellIndex}] (${cell.lat.toFixed(6)}, ${cell.lon.toFixed(6)}) — ndvi=${ndviResult.ndvi !== null ? ndviResult.ndvi : "null (" + ndviResult.reason + ")"} — ${summarizePlaces(placesResult)} — ${elapsedS}s`);

    results.push({
      cellIndex: cell.cellIndex,
      lat: cell.lat,
      lon: cell.lon,
      ndvi: ndviResult.ndvi,
      ndviReason: ndviResult.reason,
      places: placesResult
    });

    writeFileSync(outPath, JSON.stringify({
      meta: {
        center: { lat: CENTER_LAT, lon: CENTER_LON },
        bbox, cellsPerSide, cellSpacingM: CELL_SPACING_M,
        generatedAt: new Date().toISOString(),
        cellsCompleted: results.length, cellsTotal: cells.length
      },
      cells: results
    }, null, 2));

    if (idx < cells.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  const totalS = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nWrote ${results.length} cells to ${outPath}`);
  console.log(`Total time: ${totalS}s (${(totalS / 60).toFixed(1)} min)`);
  console.log(`NDVI failures: ${JSON.stringify(ndviFailures)}`);
  console.log(`Places fetch total failures (threw/no result at all): ${placesFailures}`);

  // The actual point of the pilot: prove the lookup mechanism works,
  // against your real home coordinate, with a real result to fact-check.
  console.log(`\n=== Lookup test: home coordinate (${CENTER_LAT}, ${CENTER_LON}) ===`);
  const { cell: nearest, distanceKm } = findNearestCell(CENTER_LAT, CENTER_LON, results);
  console.log(`Nearest cell: [${nearest.cellIndex}] at (${nearest.lat.toFixed(6)}, ${nearest.lon.toFixed(6)}), ${(distanceKm * 1000).toFixed(1)}m from home coordinate`);
  console.log(`Green cover (NDVI): ${nearest.ndvi !== null ? (nearest.ndvi * 100).toFixed(1) + "%" : "null (" + nearest.ndviReason + ")"}`);
  console.log(`Nearby places:`);
  if (nearest.places) {
    for (const [key, val] of Object.entries(nearest.places)) {
      if (val.candidates && val.candidates.length > 0) {
        const top = val.candidates[0];
        console.log(`  ${key}: ${top.name || "(unnamed)"} — ${top.distanceKm}km${val.candidates.length > 1 ? ` (+${val.candidates.length - 1} more)` : ""}`);
      } else {
        console.log(`  ${key}: none found`);
      }
    }
  } else {
    console.log("  (places fetch failed for this cell)");
  }
}

// --- Recheck mode: re-fetches ONE category (e.g. after a ranking-logic
// fix) for every cell already in data/pilot-grid-gowlidoddy.json, without
// touching NDVI or any other category. Much cheaper than a full re-run —
// one narrow Overpass clause per cell instead of all 18 categories — and
// reports which cells' results actually changed, not just that it ran.
async function runRecheck(category) {
  if (!existsSync(outPath)) {
    console.error(`${outPath} doesn't exist yet — run a full pilot pass first.`);
    process.exit(1);
  }
  const def = CATEGORY_DEFS.find(d => d.key === category);
  if (!def) {
    console.error(`Unknown category "${category}". Valid: ${CATEGORY_DEFS.map(d => d.key).join(", ")}`);
    process.exit(1);
  }

  const mirrors = await initOverpassMirrors();
  console.log(`Using mirror order: ${mirrors.join(", ")}\n`);

  const existing = JSON.parse(readFileSync(outPath, "utf8"));
  console.log(`Rechecking "${category}" for ${existing.cells.length} cells...\n`);

  let changed = 0;
  const startTime = Date.now();

  for (let idx = 0; idx < existing.cells.length; idx++) {
    const cell = existing.cells[idx];
    const before = cell.places ? cell.places[category] : null;
    const beforeNames = before && before.candidates ? before.candidates.map(c => c.name).join("|") : "";

    const updated = await fetchPlaces(cell.lat, cell.lon, [def]);
    const after = updated[category];
    const afterNames = after && after.candidates ? after.candidates.map(c => c.name).join("|") : "";

    if (cell.places) cell.places[category] = after;
    const didChange = beforeNames !== afterNames;
    if (didChange) changed++;

    console.log(`[${idx + 1}/${existing.cells.length}] cell [${cell.cellIndex}] — ${didChange ? "CHANGED" : "unchanged"}${didChange ? `: was [${beforeNames}] now [${afterNames}]` : ""}`);

    writeFileSync(outPath, JSON.stringify(existing, null, 2));
    if (idx < existing.cells.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  const totalS = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nRechecked ${existing.cells.length} cells for "${category}" in ${totalS}s. ${changed} cell(s) changed.`);

  const { cell: nearest } = findNearestCell(CENTER_LAT, CENTER_LON, existing.cells);
  console.log(`\nHome-adjacent cell [${nearest.cellIndex}] "${category}" result now:`);
  console.log(JSON.stringify(nearest.places[category], null, 2));
}

const recheckArg = process.argv.find(a => a.startsWith("--recheck="));
if (recheckArg) {
  runRecheck(recheckArg.split("=")[1]);
} else {
  run();
}
