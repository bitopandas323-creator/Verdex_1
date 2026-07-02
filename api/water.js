// CPCB does not expose a public, coordinate-queryable real-time water quality
// API — its National Water Quality Monitoring Programme data is published as
// static per-station reports (cpcb.nic.in/nwmp-data), not a REST endpoint
// that can be looked up by lat/lon like WAQI. This endpoint instead scores
// researched baseline TDS (Total Dissolved Solids, ppm) values against BIS
// 10500 / WHO drinking water guidelines, matching the shape of the other
// /api/* scoring endpoints so the frontend has a consistent interface if a
// live source becomes available later.

const cityFallbackTDS = {
  hyderabad: 400, mumbai: 250, delhi: 430,
  bangalore: 460, chennai: 480, pune: 330,
  kolkata: 290, ahmedabad: 470
};

function calculateWaterScore(tds) {
  return parseFloat(Math.max(0, Math.min(10, 10 - (tds / 100))).toFixed(1));
}

function getWaterLabel(tds) {
  if (tds <= 300) return "Excellent — well within safe limits";
  if (tds <= 500) return "Good — within BIS acceptable limits";
  if (tds <= 700) return "Fair — noticeable taste, filtration advisable";
  if (tds <= 900) return "Poor — filtration recommended";
  return "Very poor — filtration essential";
}

export default async function handler(req, res) {

  const { tds, city } = req.query;

  let tdsValue;
  let method;

  if (tds !== undefined) {
    tdsValue = parseFloat(tds);
    method = "baseline";
    if (Number.isNaN(tdsValue)) {
      return res.status(400).json({ error: "tds must be a number" });
    }
  } else if (city && cityFallbackTDS[city] !== undefined) {
    tdsValue = cityFallbackTDS[city];
    method = "city-fallback";
  } else {
    return res.status(400).json({ error: "tds or a known city is required" });
  }

  return res.status(200).json({
    tds: tdsValue,
    waterScore: calculateWaterScore(tdsValue),
    label: getWaterLabel(tdsValue),
    method
  });
}
