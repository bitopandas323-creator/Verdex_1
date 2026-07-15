// Recomputes Noise from real road/railway proximity data instead of the
// static per-neighbourhood numbers currently hardcoded in index.html's
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
// review. --write updates data/neighbourhoods.json and index.html's
// cities object, same as recompute-infra-walk.mjs's --write mode.

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const nearbyPlacesPath = join(__dirname, "..", "data", "nearby-places.json");
const railwayProximityPath = join(__dirname, "..", "data", "railway-proximity.json");
const roadProximityPrecisePath = join(__dirname, "..", "data", "road-proximity-precise.json");
const neighbourhoodsPath = join(__dirname, "..", "data", "neighbourhoods.json");
const indexHtmlPath = join(__dirname, "..", "index.html");
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

const FLOOR = 1.5; // same practical-minimum reasoning as Infrastructure/Walkability

// closeKm = empirical p10 nearest-distance across the 80 real
// neighbourhoods (loudest 10%), farKm = empirical p90 (quietest 10%) -
// same convention as Infrastructure/Walkability, just inverted meaning
// since closer is worse here, not better.
function distanceToNoiseScore(distanceKm, closeKm, farKm) {
  if (distanceKm <= closeKm) return FLOOR;
  if (distanceKm >= farKm) return 10;
  return FLOOR + (10 - FLOOR) * (distanceKm - closeKm) / (farKm - closeKm);
}

// closeKm=0.05 (chosen to match rail's own close threshold) turned out to
// be an ad-hoc placeholder, not an empirical value - data/nearby-places.json
// rounds to 1 decimal before storage, which collapsed genuinely different
// close distances (0.008km vs 0.04km) into an identical stored 0.0km and
// mechanically floored 23/80 neighbourhoods' road component regardless of
// their real distance. data/road-proximity-precise.json (62/80 resolved,
// 18 fall back to the rounded value - see that file's meta.unresolved)
// recovers the real distribution: true p10=0.0028km, p90=0.4456km. Even
// with full precision, this remains a very tight range at the close end
// (most named-neighbourhood coordinates sit within metres of *some* road)
// - road proximity alone has limited discriminating power there; the
// railway component carries most of the real differentiation for
// road-adjacent neighbourhoods. 13/79 still land at the exact floor after
// this fix (down from 24/79 pre-precision), a real reduction, not full
// resolution - the remainder is a property of the real data, not a bug.
const ROAD_THRESHOLDS = [0.0028, 0.4456]; // true p10/p90 of the corrected (precise + documented-fallback) road distance distribution
const RAIL_THRESHOLDS = [0.05, 2.01]; // p10/p90 of railway-line nearest distance, 79/80 resolved

function computeNoiseScore(name, city) {
  if (UNRESOLVED_GAP_NAMES.has(name)) return null; // held on old baseline, not recomputed

  const roadDistanceKm = roadDistanceFor(name, city);
  const roadScore = distanceToNoiseScore(roadDistanceKm, ...ROAD_THRESHOLDS);

  const rail = railwayProximity.find(r => r.name === name && r.city === city);
  if (!rail || rail.distanceKm === null) return null; // shouldn't happen for the 79 resolved - defensive only
  const railScore = distanceToNoiseScore(rail.distanceKm, ...RAIL_THRESHOLDS);

  // Worse (louder) of the two dominates - noise doesn't average, the
  // closer/louder source determines the actual ambient experience.
  return parseFloat(Math.min(roadScore, railScore).toFixed(1));
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

  // 2. index.html's cities object - same text-level replacement approach
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
  console.log(`index.html: updated ${htmlUpdated}/${results.filter(r => !r.isGap).length} entries.`);
  if (notFound.length > 0) {
    console.log(`NOT FOUND in index.html (skipped, needs manual check): ${notFound.join(", ")}`);
  }
}
