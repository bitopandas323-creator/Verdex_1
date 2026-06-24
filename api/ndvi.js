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
    const delta = 0.05;

    const today    = new Date();
    const pastDate = new Date();
    pastDate.setDate(today.getDate() - 90);
    const toDate   = today.toISOString().split("T")[0];
    const fromDate = pastDate.toISOString().split("T")[0];

    // Step 2 — Use OGC WCS endpoint which returns NDVI directly
    // This endpoint does not require evalscript
    const wcsUrl = "https://sh.dataspace.copernicus.eu/ogc/wcs/" + CLIENT_ID
      + "?SERVICE=WCS"
      + "&REQUEST=GetCoverage"
      + "&COVERAGE=NDVI"
      + "&CRS=EPSG:4326"
      + "&BBOX=" + (lonF - delta) + "," + (latF - delta) + "," + (lonF + delta) + "," + (latF + delta)
      + "&WIDTH=10&HEIGHT=10"
      + "&FORMAT=application/json"
      + "&TIME=" + fromDate + "/" + toDate
      + "&MAXCC=80"
      + "&VERSION=1.1.2";

    const wcsRes  = await fetch(wcsUrl, {
      headers: { "Authorization": "Bearer " + token }
    });

    const wcsText = await wcsRes.text();

    let wcsData;
    try { wcsData = JSON.parse(wcsText); }
    catch (e) {
      // WCS returned non-JSON — try to extract value differently
      return res.status(200).json({
        ndvi:        null,
        reason:      "WCS non-JSON response",
        contentType: wcsRes.headers.get("content-type"),
        status:      wcsRes.status,
        raw:         wcsText.substring(0, 400)
      });
    }

    // Try to get NDVI value from WCS JSON response
    if (wcsData && wcsData.data) {
      const pixels = wcsData.data.flat();
      const valid  = pixels.filter(v => v > -0.5 && v < 1.1);
      if (valid.length > 0) {
        const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
        return res.status(200).json({ ndvi: parseFloat(mean.toFixed(3)) });
      }
    }

    return res.status(200).json({
      ndvi:  null,
      reason: "WCS: no valid pixels",
      debug:  JSON.stringify(wcsData).substring(0, 400)
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
