// Batch job: for each of the 80 neighbourhoods in data/neighbourhoods.json,
// finds the nearest hospital, school, police station, and major-highway
// access point via OpenStreetMap (Overpass). Writes data/nearby-places.json.
//
// This is NOT called live per user search — it's meant to be re-run
// periodically (e.g. monthly) since these facilities rarely change:
//   node scripts/fetch-nearby-places.mjs
//
// Uses bbox + haversine post-filtering rather than Overpass's `around:`
// filter — `around:` was found to time out under load during this project's
// earlier infrastructure/walkability work, and the same lesson applies here.

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NEIGHBOURHOODS = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "neighbourhoods.json"), "utf8")
);

const RADIUS_M = 5000;
const USER_AGENT = "Verdex-NearbyPlaces/1.0 (periodic batch job; contact: bitopandas323@gmail.com)";
const REQUEST_DELAY_MS = 1500;
const OVERPASS_ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// IMPORTANT: the timeout must cover the full request lifecycle, including
// reading/parsing the response body — not just the initial fetch() call.
// An earlier version of this function cleared the AbortController's timer
// as soon as fetch() resolved (i.e. once headers arrived), leaving res.json()
// completely unprotected. Overpass returning a 200 quickly but then dripping
// a large body slowly caused the script to hang indefinitely on a single
// neighbourhood with no way out — confirmed live (script sat on
// "[19/80] Kurla, mumbai" for 10+ minutes with zero progress, far past the
// ~130s worst-case the old per-fetch-only timeout should have guaranteed).
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

async function queryOverpassWithRetry(query) {
  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const data = await fetchJsonWithTimeout(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
          body: "data=" + encodeURIComponent(query)
        }, 15000);
        if (!Array.isArray(data.elements)) throw new Error("no elements");
        return data.elements;
      } catch (err) {
        if (attempt === 1) { await sleep(1500); continue; }
      }
    }
  }
  return null; // both endpoints failed after retry
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

function coordsOf(el) {
  if (el.lat !== undefined) return [el.lat, el.lon];
  if (el.center) return [el.center.lat, el.center.lon];
  return null;
}

// --- Nearest hospital / school / police (combined single query) ---

async function findNearestAmenities(lat, lon) {
  const [s, w, n, e] = bboxAround(lat, lon, RADIUS_M);
  const bbox = `${s},${w},${n},${e}`;
  const query = `
    [out:json][timeout:25];
    (
      nwr["amenity"="hospital"](${bbox});
      nwr["amenity"="school"](${bbox});
      nwr["amenity"="police"](${bbox});
    );
    out center tags;
  `;

  const elements = await queryOverpassWithRetry(query);
  const result = { hospital: null, school: null, police: null };
  if (!elements) {
    console.warn(`    amenities query failed after retries (Overpass unavailable)`);
    return result;
  }

  const nearest = { hospital: null, school: null, police: null };
  for (const el of elements) {
    const amenity = el.tags && el.tags.amenity;
    if (!nearest.hasOwnProperty(amenity)) continue;
    const c = coordsOf(el);
    if (!c) continue;
    const dist = haversineKm(lat, lon, c[0], c[1]);
    if (dist > RADIUS_M / 1000) continue; // bbox is a square superset — enforce true circular radius
    if (!nearest[amenity] || dist < nearest[amenity].distanceKm) {
      nearest[amenity] = { distanceKm: dist, name: (el.tags && el.tags.name) || null };
    }
  }

  for (const key of Object.keys(nearest)) {
    if (nearest[key]) {
      result[key] = { distanceKm: Math.round(nearest[key].distanceKm * 10) / 10, name: nearest[key].name };
    }
  }
  return result;
}

// --- Nearest major-highway access point ---

async function findNearestHighway(lat, lon) {
  const [s, w, n, e] = bboxAround(lat, lon, RADIUS_M);
  const bbox = `${s},${w},${n},${e}`;
  const query = `
    [out:json][timeout:25];
    (
      way["highway"~"^(motorway|trunk|primary|secondary)$"](${bbox});
    );
    out geom;
  `;

  const elements = await queryOverpassWithRetry(query);
  if (!elements) {
    console.warn(`    highway query failed after retries (Overpass unavailable)`);
    return null;
  }

  let nearest = null;
  for (const way of elements) {
    if (!Array.isArray(way.geometry)) continue;
    for (const pt of way.geometry) {
      const dist = haversineKm(lat, lon, pt.lat, pt.lon);
      if (dist > RADIUS_M / 1000) continue;
      if (!nearest || dist < nearest.distanceKm) {
        nearest = { distanceKm: dist, name: (way.tags && (way.tags.name || way.tags.ref)) || null };
      }
    }
  }

  if (!nearest) return null;
  return { distanceKm: Math.round(nearest.distanceKm * 10) / 10, name: nearest.name };
}

// --- Run ---

(async () => {
  console.log(`Fetching nearby places for ${NEIGHBOURHOODS.length} neighbourhoods (radius ${RADIUS_M / 1000}km)...\n`);

  const results = [];
  const missing = [];
  const outPath = join(__dirname, "..", "data", "nearby-places.json");

  for (let i = 0; i < NEIGHBOURHOODS.length; i++) {
    const n = NEIGHBOURHOODS[i];
    console.log(`[${i + 1}/${NEIGHBOURHOODS.length}] ${n.name}, ${n.city}`);

    const amenities = await findNearestAmenities(n.lat, n.lon);
    await sleep(REQUEST_DELAY_MS);
    const highway = await findNearestHighway(n.lat, n.lon);
    await sleep(REQUEST_DELAY_MS);

    const entry = {
      name: n.name,
      city: n.city,
      hospital: amenities.hospital,
      school: amenities.school,
      police: amenities.police,
      highway
    };
    results.push(entry);

    const missingCategories = ["hospital", "school", "police", "highway"].filter(k => !entry[k]);
    if (missingCategories.length > 0) {
      missing.push({ name: n.name, city: n.city, missingCategories });
      console.log(`    missing: ${missingCategories.join(", ")}`);
    }

    // Checkpoint after every neighbourhood — an 80-stop unattended run is
    // long enough that losing all progress to one hang/interrupt near the
    // end is expensive. Cheap to write (a few KB), so no reason not to.
    writeFileSync(outPath, JSON.stringify(results, null, 2));
  }

  console.log(`\nWrote ${results.length} entries to ${outPath}`);

  if (missing.length > 0) {
    console.log(`\n--- ${missing.length} neighbourhoods have at least one missing category ---`);
    missing.forEach(m => console.log(`  ${m.name}, ${m.city}: ${m.missingCategories.join(", ")}`));
    console.log("\nThis usually reflects sparse OpenStreetMap tagging in that area, not a script failure — spot-check a couple on openstreetmap.org before assuming a systematic problem.");
  } else {
    console.log("\nAll neighbourhoods have complete data.");
  }
})();
