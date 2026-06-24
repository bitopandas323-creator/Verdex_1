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

    // Step 2 — Statistics API with correct format
    // evalscript must be a string at the TOP level of the JSON body
    const requestObj = {
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
      aggregation: {
        timeRange: {
          from: fromDate + "T00:00:00Z",
          to:   toDate   + "T23:59:59Z"
        },
        aggregationInterval: { of: "P90D" },
        width:  256,
        height: 256
      },
      calculations: {
        default: {
          statistics: {
            default: {
              percentiles: { k: [50] }
            }
          }
        }
      }
    };

    // Add evalscript as a separate string property
    const evalscriptStr = "//VERSION=3\nfunction setup() { return { input: [{ bands: [\"B04\", \"B08\"] }], output: [{ id: \"default\", bands: 1, sampleType: SampleType.FLOAT32 }] }; }\nfunction evaluatePixel(s) { return { default: [(s.B08 - s.B04) / (s.B08 + s.B04)] }; }";

    requestObj.evalscript = evalscriptStr;

    const statsRes  = await fetch(
      "https://sh.dataspace.copernicus.eu/api/v1/statistics",
      {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + token
        },
        body: JSON.stringify(requestObj)
      }
    );

    const rawText = await statsRes.text();

    let data;
    try { data = JSON.parse(rawText); }
    catch (e) { return res.status(200).json({ ndvi: null, reason: "parse error", raw: rawText.substring(0, 400) }); }

    // Navigate response structure
    if (data.data && data.data.length > 0) {
      const entry   = data.data[0];
      const outputs = entry.outputs;
      if (outputs && outputs.default && outputs.default.bands && outputs.default.bands.B0) {
        const mean = outputs.default.bands.B0.stats.mean;
        if (mean !== null && mean !== undefined && !isNaN(mean) && mean > -0.9) {
          return res.status(200).json({ ndvi: parseFloat(mean.toFixed(3)) });
        }
      }
    }

    return res.status(200).json({
      ndvi:  null,
      reason: "Could not extract NDVI",
      debug:  JSON.stringify(data).substring(0, 600)
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
