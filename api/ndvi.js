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

    // Step 2 — Build date range (90 days to maximise chance of clear image)
    const today    = new Date();
    const pastDate = new Date();
    pastDate.setDate(today.getDate() - 90);

    const toDate   = today.toISOString().split("T")[0];
    const fromDate = pastDate.toISOString().split("T")[0];

    // Step 3 — Use Process API to get NDVI value directly
    const latF  = parseFloat(lat);
    const lonF  = parseFloat(lon);
    const delta = 0.005;

    const evalscript = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B08", "SCL"] }],
    output: { bands: 1, sampleType: "FLOAT32" }
  };
}
function evaluatePixel(sample) {
  if ([3, 8, 9, 10, 11].includes(sample.SCL)) return [-999];
  let ndvi = (sample.B08 - sample.B04) / (sample.B08 + sample.B04);
  return [ndvi];
}`;

    const requestBody = {
      input: {
        bounds: {
          bbox: [lonF - delta, latF - delta, lonF + delta, latF + delta],
          properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" }
        },
        data: [{
          dataFilter: {
            timeRange: {
              from: fromDate + "T00:00:00Z",
              to:   toDate   + "T23:59:59Z"
            },
            mosaickingOrder: "leastCC"
          },
          processing: { harmonizeValues: true },
          type: "sentinel-2-l2a"
        }]
      },
      output: {
        width:  64,
        height: 64,
        responses: [{
          identifier: "default",
          format: { type: "image/tiff" }
        }]
      },
      evalscript
    };

    const processResponse = await fetch(
      "https://sh.dataspace.copernicus.eu/api/v1/process",
      {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + token
        },
        body: JSON.stringify(requestBody)
      }
    );

    if (!processResponse.ok) {
      const errText = await processResponse.text();
      return res.status(200).json({
        ndvi: null,
        reason: "Process API error: " + processResponse.status,
        detail: errText.substring(0, 200)
      });
    }

    // Step 4 — Parse the TIFF response to get pixel values
    // Since we can't parse TIFF directly, use evalscript stats approach
    const statsBody = {
      input: {
        bounds: {
          bbox: [lonF - delta, latF - delta, lonF + delta, latF + delta],
          properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" }
        },
        data: [{
          dataFilter: {
            timeRange: {
              from: fromDate + "T00:00:00Z",
              to:   toDate   + "T23:59:59Z"
            },
            maxCloudCoverage: 80,
            mosaickingOrder: "leastCC"
          },
          type: "sentinel-2-l2a"
        }]
      },
      evalscript: `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B08"] }],
    output: [{ id: "ndvi", bands: 1, sampleType: SampleType.FLOAT32 }]
  };
}
function evaluatePixel(sample) {
  let ndvi = (sample.B08 - sample.B04) / (sample.B08 + sample.B04);
  return { ndvi: [ndvi] };
}`,
      aggregation: {
        timeRange: {
          from: fromDate + "T00:00:00Z",
          to:   toDate   + "T23:59:59Z"
        },
        aggregationInterval: { of: "P90D" },
        width:  64,
        height: 64
      },
      calculations: {
        ndvi: {
          histograms: {
            default: {
              nBins:    10,
              lowEdge:  -1.0,
              highEdge:  1.0
            }
          },
          statistics: { default: { percentiles: { k: [25, 50, 75] } } }
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

    const statsData = await statsResponse.json();

    // Try to extract mean NDVI from response
    if (statsData.data && statsData.data.length > 0) {
      const outputs = statsData.data[0].outputs;
      if (outputs && outputs.ndvi && outputs.ndvi.bands && outputs.ndvi.bands.B0) {
        const mean = outputs.ndvi.bands.B0.stats.mean;
        if (mean !== null && mean !== undefined && mean > -1) {
          return res.status(200).json({ ndvi: parseFloat(mean.toFixed(3)) });
        }
      }
    }

    // Return full response for debugging
    return res.status(200).json({
      ndvi: null,
      reason: "No valid NDVI data found",
      debug: JSON.stringify(statsData).substring(0, 500)
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
