// The ONLY read path into listing_contacts — that table has no anon RLS
// policy at all (see supabase/listings.sql), so a direct client-side
// Supabase read can never return contact info, by construction, not just
// by UI convention. This function uses service_role specifically to
// bypass that and hand back one listing's contact info, but ONLY after
// its own rate limit clears — without a limit here, someone could script
// through every listing id and harvest every contact value one "I'm
// interested" request at a time, which would defeat the entire point of
// splitting listing_contacts out of listings in the first place.
//
// 20 reveals/IP/day — generous for a real person browsing and expressing
// interest in several places, restrictive against a scripted sweep.
// Enforced against listing_contact_reveals, a small append-only log
// table (see supabase/listings.sql) — listing_contacts itself only holds
// current state (one row per listing), not one row per reveal request,
// so it can't answer "how many times has this IP revealed a contact in
// the last 24h" on its own. Same ip_hash+created_at shape as every other
// rate limit in this app; RLS locked down the same way (no anon policy).

import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";

const REVEAL_CAP_PER_DAY = 20;
const REVEAL_CAP_WINDOW_HOURS = 24;

function hashIp(ip, secret) {
  return createHash("sha256").update(ip + secret).digest("hex");
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const IP_HASH_SECRET = process.env.IP_HASH_SECRET;
  if (!SUPABASE_URL || !SERVICE_KEY || !IP_HASH_SECRET) {
    console.error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or IP_HASH_SECRET env var.");
    return res.status(500).json({ error: "Server not configured" });
  }

  const listingId = parseInt(req.query.id, 10);
  if (!Number.isInteger(listingId) || listingId <= 0) {
    return res.status(400).json({ error: "Invalid listing id" });
  }

  const ip = getClientIp(req);
  const ip_hash = hashIp(ip, IP_HASH_SECRET);

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  const capSince = new Date(Date.now() - REVEAL_CAP_WINDOW_HOURS * 3600 * 1000).toISOString();

  try {
    const { count, error: capError } = await supabase.from("listing_contact_reveals")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ip_hash)
      .gte("created_at", capSince);

    if (capError) {
      console.error("Reveal rate-limit check failed:", capError);
      return res.status(500).json({ error: "Could not process request — try again." });
    }
    if (count >= REVEAL_CAP_PER_DAY) {
      return res.status(429).json({ error: "Too many contact reveals today — try again tomorrow." });
    }

    const { data: contact, error: fetchError } = await supabase.from("listing_contacts")
      .select("contact_method, contact_value")
      .eq("listing_id", listingId)
      .maybeSingle();

    if (fetchError) {
      console.error("Contact fetch failed:", fetchError);
      return res.status(500).json({ error: "Could not load contact info — try again." });
    }
    if (!contact) {
      return res.status(404).json({ error: "Listing not found" });
    }

    // Logged AFTER a successful fetch, not before — a request for a
    // listing that doesn't exist shouldn't count against the cap.
    const { error: logError } = await supabase.from("listing_contact_reveals").insert({ ip_hash });
    if (logError) console.error("Failed to log contact reveal (non-fatal):", logError);

    return res.status(200).json(contact);
  } catch (err) {
    console.error("get-listing-contact threw:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}
