import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// data/pilot-grid-hyderabad-core.json is 23.35MB (2200 cells) — far too
// large to ship to the browser on every Hyderabad address/GPS search (the
// original plan before this file existed). Read once here, at module load,
// kept in memory for this serverless instance's warm lifetime — same
// JSON.parse(readFileSync(...))-at-top-of-file pattern already used by
// api/snapshot.js and api/geocode.js for data/neighbourhoods.json. Every
// actual request then just does an in-memory nearest-cell scan over 2200
// pre-parsed objects (microseconds) and returns a few KB, not 23MB.
const GRID = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "pilot-grid-hyderabad-core.json"), "utf8")
);
const BBOX = GRID.meta.bbox;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Same algorithm as scripts/pilot-grid-hyderabad-core.mjs's own
// findNearestCell (that file is a Node ESM module, not importable into a
// server-route context sharing this exact same logic would need a shared
// module setup this project doesn't otherwise have — reimplemented here,
// not copy-drifted, since it's a short, simple scan).
function findNearestCell(lat, lon, cells) {
  let best = null, bestDistKm = Infinity;
  for (const cell of cells) {
    const d = haversineKm(lat, lon, cell.lat, cell.lon);
    if (d < bestDistKm) { bestDistKm = d; best = cell; }
  }
  return { cell: best, distanceKm: bestDistKm };
}

export default async function handler(req, res) {
  const { lat, lon } = req.query;
  const latF = parseFloat(lat), lonF = parseFloat(lon);
  if (!lat || !lon || isNaN(latF) || isNaN(lonF)) {
    return res.status(400).json({ error: "lat and lon required", inGrid: false, places: null });
  }

  if (latF < BBOX.south || latF > BBOX.north || lonF < BBOX.west || lonF > BBOX.east) {
    return res.status(200).json({ inGrid: false, places: null });
  }

  const { cell, distanceKm } = findNearestCell(latF, lonF, GRID.cells);
  return res.status(200).json({
    inGrid: true,
    places: cell.places,
    cellDistanceKm: parseFloat(distanceKm.toFixed(3))
  });
}
