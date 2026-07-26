// Fetches nearest active railway-line distance for neighbourhoods, feeding
// scripts/recompute-noise.mjs's rail component (there's no fallback path
// for this the way road distance falls back to data/nearby-places.json's
// rounded highway value - a neighbourhood with no entry here simply can't
// get a real Noise score computed). Promoted from a one-off research
// script used for the original 80-neighbourhood rollout into a permanent,
// reusable script here, since adding a new city needs this exact same
// step again.
//
// railway=rail|subway|light_rail|monorail|narrow_gauge covers Indian
// Railways mainline track, metro systems (commonly tagged railway=subway
// in OSM even when elevated/at-grade), light rail and monorail. Excludes
// railway=station/halt/platform (point infra, not track) and
// railway=abandoned/disused/construction (not an active noise source).
// Same query, same 5km radius, same nearest-vertex geometry walk as the
// original 80-neighbourhood pass (data/railway-proximity.json's own
// meta.method).
//
// Incremental by default: only fetches neighbourhoods from data/
// neighbourhoods.json that don't already have a (non-failed) entry in
// data/railway-proximity.json, so re-running after adding a new city only
// hits Overpass for the new entries, not all 80+.
//
// Run: node scripts/fetch-railway-proximity.mjs [--only=Name1,Name2] [--retry-failed]

import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";
import { initOverpassMirrors } from "./fetch-nearby-places.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const neighbourhoodsPath = join(__dirname, "..", "data", "neighbourhoods.json");
const outPath = join(__dirname, "..", "data", "railway-proximity.json");

const RADIUS_M = 5000;
const USER_AGENT = "Verdex-RailwayProximity/1.0 (batch fetch; contact: bitopandas323@gmail.com)";
const RAILWAY_RE = /^(rail|subway|light_rail|monorail|narrow_gauge)$/;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}

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

async function queryOverpassWithRetry(query, mirrors) {
  for (const endpoint of mirrors) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const data = await fetchJsonWithTimeout(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
          body: "data=" + encodeURIComponent(query)
        }, 45000);
        if (!Array.isArray(data.elements)) throw new Error("no elements");
        return data.elements;
      } catch (err) {
        if (attempt === 1) { await sleep(1500); continue; }
      }
    }
  }
  return null;
}

function nearestRailwayDistance(lat, lon, elements) {
  let nearest = null, nearestName = null;
  for (const el of elements) {
    if (el.type !== "way" || !el.tags || !RAILWAY_RE.test(el.tags.railway || "")) continue;
    if (!Array.isArray(el.geometry)) continue;
    for (const pt of el.geometry) {
      const d = haversineKm(lat, lon, pt.lat, pt.lon);
      if (d > RADIUS_M / 1000) continue;
      if (nearest === null || d < nearest) { nearest = d; nearestName = el.tags.name || el.tags.ref || null; }
    }
  }
  return { distanceKm: nearest, name: nearestName };
}

async function fetchOne(n, mirrors) {
  const [s, w, north, e] = bboxAround(n.lat, n.lon, RADIUS_M);
  const query = `[out:json][timeout:25];\n(\n  way["railway"~"^(rail|subway|light_rail|monorail|narrow_gauge)$"](${s},${w},${north},${e});\n);\nout geom tags;`;
  const elements = await queryOverpassWithRetry(query, mirrors);
  if (!elements) {
    return { name: n.name, city: n.city, distanceKm: null, railName: null, reason: "retry_exhausted" };
  }
  const { distanceKm, name: railName } = nearestRailwayDistance(n.lat, n.lon, elements);
  return { name: n.name, city: n.city, distanceKm, railName, reason: distanceKm === null ? "no_match_found" : null };
}

function loadOutput() {
  if (!existsSync(outPath)) {
    return { meta: { generatedAt: null, method: null, knownGaps: [], knownCaveats: [] }, results: [] };
  }
  return JSON.parse(readFileSync(outPath, "utf8"));
}

async function run() {
  const args = process.argv.slice(2);
  const onlyArg = args.find(a => a.startsWith("--only="));
  const retryFailed = args.includes("--retry-failed");

  const neighbourhoods = JSON.parse(readFileSync(neighbourhoodsPath, "utf8"));
  const output = loadOutput();

  let targets;
  if (onlyArg) {
    const names = onlyArg.split("=")[1].split(",").map(n => n.trim()).filter(Boolean);
    targets = neighbourhoods.filter(n => names.includes(n.name));
    const missing = names.filter(name => !targets.some(t => t.name === name));
    if (missing.length > 0) console.warn(`Not found in data/neighbourhoods.json (skipped): ${missing.join(", ")}`);
  } else if (retryFailed) {
    const failedKeys = new Set(output.results.filter(r => r.reason === "retry_exhausted").map(r => r.city + "|" + r.name));
    targets = neighbourhoods.filter(n => failedKeys.has(n.city + "|" + n.name));
  } else {
    const doneKeys = new Set(output.results.filter(r => r.distanceKm !== null || r.reason === "no_match_found").map(r => r.city + "|" + r.name));
    targets = neighbourhoods.filter(n => !doneKeys.has(n.city + "|" + n.name));
  }

  if (targets.length === 0) {
    console.log("Nothing to do.");
    return;
  }
  console.log(`Fetching railway proximity for ${targets.length} neighbourhood(s)...\n`);

  const mirrors = await initOverpassMirrors();
  console.log(`Mirror order: ${mirrors.join(", ")}\n`);

  for (let i = 0; i < targets.length; i++) {
    const n = targets[i];
    const result = await fetchOne(n, mirrors);
    const idx = output.results.findIndex(r => r.name === n.name && r.city === n.city);
    if (idx === -1) output.results.push(result);
    else output.results[idx] = result;

    console.log(`[${i + 1}/${targets.length}] ${n.name}, ${n.city} — ${result.distanceKm !== null ? result.distanceKm.toFixed(2) + "km (" + result.railName + ")" : result.reason}`);
    writeFileSync(outPath, JSON.stringify(output, null, 2));
    if (i < targets.length - 1) await sleep(1500);
  }

  const failedCount = output.results.filter(r => r.reason === "retry_exhausted").length;
  console.log(`\nWrote ${output.results.length} total entries to ${outPath}`);
  if (failedCount > 0) console.log(`${failedCount} entries failed to fetch — re-run with --retry-failed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
