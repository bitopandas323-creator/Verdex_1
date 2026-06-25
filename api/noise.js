export default async function handler(req, res) {

  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat and lon required" });

  const latF = parseFloat(lat);
  const lonF = parseFloat(lon);

  try {

    // Query OpenStreetMap Overpass API for roads and railways near this location
    // We search within a 1km radius for major noise sources
    const radius = 1000; // metres

    const overpassQuery = `
      [out:json][timeout:10];
      (
        way["highway"~"motorway|trunk|primary"](around:${radius},${latF},${lonF});
        way["railway"~"rail|subway"](around:${radius},${latF},${lonF});
        way["highway"~"secondary|tertiary"](around:${radius},${latF},${lonF});
      );
      out geom;
    `;

    const overpassURL = "https://overpass-api.de/api/interpreter";

    const response = await fetch(overpassURL, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    "data=" + encodeURIComponent(overpassQuery)
    });

    if (!response.ok) {
      return res.status(200).json({ noiseScore: 6, reason: "OSM unavailable — using default" });
    }

    const data = await response.json();
    const elements = data.elements || [];

    // Count and classify noise sources found nearby
    let motorwayCount   = 0;
    let railwayCount    = 0;
    let primaryCount    = 0;
    let secondaryCount  = 0;

    elements.forEach(el => {
      const highway = el.tags && el.tags.highway;
      const railway = el.tags && el.tags.railway;
      if (highway === "motorway" || highway === "trunk") motorwayCount++;
      else if (highway === "primary")                   primaryCount++;
      else if (highway === "secondary" || highway === "tertiary") secondaryCount++;
      if (railway === "rail" || railway === "subway")   railwayCount++;
    });

    // Calculate noise penalty
    // Each noise source reduces the score
    let noisePenalty = 0;
    noisePenalty += motorwayCount  * 2.0;  // highways are very loud
    noisePenalty += railwayCount   * 1.8;  // railways are loud
    noisePenalty += primaryCount   * 1.0;  // main roads moderate
    noisePenalty += secondaryCount * 0.4;  // secondary roads minor

    // Cap penalty at 8 (minimum score of 2)
    noisePenalty = Math.min(noisePenalty, 8);

    // Base score is 10, subtract penalty
    let noiseScore = parseFloat(Math.max(2, 10 - noisePenalty).toFixed(1));

    return res.status(200).json({
      noiseScore,
      sources: {
        motorways:   motorwayCount,
        railways:    railwayCount,
        primaryRoads: primaryCount,
        secondaryRoads: secondaryCount
      }
    });

  } catch (err) {
    // If OSM fails, return a neutral default score
    return res.status(200).json({
      noiseScore: 6,
      reason: "Could not fetch road data — using default",
      error: err.message
    });
  }
}
