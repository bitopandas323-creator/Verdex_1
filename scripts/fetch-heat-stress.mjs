// Batch job: for each of the 80 neighbourhoods in data/neighbourhoods.json,
// pulls 10 years (2016-2025) of daily max temperature from Open-Meteo's
// historical/archive API (a separate endpoint from the live forecast API
// used elsewhere in this app — archive-api.open-meteo.com, not
// api.open-meteo.com) and computes a heat-stress metric grounded in IMD's
// real published heat wave criteria. Writes data/heat-stress.json.
//
// Metric: average number of days per year, in the March-June heat wave
// season (IMD/NDMA's own defined season), with max temperature >= 40C
// (IMD's "plains" heat wave qualifying threshold — the simpler, absolute
// half of IMD's definition; their full departure-from-30-year-normal
// methodology needs a climatological baseline this app doesn't have and
// isn't worth building for this scope). Applied uniformly across all 8
// cities for simplicity, even though IMD's own threshold for coastal
// cities (Mumbai, Chennai) is technically lower (37C) — a deliberate
// simplification, not an oversight.
//
// Sanity-checked against real, well-known climate differences before
// building this: Delhi averaged ~26.5 hot days/year, Hyderabad ~2.1,
// Bangalore ~0 (2016-2025, central-city test coordinates) — a believable,
// well-differentiated gradient matching each city's real reputation, not
// a degenerate all-zero or all-maxed result.
//
// apparent_temperature_max (feels-like) is fetched in the same request
// (free — no extra requests) and its seasonal average is stored per
// neighbourhood, but NOT part of the headline hot-day count and not
// currently surfaced in the UI — available for a future secondary stat.
//
// This is NOT called live per user search — climate history changes
// slowly. Meant to be re-run infrequently (e.g. yearly), unlike the
// hourly snapshot pipeline:
//   node scripts/fetch-heat-stress.mjs             (full run, all 80)
//   node scripts/fetch-heat-stress.mjs --limit=5   (test run, first N)

import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NEIGHBOURHOODS = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "neighbourhoods.json"), "utf8")
);

const ARCHIVE_ENDPOINT = "https://archive-api.open-meteo.com/v1/archive";
const START_DATE = "2016-01-01";
const END_DATE = "2025-12-31";
const SEASON_START_MONTH = 3; // March
const SEASON_END_MONTH = 6;   // June — IMD/NDMA's own defined heat wave season
const HOT_DAY_THRESHOLD_C = 40; // IMD's "plains" heat wave qualifying threshold

// Empirically tested (see conversation this was designed in): a single
// 10-year, 2-field request takes 5-14s depending on concurrent load; 5
// concurrent requests completed in ~14s with zero 429s. Matches this
// codebase's established safe concurrency for other batch jobs
// (fetch-nearby-places.mjs, api/snapshot.js).
const CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = 20000;

const outPath = join(__dirname, "..", "data", "heat-stress.json");

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchHistoricalOnce(lat, lon) {
  const url = `${ARCHIVE_ENDPOINT}?latitude=${lat}&longitude=${lon}`
    + `&start_date=${START_DATE}&end_date=${END_DATE}`
    + `&daily=temperature_2m_max,apparent_temperature_max`
    + `&timezone=Asia%2FKolkata`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 429) return { data: null, reason: "HTTP 429", isRateLimit: true };
    if (!res.ok) return { data: null, reason: `HTTP ${res.status}` };
    const data = await res.json();
    if (!data.daily || !Array.isArray(data.daily.time)) {
      return { data: null, reason: "malformed response (no daily.time array)" };
    }
    return { data, reason: null };
  } catch (e) {
    if (e.name === "AbortError") return { data: null, reason: "client timeout" };
    return { data: null, reason: `exception: ${e.message}` };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Same hard-deadline+retry pattern as fetchNdviForCell in
// scripts/pilot-grid-hyderabad-core.mjs, extended with 429-aware backoff:
// a first full run at CONCURRENCY=5 with no inter-batch delay hit HTTP 429
// on 65/80 neighbourhoods after the first ~15 requests (3 batches) — the
// archive API's real sustained-load limit is tighter than a single
// isolated batch of 5 revealed. Manually confirmed live that the limit
// window is short (a retry seconds later already returned 200), so 429s
// get MORE attempts with LONGER backoff (5s, then 15s) than other
// transient failures (which keep the original 1.5s retry), rather than
// giving up after one retry.
async function fetchHistoricalForNeighbourhood(lat, lon) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const hardDeadline = new Promise(resolve =>
      setTimeout(() => resolve({ data: null, reason: "hard deadline exceeded (underlying fetch never settled)" }), REQUEST_TIMEOUT_MS + 5000)
    );
    const result = await Promise.race([fetchHistoricalOnce(lat, lon), hardDeadline]);
    if (result.data || attempt === maxAttempts) return result;
    if (result.isRateLimit) {
      await sleep(attempt === 1 ? 5000 : 15000);
    } else {
      await sleep(1500);
    }
  }
}

// Computes the heat-stress summary from one neighbourhood's raw daily
// series. Groups by calendar year, keeps only March-June days, counts
// days >=40C per year, and averages across whatever years actually came
// back (defensive against a year having partial/missing data, though
// none was observed in testing — 2016-2025 all returned complete
// March-June coverage for every test coordinate).
function summarizeHeatStress(daily) {
  const years = {};
  daily.time.forEach((dateStr, i) => {
    const [y, m] = dateStr.split("-").map(Number);
    if (m < SEASON_START_MONTH || m > SEASON_END_MONTH) return;
    years[y] = years[y] || { maxTemps: [], apparentMaxTemps: [] };
    years[y].maxTemps.push(daily.temperature_2m_max[i]);
    years[y].apparentMaxTemps.push(daily.apparent_temperature_max[i]);
  });

  const yearKeys = Object.keys(years).sort();
  const perYearHotDays = {};
  let totalHotDays = 0;
  let allMaxTemps = [];
  let allApparentMaxTemps = [];

  yearKeys.forEach(y => {
    const hotDays = years[y].maxTemps.filter(v => v >= HOT_DAY_THRESHOLD_C).length;
    perYearHotDays[y] = hotDays;
    totalHotDays += hotDays;
    allMaxTemps = allMaxTemps.concat(years[y].maxTemps);
    allApparentMaxTemps = allApparentMaxTemps.concat(years[y].apparentMaxTemps);
  });

  const nYears = yearKeys.length;
  const avgHotDaysPerYear = nYears > 0 ? parseFloat((totalHotDays / nYears).toFixed(1)) : null;
  const avgApparentTempMaxC = allApparentMaxTemps.length > 0
    ? parseFloat((allApparentMaxTemps.reduce((a, b) => a + b, 0) / allApparentMaxTemps.length).toFixed(1))
    : null;
  const maxTempSeenC = allMaxTemps.length > 0 ? parseFloat(Math.max(...allMaxTemps).toFixed(1)) : null;

  return { avgHotDaysPerYear, avgApparentTempMaxC, maxTempSeenC, yearsUsed: yearKeys, perYearHotDays };
}

async function runFull(limit) {
  const neighbourhoods = limit ? NEIGHBOURHOODS.slice(0, limit) : NEIGHBOURHOODS;
  console.log(`Fetching ${START_DATE} to ${END_DATE} historical daily max/apparent-max temperature for ${neighbourhoods.length} neighbourhoods, ${CONCURRENCY} concurrent...\n`);

  const results = [];
  let failedCount = 0;

  for (let i = 0; i < neighbourhoods.length; i += CONCURRENCY) {
    const chunk = neighbourhoods.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(chunk.map(async n => {
      const { data, reason } = await fetchHistoricalForNeighbourhood(n.lat, n.lon);
      if (!data) {
        console.log(`  [FAILED] ${n.name}, ${n.city}: ${reason}`);
        return { name: n.name, city: n.city, avgHotDaysPerYear: null, avgApparentTempMaxC: null, maxTempSeenC: null, yearsUsed: [], perYearHotDays: {}, failReason: reason };
      }
      const summary = summarizeHeatStress(data.daily);
      console.log(`  [${i + chunk.indexOf(n) + 1}/${neighbourhoods.length}] ${n.name}, ${n.city}: avg ${summary.avgHotDaysPerYear} hot days/yr (>=${HOT_DAY_THRESHOLD_C}C), max seen ${summary.maxTempSeenC}C`);
      return { name: n.name, city: n.city, ...summary };
    }));
    results.push(...chunkResults);
    failedCount += chunkResults.filter(r => r.failReason).length;

    // Checkpoint after every batch — cheap to write, and this run is only
    // ~16 batches total (unlike the multi-hour grid pipeline), so
    // per-neighbourhood granularity isn't needed for crash-safety here.
    writeFileSync(outPath, JSON.stringify(results, null, 2));

    // Proactive pacing, not just reactive 429 retry — the first full run
    // (no delay at all between batches) hit the rate limit after only 3
    // batches. This won't eliminate every 429 (the retry logic above still
    // handles stragglers) but keeps sustained request rate low enough that
    // most batches shouldn't need it.
    if (i + CONCURRENCY < neighbourhoods.length) await sleep(2000);
  }

  console.log(`\nWrote ${results.length} entries to ${outPath}`);
  if (failedCount > 0) {
    console.log(`${failedCount} neighbourhoods failed to fetch — re-run with --retry-failed to retry just these.`);
  }
}

// Retries only the neighbourhoods currently null/failReason in the
// existing output file — cheaper and more reliable than a full re-run,
// since it starts with a clean rate-limit slate instead of inheriting
// cumulative request pressure from 60+ prior requests in the same run
// (which is what left the Pune/Ahmedabad tail failing even with the
// per-neighbourhood retry logic on the first full run).
async function runRetryFailed() {
  if (!existsSync(outPath)) {
    console.log(`${outPath} doesn't exist yet — run a full pass first.`);
    return;
  }
  const existing = JSON.parse(readFileSync(outPath, "utf8"));
  const failedNames = new Set(existing.filter(e => e.failReason).map(e => e.city + "|" + e.name));
  if (failedNames.size === 0) {
    console.log("No failed entries to retry.");
    return;
  }
  console.log(`Retrying ${failedNames.size} previously-failed neighbourhoods...\n`);

  for (const n of NEIGHBOURHOODS) {
    if (!failedNames.has(n.city + "|" + n.name)) continue;
    const { data, reason } = await fetchHistoricalForNeighbourhood(n.lat, n.lon);
    const idx = existing.findIndex(e => e.city === n.city && e.name === n.name);
    if (!data) {
      console.log(`  [STILL FAILED] ${n.name}, ${n.city}: ${reason}`);
      existing[idx] = { name: n.name, city: n.city, avgHotDaysPerYear: null, avgApparentTempMaxC: null, maxTempSeenC: null, yearsUsed: [], perYearHotDays: {}, failReason: reason };
    } else {
      const summary = summarizeHeatStress(data.daily);
      console.log(`  [RECOVERED] ${n.name}, ${n.city}: avg ${summary.avgHotDaysPerYear} hot days/yr (>=${HOT_DAY_THRESHOLD_C}C), max seen ${summary.maxTempSeenC}C`);
      existing[idx] = { name: n.name, city: n.city, ...summary };
    }
    writeFileSync(outPath, JSON.stringify(existing, null, 2));
    await sleep(2000);
  }

  const stillFailed = existing.filter(e => e.failReason).length;
  console.log(`\n${stillFailed} still failing.` + (stillFailed > 0 ? " Re-run --retry-failed again." : " All neighbourhoods now have data."));
}

const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const args = process.argv.slice(2);
  if (args.includes("--retry-failed")) {
    runRetryFailed();
  } else {
    const limitArg = args.find(a => a.startsWith("--limit="));
    const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
    runFull(limit);
  }
}

export { summarizeHeatStress, fetchHistoricalForNeighbourhood };
