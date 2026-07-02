// WAQI's geo nearest-station index is sparse for many Indian stations, so a
// "nearest" result can silently be hundreds of km away. Reject it beyond this
// radius and fall through to city-level lookup instead of trusting it blindly.
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
      // Station is implausibly far — fall through to city-level lookup below
    }

    // Fallback to city-level if nearest fails
    if (city) {
      const cityURL = `https://api.waqi.info/feed/${city}/?token=${TOKEN}`;
      const cityRes  = await fetch(cityURL);
      const cityData = await cityRes.json();

      if (cityData.status === "ok" && cityData.data && cityData.data.aqi) {
        return res.status(200).json({
          aqi: cityData.data.aqi,
          station: city,
          method: "city"
        });
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
