export default async function handler(req, res) {

  const { lat, lon } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: "lat and lon are required" });
  }

  const CLIENT_ID     = process.env.SENTINEL_CLIENT_ID;
  const CLIENT_SECRET = process.env.SENTINEL_CLIENT_SECRET;

  try {

    // Step 1 — Get access token
    const tokenResponse = await fetch(
      "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials"
          + "&client_id="     + CLIENT_ID
          + "&client_secret=" + CLIENT_SECRET
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token) {
      return res.status(401).json({ error: "Auth failed", detail: tokenData });
    }

    const token = tokenData.access_token;

    // Step 2 — Fetch NDVI
    const today    = new Date();
    const monthAgo = new Date();
    monthAgo.setDate(today.getDate() - 30);

    const toDate   = today.toISOString().split("T")[0];
    const fromDate = monthAgo.toISOString().split("T")[0];
    const delta    = 0.01;

    const requestBody = {
      input: {
        bounds: {
          bbox: [
            parseFloat(lon) - delta,
            parseFloat(lat) - delta,
            parseFloat(lon) + delta,
            parseFloat(lat) + delta
          ],
          properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" }
        },
        data: [{
          type: "sentinel-2-l2a",
          dataFilter: {
            timeRange: {
              from: fromDate + "T00:00:00Z",
              to:   toDate   + "T23:59:59Z"
            },
            maxCloudCoverage: 30
          }
        }]
      },
      evalscript: `//VERSION=3
function setup() {
  return { input: ["B04", "B08"], output: { bands: 1 } };
}
function evaluatePixel(sample) {
  let ndvi = (sample.B08 - sample.B04) / (sample.B08 + sample.B04);
  return [ndvi];
}`,
      aggregation: {
        timeRange: {
          from: fromDate + "T00:00:00Z",
          to:   toDate   + "T23:59:59Z"
        },
        aggregationInterval: { of: "P30D" },
        resx: 0.0001,
        resy: 0.0001
      },
      calculations: {
        default: {
          histograms: {
            default: { nBins: 5, lowEdge: -1.0, highEdge: 1.0 }
          }
        }
      }
    };

    const ndviResponse = await fetch(
      "https://sh.dataspace.copernicus.eu/api/v1/statistics",
      {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + token
        },
        body: JSON.stringify(requestBody)
      }
    );

    const ndviData = await ndviResponse.json();

    if (!ndviData.data || !ndviData.data[0]) {
      return res.status(200).json({ ndvi: null, reason: "No satellite data available" });
    }

    const mean = ndviData.data[0].outputs.default.bands.B0.stats.mean;
    return res.status(200).json({ ndvi: parseFloat(mean.toFixed(3)) });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
