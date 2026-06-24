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
        body: new URLSearchParams({
          grant_type:    "client_credentials",
          client_id:     CLIENT_ID,
          client_secret: CLIENT_SECRET
        })
      }
    );

    const tokenData = await tokenResponse.json();
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

    // Step 2 — Use Process API which is more reliable
    // Returns a single pixel NDVI value as JSON
    const evalscript = [
      "//VERSION=3",
      "function setup() {",
      "  return { input: [{ bands: ['B04', 'B08'] }], output: { bands: 1, sampleType: 'FLOAT32' } };",
      "}",
      "function evaluatePixel(s) {",
      "  return [(s.B08 - s.B04) / (s.B08 + s.B04)];",
      "}"
    ].join("\n");

    const body = {
      input: {
        bounds: {
          bbox:       [lonF - delta, latF - delta, lonF + delta, latF + delta],
          properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" }
        },
        data: [{
          type:       "sentinel-2-l2a",
          dataFilter: {
            timeRange:        { from: fromDate + "T00:00:00Z", to: toDate + "T23:59:59Z" },
            maxCloudCoverage: 80,
            mosaickingOrder:  "leastCC"
          }
        }]
      },
      evalscript,
      output: {
        width:  1,
        height: 1,
        responses: [{ identifier: "default", format: { type: "image/tiff" } }]
      }
    };

    const processRes = await fetch(
      "https://sh.dataspace.copernicus.eu/api/v1/process",
      {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + token
        },
        body: JSON.stringify(body)
      }
    );

    // Check content type of response
    const contentType = processRes.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const data = await processRes.json();
      // Extract pixel value
      if (data && data.data && data.data[0] && data.data[0].outputs) {
        const val = data.data[0].outputs.default.bands.B0.stats.mean;
        return res.status(200).json({ ndvi: parseFloat(val.toFixed(3)) });
      }
      return res.status(200).json({ ndvi: null, reason: "Unexpected JSON structure", debug: JSON.stringify(data).substring(0, 300) });
    }

    // If tiff returned, can't parse — return status
    if (contentType.includes("tiff") || contentType.includes("image")) {
      // Try a different output format — text/plain
      return res.status(200).json({
        ndvi: null,
        reason: "Got image response — switching to values output",
        contentType
      });
    }

    const text = await processRes.text();
    return res.status(200).json({
      ndvi:        null,
      reason:      "Unexpected response type",
      contentType,
      debug:       text.substring(0, 300)
    });

  } catch (error) {
    return res.status(500).json({ error: error.message, stack: error.stack });
  }
}
