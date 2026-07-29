// Handles anonymous safety-rating submissions — the ONLY write path into
// safety_ratings. RLS on that table deliberately denies anon INSERT (see
// supabase/safety_ratings.sql), so this function uses the service_role
// key specifically to make the rate limits below actually mean something:
// if anon could insert directly, anyone could bypass this entirely by
// POSTing straight to Supabase's REST API with the same public key
// index.html already embeds client-side.
//
// Two independent rate-limit layers, both keyed on ip_hash (a SHA-256 of
// the caller's IP + IP_HASH_SECRET — never the raw IP, never stored or
// returned anywhere else):
//   1. Per-area cooldown: max 1 submission per (ip_hash, neighbourhood,
//      city) per 24h — stops the most obvious spam vector, repeatedly
//      re-rating one area to skew its aggregate.
//   2. Global daily cap: max 10 submissions per ip_hash per 24h — stops a
//      scripted sweep across all 90 neighbourhoods in one burst, while
//      staying generous enough for a real person rating a few areas they
//      actually know.
// Known limitation, stated rather than papered over: this doesn't stop
// someone rotating IPs (VPN/proxy). No IP-based scheme without accounts
// can fully close that gap — acceptable for v1.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Same data/neighbourhoods.json every other api/*.js reads — validates
// neighbourhood+city against the real 90, not an arbitrary free-text pair.
const NEIGHBOURHOODS = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "neighbourhoods.json"), "utf8")
);

const WELL_LIT_VALUES = new Set(["yes", "somewhat", "no"]);
const WALK_ALONE_VALUES = new Set(["yes", "with_caution", "no"]);

const AREA_COOLDOWN_HOURS = 24;
const GLOBAL_CAP_PER_DAY = 10;
const GLOBAL_CAP_WINDOW_HOURS = 24;

function hashIp(ip, secret) {
  return createHash("sha256").update(ip + secret).digest("hex");
}

// x-forwarded-for can be a comma-separated chain (client, proxy1, proxy2,
// ...) when multiple hops are involved — the first entry is the original
// client, which is what the rate limit should key on. Vercel sets this
// header on every request; req.socket.remoteAddress is the local
// fallback for environments that don't (e.g. this repo's own
// local-verify-server.mjs scratchpad harness).
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const IP_HASH_SECRET = process.env.IP_HASH_SECRET;
  if (!SUPABASE_URL || !SERVICE_KEY || !IP_HASH_SECRET) {
    console.error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or IP_HASH_SECRET env var.");
    return res.status(500).json({ error: "Server not configured" });
  }

  const { neighbourhood, city, overall_rating, well_lit, walk_alone_comfort } = req.body || {};

  const validArea = typeof neighbourhood === "string" && typeof city === "string"
    && NEIGHBOURHOODS.some(n => n.name === neighbourhood && n.city === city);
  if (!validArea) {
    return res.status(400).json({ error: "Unknown neighbourhood/city" });
  }
  if (!Number.isInteger(overall_rating) || overall_rating < 1 || overall_rating > 5) {
    return res.status(400).json({ error: "overall_rating must be an integer 1-5" });
  }
  if (!WELL_LIT_VALUES.has(well_lit)) {
    return res.status(400).json({ error: "Invalid well_lit value" });
  }
  if (!WALK_ALONE_VALUES.has(walk_alone_comfort)) {
    return res.status(400).json({ error: "Invalid walk_alone_comfort value" });
  }

  const ip = getClientIp(req);
  const ip_hash = hashIp(ip, IP_HASH_SECRET);

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  const areaCooldownSince = new Date(Date.now() - AREA_COOLDOWN_HOURS * 3600 * 1000).toISOString();
  const globalCapSince = new Date(Date.now() - GLOBAL_CAP_WINDOW_HOURS * 3600 * 1000).toISOString();

  try {
    const [areaCheck, globalCheck] = await Promise.all([
      supabase.from("safety_ratings")
        .select("id", { count: "exact", head: true })
        .eq("ip_hash", ip_hash).eq("neighbourhood", neighbourhood).eq("city", city)
        .gte("created_at", areaCooldownSince),
      supabase.from("safety_ratings")
        .select("id", { count: "exact", head: true })
        .eq("ip_hash", ip_hash)
        .gte("created_at", globalCapSince)
    ]);

    if (areaCheck.error || globalCheck.error) {
      console.error("Rate-limit check failed:", areaCheck.error || globalCheck.error);
      return res.status(500).json({ error: "Could not verify submission — try again." });
    }
    if (areaCheck.count > 0) {
      return res.status(429).json({ error: "You've already rated this area in the last 24 hours." });
    }
    if (globalCheck.count >= GLOBAL_CAP_PER_DAY) {
      return res.status(429).json({ error: "Too many ratings submitted today — try again tomorrow." });
    }

    const { error: insertError } = await supabase.from("safety_ratings").insert({
      neighbourhood, city, overall_rating, well_lit, walk_alone_comfort, ip_hash
    });
    if (insertError) {
      console.error("Insert failed:", insertError);
      return res.status(500).json({ error: "Could not save your rating — try again." });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("submit-safety-rating threw:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}
