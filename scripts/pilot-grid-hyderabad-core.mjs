// Scaled-up pilot: same grid + snap-to-nearest-cell mechanism as the
// Gowlidoddy pilot (scripts/pilot-grid-gowlidoddy.mjs), but covering
// Hyderabad's urban core at 500m spacing instead of one 3km test box at
// 250m. Still a standalone experiment — writes
// data/pilot-grid-hyderabad-core.json and nothing else, NOT wired into
// index.html.
//
// Bounding box is derived dynamically from the 10 existing Hyderabad
// neighbourhoods' actual stored coordinates in data/neighbourhoods.json
// (min/max lat/lon + padding) — deliberately NOT the full administrative
// Greater Hyderabad boundary, just the area spanning where the app's own
// neighbourhoods actually sit. Recomputed from source data every run
// rather than hardcoded, same reasoning as api/geocode.js's CITY_BBOXES.
//
// Reuses everything already proven tonight:
//   - initOverpassMirrors() — the mirror-benchmark fix (without it, the
//     first Gowlidoddy run took ~118min instead of ~20min).
//   - fetchPlaces/CATEGORY_DEFS/selectCandidates — same Overpass query
//     construction, prominence ranking (including the nearest-regardless-
//     of-tier fix), chain-name matching, wiki-tag detection as production.
//   - NDVI via the deployed /api/ndvi endpoint — credential-free reuse of
//     the fixed Sentinel Hub logic.
//   - Checkpointing: writes progressively after every cell AND, new here,
//     genuinely resumes on restart — loads any existing output file,
//     skips cells already completed, only fetches what's left. Needed at
//     this scale (2200 cells) to safely split across multiple sessions
//     rather than one long continuous run.
//
// Run: node scripts/pilot-grid-hyderabad-core.mjs [--limit=N]

import { writeFileSync, readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { fetchPlaces, CATEGORY_DEFS, initOverpassMirrors } from "./fetch-nearby-places.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "data", "pilot-grid-hyderabad-core.json");
const neighbourhoodsPath = join(__dirname, "..", "data", "neighbourhoods.json");

const CELL_SPACING_M = 500;
const BBOX_PADDING_M = 2500; // 2.5km, middle of the requested 2-3km range
const NDVI_ENDPOINT = "https://verdex-1.vercel.app/api/ndvi";
const NDVI_TIMEOUT_MS = 30000;
const REQUEST_DELAY_MS = 1500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeBbox() {
  const all = JSON.parse(readFileSync(neighbourhoodsPath, "utf8"));
  const hyd = all.filter(n => n.city === "hyderabad");
  const minLat = Math.min(...hyd.map(n => n.lat));
  const maxLat = Math.max(...hyd.map(n => n.lat));
  const minLon = Math.min(...hyd.map(n => n.lon));
  const maxLon = Math.max(...hyd.map(n => n.lon));
  const midLat = (minLat + maxLat) / 2;
  const padLatDeg = BBOX_PADDING_M / 111320;
  const padLonDeg = BBOX_PADDING_M / (111320 * Math.cos(midLat * Math.PI / 180));
  return {
    south: minLat - padLatDeg,
    north: maxLat + padLatDeg,
    west: minLon - padLonDeg,
    east: maxLon + padLonDeg,
    sourceNeighbourhoods: hyd.map(n => n.name)
  };
}

function buildGrid(bbox, spacingM) {
  const widthKm = haversineKm(bbox.south, bbox.west, bbox.south, bbox.east);
  const heightKm = haversineKm(bbox.south, bbox.west, bbox.north, bbox.west);
  const cols = Math.round((widthKm * 1000) / spacingM);
  const rows = Math.round((heightKm * 1000) / spacingM);
  const latStep = (bbox.north - bbox.south) / rows;
  const lonStep = (bbox.east - bbox.west) / cols;
  const cells = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      cells.push({
        cellIndex: [i, j],
        lat: bbox.south + latStep * (i + 0.5),
        lon: bbox.west + lonStep * (j + 0.5)
      });
    }
  }
  return { cells, cols, rows, widthKm, heightKm };
}

export function findNearestCell(lat, lon, cells) {
  let best = null, bestDistKm = Infinity;
  for (const cell of cells) {
    const d = haversineKm(lat, lon, cell.lat, cell.lon);
    if (d < bestDistKm) { bestDistKm = d; best = cell; }
  }
  return { cell: best, distanceKm: bestDistKm };
}

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

function cellKey(cellIndex) { return cellIndex[0] + "," + cellIndex[1]; }

async function run() {
  const limitArg = process.argv.find(a => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;

  const bbox = computeBbox();
  const { cells: allCells, cols, rows, widthKm, heightKm } = buildGrid(bbox, CELL_SPACING_M);
  console.log(`Bbox derived from: ${bbox.sourceNeighbourhoods.join(", ")}`);
  console.log(`Bounding box (+${BBOX_PADDING_M / 1000}km padding): south=${bbox.south.toFixed(6)} west=${bbox.west.toFixed(6)} north=${bbox.north.toFixed(6)} east=${bbox.east.toFixed(6)}`);
  console.log(`Box size: ${widthKm.toFixed(2)}km x ${heightKm.toFixed(2)}km`);
  console.log(`Grid: ${cols} cols x ${rows} rows = ${allCells.length} cells at ${CELL_SPACING_M}m spacing\n`);

  // Resume support: load any existing output, keep completed cells, only
  // fetch what's left. Matched by cellIndex, not array position, so this
  // is safe even if the grid itself hasn't changed between runs (it
  // won't, since it's deterministically derived from the same source
  // data) but is robust either way.
  let existingCells = [];
  if (existsSync(outPath)) {
    const existing = JSON.parse(readFileSync(outPath, "utf8"));
    existingCells = existing.cells || [];
    console.log(`Resuming: found ${existingCells.length}/${allCells.length} cells already completed in ${outPath}\n`);
  }
  const doneKeys = new Set(existingCells.map(c => cellKey(c.cellIndex)));
  let remaining = allCells.filter(c => !doneKeys.has(cellKey(c.cellIndex)));
  if (limit) remaining = remaining.slice(0, limit);

  if (remaining.length === 0) {
    console.log("Nothing left to do — all cells already completed.");
    return;
  }
  console.log(`Fetching ${remaining.length} cell(s)${limit ? ` (--limit=${limit})` : ""}...\n`);

  const mirrors = await initOverpassMirrors();
  console.log(`Using mirror order: ${mirrors.join(", ")}\n`);

  const startTime = Date.now();
  const ndviFailures = { timeout: 0, nonOk: 0, exception: 0, noReading: 0 };
  let placesFailures = 0;
  const results = existingCells.slice();

  for (let idx = 0; idx < remaining.length; idx++) {
    const cell = remaining[idx];
    const cellStart = Date.now();

    const [ndviResult, placesResult] = await Promise.all([
      fetchNdviForCell(cell.lat, cell.lon),
      fetchPlaces(cell.lat, cell.lon, CATEGORY_DEFS).catch(err => {
        placesFailures++;
        console.warn(`  [${idx + 1}/${remaining.length}] Places fetch threw an exception: ${err.message}`);
        return null;
      })
    ]);

    if (ndviResult.failureKind) ndviFailures[ndviResult.failureKind]++;

    const elapsedS = ((Date.now() - cellStart) / 1000).toFixed(1);
    console.log(`[${idx + 1}/${remaining.length}] cell [${cell.cellIndex}] (${cell.lat.toFixed(6)}, ${cell.lon.toFixed(6)}) — ndvi=${ndviResult.ndvi !== null ? ndviResult.ndvi : "null (" + ndviResult.reason + ")"} — ${summarizePlaces(placesResult)} — ${elapsedS}s`);

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
        bbox, cols, rows, cellSpacingM: CELL_SPACING_M,
        generatedAt: new Date().toISOString(),
        cellsCompleted: results.length, cellsTotal: allCells.length
      },
      cells: results
    }, null, 2));

    if (idx < remaining.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  const totalS = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nWrote ${results.length}/${allCells.length} total cells to ${outPath}`);
  console.log(`This run: ${remaining.length} cells in ${totalS}s (${(totalS / 60).toFixed(1)} min, avg ${(totalS / remaining.length).toFixed(1)}s/cell)`);
  console.log(`NDVI failures this run: ${JSON.stringify(ndviFailures)}`);
  console.log(`Places fetch total failures this run: ${placesFailures}`);
  if (results.length < allCells.length) {
    console.log(`${allCells.length - results.length} cells remaining — re-run the same command to resume.`);
  }
}

run();
