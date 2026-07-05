// Hourly score-snapshot pipeline. NOT registered in vercel.json's crons
// block (Hobby plan only allows daily cron) — this is meant to be invoked
// hourly by an external scheduler hitting this URL with the CRON_SECRET.
//
// Deliberately does NOT call the NDVI/Sentinel Hub endpoint (api/ndvi.js) —
// green cover only updates every ~5 days, so refreshing it hourly would
// just burn Sentinel Hub quota for identical data. Green cover uses the
// same baseline `ndvi` value already stored per neighbourhood.
//
// AQI and weather genuinely do change hourly, so both are fetched live —
// AQI via the exact same getAqi() used by the live /api/aqi endpoint
// (imported directly, not over HTTP, so the two never drift apart),
// weather via the same open-meteo call index.html already makes.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createClient } from "@supabase/supabase-js";
import { getAqi } from "./aqi.js";
import { calculateAQIScore, calculateHeatScore, calculateNDVIScore, calculateWaterScore, calculateFinalScore } from "./_lib/scoring.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// data/neighbourhoods.json is a static snapshot of index.html's cities
// object (minus nearbyProjects, which isn't needed for scoring). There is
// no shared-module system between the browser page and these serverless
// functions, so this must be manually kept in sync if baseline values are
// edited in index.html.
const NEIGHBOURHOODS = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "neighbourhoods.json"), "utf8")
);

// Empirically tested: open-meteo returns 429 "Too many concurrent requests"
// at concurrency 10 (each of the 10 in-flight neighbourhoods also fires a
// simultaneous WAQI call, but open-meteo's cap is the tighter one). 5 ran
// clean across multiple full 80-neighbourhood passes; 6 was clean too but
// kept a margin below it.
const CONCURRENCY = 5;
const AQI_TIMEOUT_MS = 12000;
const WEATHER_TIMEOUT_MS = 8000;

function withTimeout(promise, ms, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWeather(lat, lon) {
  const url = "https://api.open-meteo.com/v1/forecast"
    + "?latitude=" + lat
    + "&longitude=" + lon
    + "&current_weather=true"
    + "&hourly=relativehumidity_2m,apparent_temperature"
    + "&timezone=Asia/Kolkata"
    + "&forecast_days=1";

  // One retry on 429 as a safety margin below the concurrency cap above —
  // covers transient spikes without masking a real, persistent problem.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(url);
    if (res.status === 429 && attempt === 1) {
      await delay(500);
      continue;
    }
    const data = await res.json();
    const currentHour = new Date().getHours();
    const feelsLike = data.hourly && data.hourly.apparent_temperature && data.hourly.apparent_temperature[currentHour];
    if (typeof feelsLike !== "number") {
      throw new Error(data.reason || "weather response missing apparent_temperature");
    }
    return { feelsLike };
  }
}

async function processNeighbourhood(n) {
  try {
    const [aqiResult, weather] = await Promise.all([
      withTimeout(getAqi(n.lat, n.lon, n.city), AQI_TIMEOUT_MS, "AQI lookup timed out"),
      withTimeout(fetchWeather(n.lat, n.lon), WEATHER_TIMEOUT_MS, "Weather fetch timed out")
    ]);

    const overall_score = calculateFinalScore({
      aqiScore:     calculateAQIScore(aqiResult.aqi),
      ndviScore:    calculateNDVIScore(n.ndvi),
      waterScore:   calculateWaterScore(n.water),
      heatScore:    calculateHeatScore(weather.feelsLike),
      noiseScore:   n.noise,
      infraScore:   n.infra,
      walkScore:    n.walk,
      safetyScore:  n.safety,
      trafficScore: n.traffic
    });

    return {
      ok: true,
      row: { neighbourhood: n.name, city: n.city, aqi: aqiResult.aqi, overall_score }
    };
  } catch (err) {
    return { ok: false, neighbourhood: n.name, error: err.message };
  }
}

async function processAllInBatches(neighbourhoods, concurrency) {
  const results = [];
  for (let i = 0; i < neighbourhoods.length; i += concurrency) {
    const chunk = neighbourhoods.slice(i, i + concurrency);
    const chunkResults = await Promise.all(chunk.map(processNeighbourhood));
    results.push(...chunkResults);
  }
  return results;
}

export default async function handler(req, res) {
  const startTime = Date.now();

  const CRON_SECRET = process.env.CRON_SECRET;
  const provided = req.headers["x-cron-secret"] || req.query.secret;
  if (!CRON_SECRET || provided !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

  const results  = await processAllInBatches(NEIGHBOURHOODS, CONCURRENCY);
  const rows     = results.filter(r => r.ok).map(r => r.row);
  const failed   = results.filter(r => !r.ok).map(r => ({ neighbourhood: r.neighbourhood, error: r.error }));

  let insertError = null;
  if (rows.length > 0) {
    const { error } = await supabase.from("score_snapshots").insert(rows);
    if (error) insertError = error.message;
  }

  return res.status(insertError ? 500 : 200).json({
    attempted: NEIGHBOURHOODS.length,
    inserted: insertError ? 0 : rows.length,
    failed,
    insertError,
    durationMs: Date.now() - startTime
  });
}
