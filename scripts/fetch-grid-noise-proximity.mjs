// Extends the Hyderabad/Bangalore grids (data/pilot-grid-{city}-core.json)
// with genuine per-cell road and railway proximity, closing the gap where
// Noise was the only grid-dependent parameter still stuck at
// neighbourhood-level precision in these two cities.
//
// Validated design (see scratchpad test-whole-bbox-noise-query.mjs, run
// against both cities before this script was written): fetching road/rail
// line geometry PER CELL (mirroring how Infrastructure/Transit's places
// were fetched) would mean ~5,532 separate Overpass requests and, based on
// the multi-session Bangalore places saga, likely 10-20+ hours across many
// sessions. That per-cell design is necessary for Infrastructure/Transit
// because point-category candidate ranking (which named hospital, is it a
// chain, distance) genuinely differs cell to cell. Nearest-line-distance
// doesn't have that property — the road/rail network itself is identical
// city-wide. So this fetches each category ONCE per city (4 requests
// total: 2 cities x {road, railway}), each over the grid's bbox padded by
// 5km (matching RADIUS_M in fetch-nearby-places.mjs/the neighbourhood-level
// railway research script), then computes nearest-vertex distance for
// every cell locally in JS from that one response - no further network
// calls. Confirmed live: Hyderabad road 4.8s/3.9MB/4741 elements, Hyderabad
// rail 2.1s/0.84MB/956 elements, Bangalore road 4.9s/6.2MB/7208 elements,
// Bangalore rail 3.0s/1.17MB/1303 elements - all far under Overpass's
// timeout, no tiling needed.
//
// Same query clauses as production: way["highway"~"^(motorway|trunk|
// primary|secondary)$"] (fetch-nearby-places.mjs's "highway" category) and
// way["railway"~"^(rail|subway|light_rail|monorail|narrow_gauge)$"]
// (research-railway-proximity.mjs, deliberately excluding railway=
// construction/abandoned/disused/station/halt/platform - only active
// track is a noise source). Nearest-vertex geometry walk, not true
// point-to-segment interpolation - same simplification already used and
// accepted for the 80-neighbourhood highway/railway proximity data.
//
// Per-cell radius is enforced explicitly (5km), not just "whatever the
// padded bbox happened to include" - a vertex inside the fetched set but
// farther than 5km from a specific cell is excluded, same as
// fetchPlaces's "bbox is a square superset - enforce true circular
// radius" comment. This means a cell can legitimately end up with
// distanceKm: null (no road/rail within 5km) - a real absence, not a
// fetch failure. Confirmed at the existing 80-neighbourhood scale
// (Bangalore's places data alone already has 23/3332 cells with zero
// highway candidates within 5km) that this is expected, not rare.
//
// Stored as NEW fields directly on each grid cell - cell.roadPrecise and
// cell.railway - alongside the existing ndvi/places fields, mirroring how
// those were added. Deliberately does NOT touch cell.places.highway
// (the existing, separately-purposed, 1-decimal-rounded value) - same
// non-destructive precedent as data/road-proximity-precise.json not
// overwriting data/nearby-places.json.
//
// Run: node scripts/fetch-grid-noise-proximity.mjs [--city=hyderabad|bangalore]
// (omit --city to do both, sequentially).

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";
import { initOverpassMirrors } from "./fetch-nearby-places.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const USER_AGENT = "Verdex-GridNoiseProximity/1.0 (batch fetch; contact: bitopandas323@gmail.com)";
const PAD_M = 5000; // matches RADIUS_M convention used for road/rail elsewhere
const RADIUS_KM = 5; // per-cell cutoff, enforced explicitly below
const QUERY_TIMEOUT_MS = 90000;
const OVERPASS_TIMEOUT_S = 80;

const CITIES = ["hyderabad", "bangalore"];
const cityArg = process.argv.find(a => a.startsWith("--city="));
const targetCities = cityArg ? [cityArg.split("=")[1]] : CITIES;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function padBbox(b, padM) {
  const midLat = (b.south + b.north) / 2;
  const padLat = padM / 111320;
  const padLon = padM / (111320 * Math.cos(midLat * Math.PI / 180));
  return {
    south: b.south - padLat, north: b.north + padLat,
    west: b.west - padLon, east: b.east + padLon
  };
}

const QUERY_CLAUSES = {
  roadPrecise: bboxStr => `way["highway"~"^(motorway|trunk|primary|secondary)$"](${bboxStr});`,
  railway: bboxStr => `way["railway"~"^(rail|subway|light_rail|monorail|narrow_gauge)$"](${bboxStr});`
};

async function fetchJsonWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

// Mirrors queryOverpassWithRetry's shape elsewhere in this codebase: try
// each mirror, 2 attempts each with backoff, before giving up.
async function queryOverpassWithRetry(query, mirrors) {
  for (const endpoint of mirrors) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const data = await fetchJsonWithTimeout(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
          body: "data=" + encodeURIComponent(query)
        }, QUERY_TIMEOUT_MS);
        if (!Array.isArray(data.elements)) throw new Error("no elements array in response");
        return data.elements;
      } catch (err) {
        console.warn(`  attempt ${attempt} against ${endpoint} failed: ${err.message}`);
        if (attempt === 1) { await sleep(2000); continue; }
      }
    }
  }
  return null;
}

// Nearest-vertex geometry walk within RADIUS_KM, same simplification as
// fetchPlaces's highway handling and research-railway-proximity.mjs -
// each way contributes at most its own single nearest (in-range) vertex.
function nearestWithinRadius(lat, lon, ways) {
  let nearest = null;
  let nearestName = null;
  for (const way of ways) {
    if (!Array.isArray(way.geometry)) continue;
    for (const pt of way.geometry) {
      const d = haversineKm(lat, lon, pt.lat, pt.lon);
      if (d > RADIUS_KM) continue;
      if (nearest === null || d < nearest) {
        nearest = d;
        nearestName = (way.tags && (way.tags.name || way.tags.ref)) || null;
      }
    }
  }
  return { distanceKm: nearest, name: nearestName };
}

async function processCity(city) {
  const gridPath = join(__dirname, "..", "data", `pilot-grid-${city}-core.json`);
  const grid = JSON.parse(readFileSync(gridPath, "utf8"));
  const bbox = grid.meta.bbox;
  const paddedBbox = padBbox(bbox, PAD_M);
  const bboxStr = `${paddedBbox.south},${paddedBbox.west},${paddedBbox.north},${paddedBbox.east}`;

  console.log(`\n=== ${city} (${grid.cells.length} cells) ===`);
  console.log(`Padded bbox: ${bboxStr}`);

  const mirrors = await initOverpassMirrors();
  console.log(`Mirror order: ${mirrors.join(", ")}`);

  const fetchedByKey = {};
  for (const [key, clauseFn] of Object.entries(QUERY_CLAUSES)) {
    const query = `[out:json][timeout:${OVERPASS_TIMEOUT_S}];\n(\n  ${clauseFn(bboxStr)}\n);\nout geom tags;`;
    console.log(`\nFetching ${key}...`);
    const start = Date.now();
    const elements = await queryOverpassWithRetry(query, mirrors);
    const elapsedS = ((Date.now() - start) / 1000).toFixed(1);
    if (!elements) {
      console.error(`FAILED to fetch ${key} for ${city} after retries across all mirrors. Aborting this city - grid file left unchanged.`);
      return { city, ok: false };
    }
    const ways = elements.filter(el => el.type === "way" && Array.isArray(el.geometry));
    console.log(`Got ${elements.length} elements (${ways.length} usable ways) in ${elapsedS}s`);
    fetchedByKey[key] = ways;
  }

  console.log(`\nComputing nearest-vertex distances for ${grid.cells.length} cells...`);
  const computeStart = Date.now();
  let roadNullCount = 0, railNullCount = 0;
  for (const cell of grid.cells) {
    cell.roadPrecise = nearestWithinRadius(cell.lat, cell.lon, fetchedByKey.roadPrecise);
    cell.railway = nearestWithinRadius(cell.lat, cell.lon, fetchedByKey.railway);
    if (cell.roadPrecise.distanceKm === null) roadNullCount++;
    if (cell.railway.distanceKm === null) railNullCount++;
  }
  const computeS = ((Date.now() - computeStart) / 1000).toFixed(1);
  console.log(`Done in ${computeS}s. No-road-within-${RADIUS_KM}km: ${roadNullCount}/${grid.cells.length}. No-rail-within-${RADIUS_KM}km: ${railNullCount}/${grid.cells.length}.`);

  grid.meta.noiseProximityFetchedAt = new Date().toISOString();
  grid.meta.noiseProximityMethod = `way[highway~motorway|trunk|primary|secondary] and way[railway~rail|subway|light_rail|monorail|narrow_gauge], single query per city over the grid bbox padded ${PAD_M / 1000}km, nearest-vertex geometry walk per cell within ${RADIUS_KM}km (scripts/fetch-grid-noise-proximity.mjs). Feeds Noise scoring via scripts/_lib/noise-scoring.mjs - does not touch cell.places.highway.`;

  writeFileSync(gridPath, JSON.stringify(grid, null, 2));
  console.log(`Wrote ${gridPath}`);
  return { city, ok: true, roadNullCount, railNullCount, totalCells: grid.cells.length };
}

async function run() {
  console.log(`Processing: ${targetCities.join(", ")}`);
  const results = [];
  for (const city of targetCities) {
    const result = await processCity(city);
    results.push(result);
    if (!result.ok) {
      console.error(`\n${city} failed - stopping (not attempting remaining cities in this run).`);
      break;
    }
  }

  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    if (r.ok) {
      console.log(`${r.city}: OK - ${r.totalCells} cells, ${r.roadNullCount} with no road in range, ${r.railNullCount} with no rail in range.`);
    } else {
      console.log(`${r.city}: FAILED`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
