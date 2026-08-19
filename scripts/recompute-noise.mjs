// Recomputes Noise from real road/railway proximity data instead of the
// static per-neighbourhood numbers currently hardcoded in app.html's
// cities object / synced into data/neighbourhoods.json. Reads existing
// data only:
//   - road proximity: data/nearby-places.json's "highway" category
//     (motorway/trunk/primary/secondary, same classification + geometry-
//     walk nearest-vertex logic already built for the Nearby Places
//     "Highway access" card and reused for Infrastructure/Walkability).
//   - railway proximity: data/railway-proximity.json, a fresh one-off
//     Overpass pass (this data didn't exist before - only railway
//     *stations*, a separate point category, had been fetched). See that
//     file's meta block for methodology, the one unresolved fetch gap
//     (Prahlad Nagar), and the under-construction-track caveat affecting
//     Aundh/Baner/Hinjewadi/Old City.
//
// Unlike Infrastructure/Walkability, closer = WORSE here (louder), not
// better - distanceToNoiseScore is the same linear-ramp shape but
// inverted: floor at the near threshold, 10 at the far threshold.
//
// Comparison-only mode (default): prints old-vs-new side by side for
// review. --write updates data/neighbourhoods.json and app.html's
// cities object, same as recompute-infra-walk.mjs's --write mode.
//
// app.html was index.html until the landing-page restructuring — this
// script's target file changed, its actual job didn't.

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { distanceToNoiseScore, ROAD_THRESHOLDS, RAIL_THRESHOLDS, combineNoiseScore } from "./_lib/noise-scoring.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const nearbyPlacesPath = join(__dirname, "..", "data", "nearby-places.json");
const railwayProximityPath = join(__dirname, "..", "data", "railway-proximity.json");
const roadProximityPrecisePath = join(__dirname, "..", "data", "road-proximity-precise.json");
const neighbourhoodsPath = join(__dirname, "..", "data", "neighbourhoods.json");
const indexHtmlPath = join(__dirname, "..", "app.html");
const WRITE_MODE = process.argv.includes("--write");

const nearbyPlaces = JSON.parse(readFileSync(nearbyPlacesPath, "utf8"));
const railwayProximity = JSON.parse(readFileSync(railwayProximityPath, "utf8")).results;
const roadProximityPrecise = JSON.parse(readFileSync(roadProximityPrecisePath, "utf8")).results;
const neighbourhoods = JSON.parse(readFileSync(neighbourhoodsPath, "utf8"));

// data/nearby-places.json's highway category rounds to 1 decimal before
// storage (fetch-nearby-places.mjs line 458) - that collapsed genuinely
// different close distances (0.008km vs 0.04km) into an identical 0.0km,
// which then mechanically floored the road component - and via
// min(road, rail) the whole Noise score - for 23/80 neighbourhoods
// regardless of their real distance within that band. data/road-proximity
// -precise.json is a full-precision re-fetch of the same query, feeding
// only this script. 62/80 resolved after three gentle retry rounds against
// Overpass rate-limiting; the 18 that never resolved (see that file's
// meta.unresolved) fall back to the rounded nearby-places.json value below
// - a real precision loss for exactly those 18, not a guess.
function roadDistanceFor(name, city) {
  const precise = roadProximityPrecise.find(r => r.name === name && r.city === city);
  if (precise && precise.distanceKm !== null) return precise.distanceKm;
  const rounded = nearbyPlaces.find(e => e.name === name && e.city === city);
  return rounded.places.highway.candidates[0].distanceKm;
}

// Data gap, not "no railway nearby" - excluded from recompute entirely,
// per explicit instruction: hold Prahlad Nagar on its old static baseline
// rather than guess a value or fall back to a road-only score.
const UNRESOLVED_GAP_NAMES = new Set(["Prahlad Nagar"]);

// FLOOR/distanceToNoiseScore/ROAD_THRESHOLDS/RAIL_THRESHOLDS now live in
// scripts/_lib/noise-scoring.mjs, shared with api/grid-lookup.js's
// grid-cell exact-point Noise scoring - same values as before this move
// (true p10/p90 of the corrected road distance distribution: 0.0028km/
// 0.4456km; railway p10/p90 of the 79/80 resolved: 0.05km/2.01km), see
// that file for the full threshold-derivation history. 13/79 neighbourhoods
// still land at the exact road floor even with full precision (down from
// 24/79 pre-precision) - a property of the real data (most named-
// neighbourhood coordinates sit within metres of *some* road), not a bug.

function computeNoiseScore(name, city) {
  if (UNRESOLVED_GAP_NAMES.has(name)) return null; // held on old baseline, not recomputed

  const roadDistanceKm = roadDistanceFor(name, city);
  const roadScore = distanceToNoiseScore(roadDistanceKm, ...ROAD_THRESHOLDS);

  const rail = railwayProximity.find(r => r.name === name && r.city === city);
  if (!rail || rail.distanceKm === null) return null; // shouldn't happen for the 79 resolved - defensive only
  const railScore = distanceToNoiseScore(rail.distanceKm, ...RAIL_THRESHOLDS);

  return combineNoiseScore(roadScore, railScore);
}

const results = [];
for (const entry of neighbourhoods) {
  const newNoise = computeNoiseScore(entry.name, entry.city);
  results.push({
    name: entry.name,
    city: entry.city,
    oldNoise: entry.noise,
    newNoise: newNoise !== null ? newNoise : entry.noise,
    isGap: UNRESOLVED_GAP_NAMES.has(entry.name),
    diff: newNoise !== null ? parseFloat((newNoise - entry.noise).toFixed(1)) : 0
  });
}

// --- Report ---
console.log("=== Requested neighbourhoods ===\n");
const requested = ["Bandra", "Dharavi", "Koramangala", "Banjara Hills"];
results.filter(r => requested.includes(r.name)).forEach(r => {
  console.log(`${r.name}, ${r.city}`);
  console.log(`  Noise: ${r.oldNoise} -> ${r.newNoise}  (${r.diff >= 0 ? "+" : ""}${r.diff})`);
  console.log();
});

console.log("=== Prahlad Nagar (data gap - held on old baseline) ===\n");
const gap = results.find(r => r.name === "Prahlad Nagar");
console.log(`${gap.name}, ${gap.city}`);
console.log(`  Noise: ${gap.oldNoise} -> ${gap.newNoise} (unchanged, unresolved railway fetch gap)`);
console.log();

console.log("=== Biggest divergences (by |diff|) ===\n");
const sorted = results
  .filter(r => !r.isGap)
  .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
sorted.slice(0, 6).forEach(r => {
  console.log(`${r.name}, ${r.city}`);
  console.log(`  Noise: ${r.oldNoise} -> ${r.newNoise}  (${r.diff >= 0 ? "+" : ""}${r.diff})`);
  console.log();
});

console.log(`\nTotal: ${results.length} neighbourhoods. ${results.filter(r => r.isGap).length} held on old baseline (data gap). ${results.filter(r => !r.isGap).length} recomputed.`);

if (WRITE_MODE) {
  console.log("\n=== WRITE MODE ===\n");

  // 1. data/neighbourhoods.json
  let jsonUpdated = 0;
  for (const entry of neighbourhoods) {
    const r = results.find(x => x.name === entry.name && x.city === entry.city);
    if (!r || r.isGap) continue;
    entry.noise = r.newNoise;
    jsonUpdated++;
  }
  writeFileSync(neighbourhoodsPath, JSON.stringify(neighbourhoods, null, 2) + "\n");
  console.log(`data/neighbourhoods.json: updated ${jsonUpdated}/${neighbourhoods.length} entries (Prahlad Nagar held unchanged).`);

  // 2. app.html's cities object - same text-level replacement approach
  // as recompute-infra-walk.mjs, matched on name (verified unique across
  // all 80 neighbourhoods before this script was written).
  let html = readFileSync(indexHtmlPath, "utf8");
  let htmlUpdated = 0;
  const notFound = [];
  for (const r of results) {
    if (r.isGap) continue;
    const escapedName = r.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Matches `{ name: "X", ... ndvi: N, noise: N` - lazy wildcard between
    // name and ndvi since entries are column-aligned with variable padding
    // spaces (not a fixed single space), same lesson as
    // recompute-infra-walk.mjs's regex. Captures just the noise value,
    // leaving ndvi and everything after (water/traffic/safety/infra/walk/
    // nearbyProjects) untouched.
    const re = new RegExp(`(\\{ name: "${escapedName}",[^\\r\\n]*?ndvi: [\\d.]+, noise: )(-?[\\d.]+)`);
    if (!re.test(html)) {
      notFound.push(r.name);
      continue;
    }
    html = html.replace(re, (_, pre) => `${pre}${r.newNoise}`);
    htmlUpdated++;
  }
  writeFileSync(indexHtmlPath, html);
  console.log(`app.html: updated ${htmlUpdated}/${results.filter(r => !r.isGap).length} entries.`);
  if (notFound.length > 0) {
    console.log(`NOT FOUND in app.html (skipped, needs manual check): ${notFound.join(", ")}`);
  }
}
