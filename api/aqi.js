import { fetchJsonWithTimeout } from "./_lib/http.js";

// WAQI's geo nearest-station index is sparse for many Indian stations, so a
// "nearest" result can silently be hundreds of km away. Reject it beyond this
// radius and fall through to search-based nearest-station lookup instead of
// trusting it blindly.
const MAX_STATION_DISTANCE_KM = 50;

// None of the three WAQI calls below previously had any timeout — a
// fast-header/slow-body response from any of them (including the up to 5
// sequential attempts in the search-fallback loop) could hang this endpoint
// indefinitely, the same bug class that hung scripts/fetch-nearby-places.mjs
// on Kurla tonight.
//
// Worst case this function now makes 7 sequential WAQI calls (1 nearest +
// 1 search + 5 candidates), so 7 * WAQI_TIMEOUT_MS = 42s. vercel.json sets
// this route's maxDuration to 60s specifically so that ceiling has real
// headroom above this worst case — without that override, this endpoint
// runs on Vercel's plan-default timeout (10s on Hobby, 15s on Pro), which
// would kill the function long before a 6s per-call timeout ever got the
// chance to fire on a later candidate.
const WAQI_TIMEOUT_MS = 6000;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Core AQI lookup logic, reused directly (not over HTTP) by api/snapshot.js
// so the hourly pipeline and the live endpoint never drift apart.
export async function getAqi(lat, lon, city) {
  const latF = parseFloat(lat);
  const lonF = parseFloat(lon);

  const TOKEN = process.env.WAQI_TOKEN;

  // Try nearest station first — more accurate than city-level
  const nearestURL = `https://api.waqi.info/feed/geo:${lat};${lon}/?token=${TOKEN}`;
  const nearestData = await fetchJsonWithTimeout(nearestURL, {}, WAQI_TIMEOUT_MS);

  if (nearestData.status === "ok" && nearestData.data && nearestData.data.aqi) {
    const stationGeo = nearestData.data.city && nearestData.data.city.geo;
    const distanceKm = stationGeo ? haversineKm(latF, lonF, stationGeo[0], stationGeo[1]) : null;

    if (distanceKm === null || distanceKm <= MAX_STATION_DISTANCE_KM) {
      const aqi = nearestData.data.aqi;
      const station = nearestData.data.city ? nearestData.data.city.name : "nearest station";
      return { aqi, station, method: "nearest" };
    }
    // Station is implausibly far — fall through to search-based lookup below
  }

  // WAQI's geo index is sparse for many Indian stations, and a plain
  // city-level feed collapses every neighbourhood onto one fixed station.
  // Search for real stations tagged with this city and pick whichever is
  // actually closest to the requested coordinates.
  if (city) {
    const searchURL = `https://api.waqi.info/search/?keyword=${encodeURIComponent(city)}&token=${TOKEN}`;
    const searchData = await fetchJsonWithTimeout(searchURL, {}, WAQI_TIMEOUT_MS);

    if (searchData.status === "ok" && Array.isArray(searchData.data) && searchData.data.length > 0) {
      const ranked = searchData.data
        .filter(s => s.station && s.station.geo)
        .map(s => ({
          uid: s.uid,
          name: s.station.name,
          distanceKm: haversineKm(latF, lonF, s.station.geo[0], s.station.geo[1])
        }))
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, 5);

      for (const candidate of ranked) {
        const stationData = await fetchJsonWithTimeout(`https://api.waqi.info/feed/@${candidate.uid}/?token=${TOKEN}`, {}, WAQI_TIMEOUT_MS);

        if (stationData.status === "ok" && stationData.data && typeof stationData.data.aqi === "number") {
          return { aqi: stationData.data.aqi, station: candidate.name, method: "search-nearest" };
        }
      }
    }
  }

  // Final fallback
  const fallbacks = {
    hyderabad: 85, mumbai: 95, delhi: 150,
    bangalore: 65, chennai: 90, pune: 75,
    kolkata: 110, ahmedabad: 120
  };

  return { aqi: fallbacks[city] || 100, station: "fallback", method: "fallback" };
}

export default async function handler(req, res) {

  const { lat, lon, city } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat and lon required" });

  try {
    const result = await getAqi(lat, lon, city);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
