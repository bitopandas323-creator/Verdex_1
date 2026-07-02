// Counts pedestrian-friendly amenities within 500m via OpenStreetMap's
// Overpass API. See api/infrastructure.js for the reasoning behind the
// bbox+haversine approach, User-Agent header, and per-attempt timeout —
// all verified empirically against overpass-api.de and its
// overpass.kumi.systems mirror before this was wired into the frontend.

const RADIUS_M = 500;
const ATTEMPT_TIMEOUT_MS = 4000;
const USER_AGENT = "Verdex/1.0 (Green Score for Indian neighbourhoods; contact: bitopandas323@gmail.com)";

const cityFallbackScore = {
  hyderabad: 6, mumbai: 7, delhi: 6,
  bangalore: 6, chennai: 5.5, pune: 6,
  kolkata: 6.5, ahmedabad: 5.5
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
      nwr["leisure"="park"](${bbox});
      nwr["shop"="supermarket"](${bbox});
      nwr["shop"="convenience"](${bbox});
      nwr["shop"="grocery"](${bbox});
      nwr["amenity"="cafe"](${bbox});
      nwr["highway"="bus_stop"](${bbox});
      nwr["public_transport"="platform"](${bbox});
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
  score += Math.min(counts.park, 3) * 1.2;
  score += Math.min(counts.grocery, 5) * 0.6;
  score += Math.min(counts.cafe, 5) * 0.5;
  score += Math.min(counts.busStop, 6) * 0.5;
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
      walkabilityScore: fallbackScore,
      counts: null,
      method: "fallback",
      reason: "Both Overpass endpoints failed: " + (lastError ? lastError.message : "unknown error")
    });
  }

  const withinRadius = elements.filter(el => {
    const coords = elementLatLon(el);
    return coords && haversineKm(latF, lonF, coords[0], coords[1]) <= RADIUS_M / 1000;
  });

  const counts = { park: 0, grocery: 0, cafe: 0, busStop: 0 };
  withinRadius.forEach(el => {
    const tags = el.tags || {};
    if (tags.leisure === "park") counts.park++;
    else if (tags.shop === "supermarket" || tags.shop === "convenience" || tags.shop === "grocery") counts.grocery++;
    else if (tags.amenity === "cafe") counts.cafe++;
    else if (tags.highway === "bus_stop" || tags.public_transport === "platform") counts.busStop++;
  });

  return res.status(200).json({
    walkabilityScore: scoreFromCounts(counts),
    counts,
    method: "live",
    source: usedEndpoint
  });
}
