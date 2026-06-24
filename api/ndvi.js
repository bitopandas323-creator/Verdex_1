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

    const token  = tokenData.access_token;
    const latF   = parseFloat(lat);
    const lonF   = parseFloat(lon);
    const delta  = 0.01;

    const today    = new Date();
    const pastDate = new Date();
    pastDate.setDate(today.getDate() - 90);
    const toDate   = today.toISOString().split("T")[0];
    const fromDate = pastDate.toISOString().split("T")[0];

    // Step 2 — Call Statistics API with evalscript at top level
    const statsBody = {
      input: {
        bounds: {
          bbox: [lonF - delta, latF - delta, lonF + delta, latF + delta],
          properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" }
        },
        data: [{
          type: "sentinel-2-l2a",
          dataFilter: {
            timeRange: {
              from: fromDate + "T00:00:00Z",
              to:   toDate   + "T23:59:59Z"
            },
            maxCloudCoverage: 80
          }
        }]
      },
      evalscript: "//VERSION=3\nfunction setup() {\n  return {\n    input: [{ bands: [\"B04\", \"B08\"] }],\n    output: [{ id: \"ndvi\", bands: 1, sampleType: SampleType.FLOAT32 }]\n  };\n}\nfunction evaluatePixel(sample) {\n  let ndvi = (sample.B08 - sample.B04) / (sample.B08 + sample.B04);\n  return { ndvi: [ndvi] };\n}",
      aggregation: {
        timeRange: {
          from: fromDate + "T00:00:00Z",
          to:   toDate   + "T23:59:59Z"
        },
        aggregationInterval: { of: "P30D" },
        width:  64,
        height: 64
      },
      calculations: {
        ndvi: {
          statistics: {
            default: {
              percentiles: { k: [50] }
            }
          }
        }
      }
    };

    const statsResponse = await fetch(
      "https://sh.dataspace.copernicus.eu/api/v1/statistics",
      {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + token
        },
        body: JSON.stringify(statsBody)
      }
    );

    const statsText = await statsResponse.text();

    // Parse response
    let statsData;
    try {
      statsData = JSON.parse(statsText);
    } catch (e) {
      return res.status(200).json({ ndvi: null, reason: "Parse error", raw: statsText.substring(0, 300) });
    }

    // Extract NDVI mean from response
    if (statsData.data && statsData.data.length > 0) {
      for (const entry of statsData.data) {
        const outputs = entry.outputs;
        if (outputs && outputs.ndvi && outputs.ndvi.bands && outputs.ndvi.bands.B0) {
          const stats = outputs.ndvi.bands.B0.stats;
          if (stats && stats.mean !== null && stats.mean > -0.5) {
            return res.status(200).json({
              ndvi: parseFloat(stats.mean.toFixed(3)),
              date: entry.interval ? entry.interval.from : "unknown"
            });
          }
        }
      }
    }

    return res.status(200).json({
      ndvi: null,
      reason: "No valid data in response",
      debug: JSON.stringify(statsData).substring(0, 500)
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
