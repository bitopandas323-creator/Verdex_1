// Handles "Report this listing" submissions — the ONLY write path into
// listing_reports (no anon policy at all on that table, see
// supabase/listings.sql). No auto-moderation here: this just logs the
// report for direct review in the Supabase dashboard. Rate-limited so
// the report button itself can't be used to spam/harass a poster by
// flooding their listing with fake reports.

import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";

const VALID_REASONS = new Set(["fake_listing", "inappropriate", "spam", "other"]);

const REPORT_CAP_PER_DAY = 5;
const REPORT_CAP_WINDOW_HOURS = 24;

function hashIp(ip, secret) {
  return createHash("sha256").update(ip + secret).digest("hex");
}

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

  const { listing_id, reason } = req.body || {};
  const listingId = parseInt(listing_id, 10);
  if (!Number.isInteger(listingId) || listingId <= 0) {
    return res.status(400).json({ error: "Invalid listing id" });
  }
  if (!VALID_REASONS.has(reason)) {
    return res.status(400).json({ error: "Invalid reason" });
  }

  const ip = getClientIp(req);
  const ip_hash = hashIp(ip, IP_HASH_SECRET);

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  const capSince = new Date(Date.now() - REPORT_CAP_WINDOW_HOURS * 3600 * 1000).toISOString();

  try {
    const { count, error: capError } = await supabase.from("listing_reports")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ip_hash)
      .gte("created_at", capSince);

    if (capError) {
      console.error("Report rate-limit check failed:", capError);
      return res.status(500).json({ error: "Could not submit report — try again." });
    }
    if (count >= REPORT_CAP_PER_DAY) {
      return res.status(429).json({ error: "Too many reports submitted today — try again tomorrow." });
    }

    const { error: insertError } = await supabase.from("listing_reports").insert({
      listing_id: listingId, reason, ip_hash
    });
    if (insertError) {
      console.error("Report insert failed:", insertError);
      return res.status(500).json({ error: "Could not submit report — try again." });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("report-listing threw:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}
