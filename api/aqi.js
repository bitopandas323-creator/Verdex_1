export default async function handler(req, res) {

  const { lat, lon, city } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat and lon required" });

  const TOKEN = process.env.WAQI_TOKEN;

  try {

    // Try nearest station first — more accurate than city-level
    const nearestURL = `https://api.waqi.info/feed/geo:${lat};${lon}/?token=${TOKEN}`;
    const nearestRes = await fetch(nearestURL);
    const nearestData = await nearestRes.json();

    if (nearestData.status === "ok" && nearestData.data && nearestData.data.aqi) {
      const aqi = nearestData.data.aqi;
      const station = nearestData.data.city ? nearestData.data.city.name : "nearest station";
      return res.status(200).json({
        aqi,
        station,
        method: "nearest"
      });
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
