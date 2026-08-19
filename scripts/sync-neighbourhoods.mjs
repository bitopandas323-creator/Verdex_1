// Regenerates data/neighbourhoods.json from app.html's `cities` object —
// the source of truth. There's no shared-module system between the browser
// page and the serverless functions/scripts that read neighbourhoods.json
// (api/snapshot.js, scripts/fetch-nearby-places.mjs), so this file has to
// be manually re-synced any time baseline values (including lat/lon) are
// edited in app.html. Run after any such edit:
//   node scripts/sync-neighbourhoods.mjs
//
// app.html was index.html until the landing-page restructuring — this
// script's target file changed, its actual job (reading the `cities`
// object) didn't.

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = join(__dirname, "..", "app.html");
const outPath = join(__dirname, "..", "data", "neighbourhoods.json");

const html = readFileSync(indexPath, "utf8");

const startMarker = "const cities = {";
const startIdx = html.indexOf(startMarker);
if (startIdx === -1) throw new Error("Could not find `const cities = {` in app.html");

// Brace-count from the opening `{` to find the matching close, since the
// object contains nested arrays/objects (nearbyProjects).
const objStart = startIdx + startMarker.length - 1; // index of the opening `{`
let depth = 0, i = objStart, objEnd = -1;
for (; i < html.length; i++) {
  if (html[i] === "{") depth++;
  else if (html[i] === "}") {
    depth--;
    if (depth === 0) { objEnd = i; break; }
  }
}
if (objEnd === -1) throw new Error("Could not find matching closing brace for `cities` object");

const objectLiteral = html.slice(objStart, objEnd + 1);
const cities = new Function(`return ${objectLiteral};`)();

const neighbourhoods = [];
for (const [city, entries] of Object.entries(cities)) {
  for (const n of entries) {
    neighbourhoods.push({
      name: n.name,
      city,
      lat: n.lat,
      lon: n.lon,
      ndvi: n.ndvi,
      noise: n.noise,
      water: n.water,
      traffic: n.traffic,
      safety: n.safety,
      infra: n.infra,
      walk: n.walk
    });
  }
}

writeFileSync(outPath, JSON.stringify(neighbourhoods, null, 2) + "\n");
console.log(`Wrote ${neighbourhoods.length} entries to ${outPath}`);
