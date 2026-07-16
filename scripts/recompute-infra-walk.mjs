// Recomputes Infrastructure and Walkability from real Nearby Places data
// (data/nearby-places.json) instead of the static per-neighbourhood
// numbers currently hardcoded in index.html's cities object / synced into
// data/neighbourhoods.json. Reads existing data only — no new Overpass
// calls, this is a computation change, not a data-fetching job.
//
// Comparison-only mode (this file, as run tonight): prints old-vs-new
// side by side for review. Does NOT write to data/neighbourhoods.json or
// index.html — that's a separate step once the formula is confirmed.
//
// See scripts/recompute-infra-walk-notes.md-equivalent reasoning in the
// conversation this was designed in: thresholds are the empirical 10th/
// 90th percentile nearest-distance across all 80 real neighbourhoods per
// category (10th = full score, 90th = zero), not guessed numbers.

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { computeInfraScore, computeWalkScore } from "./_lib/infra-walk-scoring.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const nearbyPlacesPath = join(__dirname, "..", "data", "nearby-places.json");
const neighbourhoodsPath = join(__dirname, "..", "data", "neighbourhoods.json");
const indexHtmlPath = join(__dirname, "..", "index.html");
const WRITE_MODE = process.argv.includes("--write");

const nearbyPlaces = JSON.parse(readFileSync(nearbyPlacesPath, "utf8"));
const neighbourhoods = JSON.parse(readFileSync(neighbourhoodsPath, "utf8"));

// Formula (distanceToScore, thresholds, computeInfraScore/computeWalkScore)
// lives in scripts/_lib/infra-walk-scoring.mjs now, shared with
// api/hyderabad-grid-lookup.js's exact-point computation for Hyderabad
// grid hits — same functions, not a parallel implementation.

const results = [];
for (const entry of nearbyPlaces) {
  const oldEntry = neighbourhoods.find(n => n.name === entry.name && n.city === entry.city);
  if (!oldEntry) continue;
  const newInfra = computeInfraScore(entry.places);
  const newWalk = computeWalkScore(entry.places);
  results.push({
    name: entry.name,
    city: entry.city,
    oldInfra: oldEntry.infra,
    newInfra,
    infraDiff: newInfra !== null ? parseFloat((newInfra - oldEntry.infra).toFixed(1)) : null,
    oldWalk: oldEntry.walk,
    newWalk,
    walkDiff: newWalk !== null ? parseFloat((newWalk - oldEntry.walk).toFixed(1)) : null
  });
}

// --- Report ---
console.log("=== Requested neighbourhoods ===\n");
const requested = ["Bandra", "Dharavi", "Koramangala", "Banjara Hills", "New Town", "Dumdum"];
results.filter(r => requested.includes(r.name)).forEach(r => {
  console.log(`${r.name}, ${r.city}`);
  console.log(`  Infrastructure: ${r.oldInfra} -> ${r.newInfra}  (${r.infraDiff >= 0 ? "+" : ""}${r.infraDiff})`);
  console.log(`  Walkability:    ${r.oldWalk} -> ${r.newWalk}  (${r.walkDiff >= 0 ? "+" : ""}${r.walkDiff})`);
  console.log();
});

console.log("=== Biggest divergences (by combined |infraDiff| + |walkDiff|) ===\n");
const sorted = results
  .filter(r => r.infraDiff !== null && r.walkDiff !== null)
  .sort((a, b) => (Math.abs(b.infraDiff) + Math.abs(b.walkDiff)) - (Math.abs(a.infraDiff) + Math.abs(a.walkDiff)));
sorted.slice(0, 5).forEach(r => {
  console.log(`${r.name}, ${r.city}`);
  console.log(`  Infrastructure: ${r.oldInfra} -> ${r.newInfra}  (${r.infraDiff >= 0 ? "+" : ""}${r.infraDiff})`);
  console.log(`  Walkability:    ${r.oldWalk} -> ${r.newWalk}  (${r.walkDiff >= 0 ? "+" : ""}${r.walkDiff})`);
  console.log();
});

console.log(`\nTotal: ${results.length} neighbourhoods computed. ${results.filter(r=>r.newInfra===null).length} with no infra score (all 9 categories missing — should be 0). ${results.filter(r=>r.newWalk===null).length} with no walk score.`);

if (WRITE_MODE) {
  console.log("\n=== WRITE MODE ===\n");

  // 1. data/neighbourhoods.json — straightforward field update, matched by
  // the same name+city key already used for the comparison above.
  let jsonUpdated = 0;
  for (const entry of neighbourhoods) {
    const r = results.find(x => x.name === entry.name && x.city === entry.city);
    if (!r || r.newInfra === null || r.newWalk === null) continue;
    entry.infra = r.newInfra;
    entry.walk = r.newWalk;
    jsonUpdated++;
  }
  writeFileSync(neighbourhoodsPath, JSON.stringify(neighbourhoods, null, 2) + "\n");
  console.log(`data/neighbourhoods.json: updated ${jsonUpdated}/${neighbourhoods.length} entries.`);

  // 2. index.html's cities object — text-level replacement. Names are
  // unique across all 80 neighbourhoods (verified separately before this
  // script was extended), so matching on `name: "X"` alone is safe — no
  // risk of touching the wrong city's entry with the same name.
  let html = readFileSync(indexHtmlPath, "utf8");
  let htmlUpdated = 0;
  const notFound = [];
  for (const r of results) {
    if (r.newInfra === null || r.newWalk === null) continue;
    const escapedName = r.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Matches `{ name: "X", ... infra: N, walk: N` — no trailing `},`
    // requirement, since 17 entries have a nearbyProjects block continuing
    // past walk on the same line rather than closing immediately. Only the
    // two captured numbers are replaced; everything else on the line
    // (lat/lon/ndvi/noise/water/traffic/safety, and whatever follows walk)
    // is left untouched.
    const re = new RegExp(
      `(\\{ name: "${escapedName}",[^\\r\\n]*?infra: )(-?[\\d.]+)(, walk: )(-?[\\d.]+)`
    );
    if (!re.test(html)) {
      notFound.push(r.name);
      continue;
    }
    html = html.replace(re, (_, pre, _oldInfra, mid, _oldWalk) => `${pre}${r.newInfra}${mid}${r.newWalk}`);
    htmlUpdated++;
  }
  writeFileSync(indexHtmlPath, html);
  console.log(`index.html: updated ${htmlUpdated}/${results.filter(r => r.newInfra !== null && r.newWalk !== null).length} entries.`);
  if (notFound.length > 0) {
    console.log(`NOT FOUND in index.html (skipped, needs manual check): ${notFound.join(", ")}`);
  }
}
