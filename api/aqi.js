// WAQI's geo nearest-station index is sparse for many Indian stations, so a
// "nearest" result can silently be hundreds of km away. Reject it beyond this
// radius and fall through to search-based nearest-station lookup instead of
// trusting it blindly.
const MAX_STATION_DISTANCE_KM = 50;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default async function handler(req, res) {

  const { lat, lon, city } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat and lon required" });

  const latF = parseFloat(lat);
  const lonF = parseFloat(lon);

  const TOKEN = process.env.WAQI_TOKEN;

  try {

    // Try nearest station first — more accurate than city-level
    const nearestURL = `https://api.waqi.info/feed/geo:${lat};${lon}/?token=${TOKEN}`;
    const nearestRes = await fetch(nearestURL);
    const nearestData = await nearestRes.json();

    if (nearestData.status === "ok" && nearestData.data && nearestData.data.aqi) {
      const stationGeo = nearestData.data.city && nearestData.data.city.geo;
      const distanceKm = stationGeo ? haversineKm(latF, lonF, stationGeo[0], stationGeo[1]) : null;

      if (distanceKm === null || distanceKm <= MAX_STATION_DISTANCE_KM) {
        const aqi = nearestData.data.aqi;
        const station = nearestData.data.city ? nearestData.data.city.name : "nearest station";
        return res.status(200).json({
          aqi,
          station,
          method: "nearest"
        });
      }
      // Station is implausibly far — fall through to search-based lookup below
    }

    // WAQI's geo index is sparse for many Indian stations, and a plain
    // city-level feed collapses every neighbourhood onto one fixed station.
    // Search for real stations tagged with this city and pick whichever is
    // actually closest to the requested coordinates.
    if (city) {
      const searchURL = `https://api.waqi.info/search/?keyword=${encodeURIComponent(city)}&token=${TOKEN}`;
      const searchRes  = await fetch(searchURL);
      const searchData = await searchRes.json();

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
          const stationRes  = await fetch(`https://api.waqi.info/feed/@${candidate.uid}/?token=${TOKEN}`);
          const stationData = await stationRes.json();

          if (stationData.status === "ok" && stationData.data && typeof stationData.data.aqi === "number") {
            return res.status(200).json({
              aqi: stationData.data.aqi,
              station: candidate.name,
              method: "search-nearest"
            });
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

    return res.status(200).json({
      aqi: fallbacks[city] || 100,
      station: "fallback",
      method: "fallback"
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
