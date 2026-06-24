export default async function handler(req, res) {

  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat and lon required" });

  const CLIENT_ID     = process.env.SENTINEL_CLIENT_ID;
  const CLIENT_SECRET = process.env.SENTINEL_CLIENT_SECRET;

  try {

    // Step 1 — Auth
    const tokenRes = await fetch(
      "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token",
      {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    new URLSearchParams({
          grant_type:    "client_credentials",
          client_id:     CLIENT_ID,
          client_secret: CLIENT_SECRET
        })
      }
    );

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(401).json({ error: "Auth failed", detail: tokenData });
    }
    const token = tokenData.access_token;

    const latF  = parseFloat(lat);
    const lonF  = parseFloat(lon);
    const delta = 0.01;

    const today    = new Date();
    const pastDate = new Date();
    pastDate.setDate(today.getDate() - 90);
    const toDate   = today.toISOString().split("T")[0];
    const fromDate = pastDate.toISOString().split("T")[0];

    // Step 2 — Build raw JSON string manually
    // This avoids any serialization issues with evalscript
    const rawBody = `{
  "input": {
    "bounds": {
      "bbox": [${lonF - delta}, ${latF - delta}, ${lonF + delta}, ${latF + delta}],
      "properties": { "crs": "http://www.opengis.net/def/crs/EPSG/0/4326" }
    },
    "data": [{
      "type": "sentinel-2-l2a",
      "dataFilter": {
        "timeRange": {
          "from": "${fromDate}T00:00:00Z",
          "to": "${toDate}T23:59:59Z"
        },
        "maxCloudCoverage": 80
      }
    }]
  },
  "evalscript": "//VERSION=3\\nfunction setup() { return { input: [{ bands: [\\"B04\\", \\"B08\\"] }], output: [{ id: \\"default\\", bands: 1, sampleType: SampleType.FLOAT32 }] }; }\\nfunction evaluatePixel(s) { return { default: [(s.B08 - s.B04) / (s.B08 + s.B04)] }; }",
  "aggregation": {
    "timeRange": {
      "from": "${fromDate}T00:00:00Z",
      "to": "${toDate}T23:59:59Z"
    },
    "aggregationInterval": { "of": "P90D" },
    "width": 256,
    "height": 256
  },
  "calculations": {
    "default": {
      "statistics": {
        "default": {
          "percentiles": { "k": [50] }
        }
      }
    }
  }
}`;

    const statsRes = await fetch(
      "https://sh.dataspace.copernicus.eu/api/v1/statistics",
      {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + token
        },
        body: rawBody
      }
    );

    const rawText = await statsRes.text();

    let data;
    try { data = JSON.parse(rawText); }
    catch (e) {
      return res.status(200).json({
        ndvi:   null,
        reason: "Parse error",
        status: statsRes.status,
        raw:    rawText.substring(0, 500)
      });
    }

    // Extract NDVI
    if (data.data && data.data.length > 0) {
      for (const entry of data.data) {
        if (entry.outputs && entry.outputs.default && entry.outputs.default.bands && entry.outputs.default.bands.B0) {
          const mean = entry.outputs.default.bands.B0.stats.mean;
          if (mean !== null && mean !== undefined && !isNaN(mean) && mean > -0.9) {
            return res.status(200).json({
              ndvi: parseFloat(mean.toFixed(3)),
              date: entry.interval ? entry.interval.from : "unknown"
            });
          }
        }
      }
    }

    return res.status(200).json({
      ndvi:   null,
      reason: "No valid NDVI in response",
      status: statsRes.status,
      debug:  JSON.stringify(data).substring(0, 600)
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
