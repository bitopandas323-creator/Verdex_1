import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { computeInfraScore, computeWalkScore } from "../scripts/_lib/infra-walk-scoring.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Replaces the old, Hyderabad-only api/hyderabad-grid-lookup.js now that a
// second city (Bangalore) has its own precomputed grid. Adding a third city
// later is one line here, not a second copy of this file — everything below
// operates on "whichever registered grid's bbox contains this point", never
// on a specific city by name.
//
// Each grid file is large (Hyderabad: 23.35MB/2200 cells, Bangalore:
// similar scale/3332 cells) — far too large to ship to the browser per
// search. Read once here, at module load, kept in memory for this
// serverless instance's warm lifetime, same JSON.parse(readFileSync(...))
// pattern used by api/snapshot.js and api/geocode.js. Every actual request
// then does an in-memory nearest-cell scan (microseconds) over just the one
// matched grid's cells and returns a few KB, not the whole file.
const GRID_REGISTRY = [
  { city: "hyderabad", file: "pilot-grid-hyderabad-core.json" },
  { city: "bangalore", file: "pilot-grid-bangalore-core.json" }
];

const GRIDS = GRID_REGISTRY.map(({ city, file }) => {
  const parsed = JSON.parse(readFileSync(join(__dirname, "..", "data", file), "utf8"));
  return { city, bbox: parsed.meta.bbox, cells: parsed.cells };
});

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Same algorithm as scripts/pilot-grid-hyderabad-core.mjs's own
// findNearestCell — reimplemented here rather than imported since it's a
// short, simple scan and not worth a shared module on its own. The
// Infrastructure/Transit scoring formula below gets the opposite
// treatment (imported from scripts/_lib/infra-walk-scoring.mjs, not
// reimplemented) precisely because it ISN'T simple — 9+ category
// thresholds and a weighted combination are exactly the kind of logic
// that silently drifts out of sync if duplicated.
function findNearestCell(lat, lon, cells) {
  let best = null, bestDistKm = Infinity;
  for (const cell of cells) {
    const d = haversineKm(lat, lon, cell.lat, cell.lon);
    if (d < bestDistKm) { bestDistKm = d; best = cell; }
  }
  return { cell: best, distanceKm: bestDistKm };
}

// Cities' grids don't overlap (Hyderabad and Bangalore are ~500km apart),
// so the first bbox match is the only match — no need to compare distances
// across grids.
function findGridForPoint(lat, lon) {
  return GRIDS.find(g =>
    lat >= g.bbox.south && lat <= g.bbox.north && lon >= g.bbox.west && lon <= g.bbox.east
  ) || null;
}

export default async function handler(req, res) {
  const { lat, lon } = req.query;
  const latF = parseFloat(lat), lonF = parseFloat(lon);
  if (!lat || !lon || isNaN(latF) || isNaN(lonF)) {
    return res.status(400).json({ error: "lat and lon required", inGrid: false, places: null });
  }

  const grid = findGridForPoint(latF, lonF);
  if (!grid) {
    return res.status(200).json({ inGrid: false, places: null });
  }

  const { cell, distanceKm } = findNearestCell(latF, lonF, grid.cells);
  // Exact-point Infrastructure/Transit & Amenity Access, computed here
  // from this cell's own places data (same fetchPlaces/CATEGORY_DEFS
  // schema as data/nearby-places.json, same formula as the 80-
  // neighbourhood batch — no new Overpass calls, pure computation over
  // data that already exists). null when a cell has zero data for a
  // category (computeInfraScore/computeWalkScore's own existing
  // behavior) — callers should treat null as "exact score unavailable,
  // fall back to the neighbourhood baseline" rather than a zero score.
  const infraScore = computeInfraScore(cell.places);
  const walkScore = computeWalkScore(cell.places);
  return res.status(200).json({
    inGrid: true,
    city: grid.city,
    places: cell.places,
    infraScore,
    walkScore,
    cellDistanceKm: parseFloat(distanceKm.toFixed(3))
  });
}
