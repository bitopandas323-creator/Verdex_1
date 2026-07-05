// Shared scoring helpers for api/snapshot.js only. Deliberately duplicated
// from the identical functions/weights in index.html's inline <script> —
// there is no build step or shared-module system between the browser page
// and Vercel's serverless functions, and converting index.html's script to
// an ES module (the only way to truly share this) would break every
// onclick="..." handler in the app (they rely on global scope, not module
// scope). If these formulas ever change in index.html, mirror the change
// here too.
//
// Files/directories under api/ prefixed with "_" are excluded from Vercel's
// routing, so this module is never deployed as its own endpoint.

export function calculateAQIScore(aqi) {
  return parseFloat(Math.max(0, Math.min(10, 10 - (aqi / 50))).toFixed(1));
}

export function calculateHeatScore(feelsLike) {
  return parseFloat(Math.max(0, Math.min(10, 10 - Math.max(0, feelsLike - 20) * 0.4)).toFixed(1));
}

export function calculateNDVIScore(ndvi) {
  return parseFloat(Math.max(0, Math.min(10, ndvi * 10)).toFixed(1));
}

export function calculateWaterScore(tds) {
  return parseFloat(Math.max(0, Math.min(10, 10 - (tds / 100))).toFixed(1));
}

export function calculateFinalScore(scores) {
  const {
    aqiScore, ndviScore, waterScore, heatScore,
    noiseScore, infraScore, walkScore, safetyScore, trafficScore
  } = scores;

  return parseFloat((
    (aqiScore     * 0.22) +
    (ndviScore    * 0.18) +
    (waterScore   * 0.15) +
    (heatScore    * 0.10) +
    (noiseScore   * 0.07) +
    (infraScore   * 0.10) +
    (walkScore    * 0.08) +
    (safetyScore  * 0.06) +
    (trafficScore * 0.04)
  ).toFixed(1));
}
