export default async function handler(req, res) {

  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "lat and lon required" });

  const CLIENT_ID     = process.env.SENTINEL_CLIENT_ID;
  const CLIENT_SECRET = process.env.SENTINEL_CLIENT_SECRET;

  try {

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
    const delta = 0.005;

    const today    = new Date();
    const pastDate = new Date();
    pastDate.setDate(today.getDate() - 90);
    const toDate   = today.toISOString().split("T")[0];
    const fromDate = pastDate.toISOString().split("T")[0];

    const evalscript = "//VERSION=3\nfunction setup() {\n  return {\n    input: [{ bands: [\"B04\", \"B08\", \"dataMask\"] }],\n    output: [\n      { id: \"ndvi\", bands: 1, sampleType: \"FLOAT32\" },\n      { id: \"dataMask\", bands: 1 }\n    ]\n  };\n}\nfunction evaluatePixel(s) {\n  let ndvi = (s.B08 - s.B04) / (s.B08 + s.B04);\n  return {\n    ndvi: [ndvi],\n    dataMask: [s.dataMask]\n  };\n}";

    const statsRequest = {
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
        evalscript: evalscript,
        // bounds.properties.crs is EPSG:4326 (degrees), so resx/resy must be
        // in degrees too — the literal "10" was being read as 10 degrees
        // (~1100km), collapsing the whole ~1km target area into a single
        // giant pixel (confirmed via a live query: sampleCount was 1,
        // geometryPixelCount was 1). Fixing this raised sampleCount to
        // 10000 for the same bbox.
        //
        // resy (north-south) is ~invariant at ~111.32km/degree everywhere,
        // so a flat 0.0001deg (~11m) is fine. resx (east-west) is NOT
        // invariant — longitude degrees compress by cos(latitude) toward
        // the poles, so a flat value would be ~10% off between our
        // southernmost (~13°N, Bangalore/Chennai) and northernmost (~28.6°N,
        // Delhi) cities. Empirically this barely moved the aggregate NDVI
        // mean (<=0.002 difference across a multi-city test), since we're
        // averaging thousands of pixels — but correcting it is free, so no
        // reason to leave a known, precisely-computable skew in place.
        resx: 0.0001 / Math.cos(latF * Math.PI / 180),
        resy: 0.0001
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

    const statsRes = await fetch(
      "https://sh.dataspace.copernicus.eu/api/v1/statistics",
      {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Accept":        "application/json",
          "Authorization": "Bearer " + token
        },
        body: JSON.stringify(statsRequest)
      }
    );

    const rawText = await statsRes.text();
    let data;
    try { data = JSON.parse(rawText); }
    catch (e) {
      return res.status(200).json({ ndvi: null, reason: "parse error", raw: rawText.substring(0, 400) });
    }

    if (data.data && data.data.length > 0) {
      for (const entry of data.data) {
        if (entry.outputs && entry.outputs.ndvi && entry.outputs.ndvi.bands && entry.outputs.ndvi.bands.B0) {
          const mean = entry.outputs.ndvi.bands.B0.stats.mean;
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
      reason: "No valid NDVI extracted",
      status: statsRes.status,
      debug:  JSON.stringify(data).substring(0, 600)
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
