// Counts key civic amenities within 2km via OpenStreetMap's Overpass API.
//
// Two things were verified empirically before building this:
// 1. Overpass's "around:radius,lat,lon" distance filter is expensive on
//    their backend and reliably times out (504) under load. A plain bbox
//    query on the same endpoint returns in ~1-5s, so we query a bounding
//    box and post-filter to the true radius with haversine ourselves.
// 2. Even bbox queries fail intermittently (~1-in-3 during testing), and a
//    failing mirror can hang for 60-80s with no client-side timeout — far
//    longer than a serverless function's execution budget. Each attempt is
//    capped at ATTEMPT_TIMEOUT_MS via AbortController so a slow endpoint
//    fails fast into the next fallback instead of stalling the request.
//
// overpass.kumi.systems additionally requires a real User-Agent or it
// returns 429 regardless of actual rate limit state.

const RADIUS_M = 2000;
const ATTEMPT_TIMEOUT_MS = 4000;
const USER_AGENT = "Verdex/1.0 (Green Score for Indian neighbourhoods; contact: bitopandas323@gmail.com)";

const cityFallbackScore = {
  hyderabad: 6, mumbai: 7, delhi: 6.5,
  bangalore: 6.5, chennai: 6, pune: 6,
  kolkata: 6, ahmedabad: 5.5
};

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bboxAround(lat, lon, radiusM) {
  const dLat = radiusM / 111000;
  const dLon = radiusM / (111000 * Math.cos(lat * Math.PI / 180));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon]; // south, west, north, east
}

function buildQuery(lat, lon) {
  const [s, w, n, e] = bboxAround(lat, lon, RADIUS_M);
  const bbox = `${s},${w},${n},${e}`;
  return `
    [out:json][timeout:15];
    (
      nwr["amenity"="hospital"](${bbox});
      nwr["amenity"="school"](${bbox});
      nwr["amenity"="pharmacy"](${bbox});
      nwr["amenity"="marketplace"](${bbox});
      nwr["shop"="supermarket"](${bbox});
      nwr["shop"="convenience"](${bbox});
    );
    out center;
  `;
}

async function queryOverpass(endpoint, query) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT
      },
      body: "data=" + encodeURIComponent(query),
      signal: controller.signal
    });

    if (!response.ok) throw new Error("Overpass responded " + response.status);

    const data = await response.json();
    if (!Array.isArray(data.elements)) throw new Error("Overpass response missing elements");
    return data.elements;
  } finally {
    clearTimeout(timeoutId);
  }
}

function elementLatLon(el) {
  const lat = el.lat !== undefined ? el.lat : (el.center && el.center.lat);
  const lon = el.lon !== undefined ? el.lon : (el.center && el.center.lon);
  return (lat === undefined || lon === undefined) ? null : [lat, lon];
}

function scoreFromCounts(counts) {
  let score = 2;
  score += Math.min(counts.hospital, 3) * 1.5;
  score += Math.min(counts.school, 5) * 0.8;
  score += Math.min(counts.pharmacy, 5) * 0.4;
  score += Math.min(counts.market, 5) * 0.4;
  return parseFloat(Math.max(0, Math.min(10, score)).toFixed(1));
}

export default async function handler(req, res) {

  const { lat, lon, city } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat and lon required" });

  const latF = parseFloat(lat);
  const lonF = parseFloat(lon);

  const query = buildQuery(latF, lonF);
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ];

  let elements = null;
  let usedEndpoint = null;
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      elements = await queryOverpass(endpoint, query);
      usedEndpoint = endpoint;
      break;
    } catch (err) {
      lastError = err.name === "AbortError" ? new Error("timed out after " + ATTEMPT_TIMEOUT_MS + "ms") : err;
    }
  }

  if (elements === null) {
    const fallbackScore = (city && cityFallbackScore[city] !== undefined) ? cityFallbackScore[city] : 6;
    return res.status(200).json({
      infrastructureScore: fallbackScore,
      counts: null,
      method: "fallback",
      reason: "Both Overpass endpoints failed: " + (lastError ? lastError.message : "unknown error")
    });
  }

  const withinRadius = elements.filter(el => {
    const coords = elementLatLon(el);
    return coords && haversineKm(latF, lonF, coords[0], coords[1]) <= RADIUS_M / 1000;
  });

  const counts = { hospital: 0, school: 0, pharmacy: 0, market: 0 };
  withinRadius.forEach(el => {
    const amenity = el.tags && el.tags.amenity;
    const shop = el.tags && el.tags.shop;
    if (amenity === "hospital") counts.hospital++;
    else if (amenity === "school") counts.school++;
    else if (amenity === "pharmacy") counts.pharmacy++;
    else if (amenity === "marketplace" || shop === "supermarket" || shop === "convenience") counts.market++;
  });

  return res.status(200).json({
    infrastructureScore: scoreFromCounts(counts),
    counts,
    method: "live",
    source: usedEndpoint
  });
}
