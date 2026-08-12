// Handles real "Post a listing" submissions — the ONLY write path into
// listings/listing_contacts. RLS on listings denies anon INSERT entirely
// (see supabase/listings.sql), and listing_contacts has no anon policy
// at all, so this function uses the service_role key for the same reason
// api/submit-safety-rating.js does: it's what makes the 3/day rate limit
// below actually mean something, and it's the only path that can ever
// populate listing_contacts.
//
// One rate-limit layer, keyed on ip_hash (a SHA-256 of the submitter IP +
// IP_HASH_SECRET — never the raw IP, never stored or returned anywhere
// else, identical scheme to submit-safety-rating.js): max 3 listings per
// ip_hash per 24h. No per-area dimension the way safety ratings has one
// (rating cooldown per neighbourhood) — a listing isn't naturally
// repeatable against the same area the way a rating is, so a single
// global cap is the right shape here.
// Known limitation, stated rather than papered over: doesn't stop
// someone rotating IPs. Same acceptable-for-v1 posture as safety ratings.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const NEIGHBOURHOODS = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "neighbourhoods.json"), "utf8")
);
const KNOWN_CITIES = new Set(NEIGHBOURHOODS.map(n => n.city));

const CONTACT_METHODS = new Set(["email", "phone", "whatsapp"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Loosely permissive — real-world phone/WhatsApp numbers vary a lot in
// formatting (spaces, dashes, +country code). This just rejects obvious
// garbage, not a strict E.164 validator.
const PHONE_RE = /^[+\d][\d\s-]{6,19}$/;

const TITLE_MAX_LEN = 120;
const ADDRESS_MAX_LEN = 200;
const TAG_MAX_LEN = 40;
const TAGS_MAX_COUNT = 6;
const PRICE_MAX = 1000000;
// Loose India bounding box — a sanity check against garbage/mistyped
// coordinates, not a precise per-city boundary (findNearestNeighbourhood
// on the client already resolved this address against a real
// neighbourhood before submission; this is a server-side backstop, not a
// duplicate of that logic).
const INDIA_LAT_RANGE = [6, 38];
const INDIA_LON_RANGE = [68, 98];

const GLOBAL_CAP_PER_DAY = 3;
const GLOBAL_CAP_WINDOW_HOURS = 24;

function hashIp(ip, secret) {
  return createHash("sha256").update(ip + secret).digest("hex");
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function cleanTags(tags) {
  if (!Array.isArray(tags)) return null;
  const cleaned = tags
    .filter(t => typeof t === "string")
    .map(t => t.trim())
    .filter(t => t.length > 0 && t.length <= TAG_MAX_LEN);
  if (cleaned.length !== tags.length) return null; // rejects any non-string/empty/oversized entry rather than silently dropping it
  if (cleaned.length > TAGS_MAX_COUNT) return null;
  return cleaned;
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

  const {
    title, price, address_text, lat, lon, city,
    background_tags, lifestyle_tags, contact_method, contact_value
  } = req.body || {};

  if (typeof title !== "string" || title.trim().length === 0 || title.length > TITLE_MAX_LEN) {
    return res.status(400).json({ error: "Invalid title" });
  }
  if (!Number.isInteger(price) || price <= 0 || price > PRICE_MAX) {
    return res.status(400).json({ error: "Invalid price" });
  }
  if (typeof address_text !== "string" || address_text.trim().length === 0 || address_text.length > ADDRESS_MAX_LEN) {
    return res.status(400).json({ error: "Invalid address" });
  }
  if (typeof lat !== "number" || typeof lon !== "number"
    || lat < INDIA_LAT_RANGE[0] || lat > INDIA_LAT_RANGE[1]
    || lon < INDIA_LON_RANGE[0] || lon > INDIA_LON_RANGE[1]) {
    return res.status(400).json({ error: "Invalid coordinates" });
  }
  if (typeof city !== "string" || !KNOWN_CITIES.has(city)) {
    return res.status(400).json({ error: "Unknown city" });
  }
  const cleanBackgroundTags = cleanTags(background_tags || []);
  const cleanLifestyleTags = cleanTags(lifestyle_tags || []);
  if (!cleanBackgroundTags || !cleanLifestyleTags) {
    return res.status(400).json({ error: "Invalid tags" });
  }
  if (!CONTACT_METHODS.has(contact_method)) {
    return res.status(400).json({ error: "Invalid contact method" });
  }
  if (typeof contact_value !== "string") {
    return res.status(400).json({ error: "Invalid contact value" });
  }
  const trimmedContact = contact_value.trim();
  if (contact_method === "email" && !EMAIL_RE.test(trimmedContact)) {
    return res.status(400).json({ error: "Invalid email address" });
  }
  if ((contact_method === "phone" || contact_method === "whatsapp") && !PHONE_RE.test(trimmedContact)) {
    return res.status(400).json({ error: "Invalid phone number" });
  }

  const ip = getClientIp(req);
  const ip_hash = hashIp(ip, IP_HASH_SECRET);

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  const globalCapSince = new Date(Date.now() - GLOBAL_CAP_WINDOW_HOURS * 3600 * 1000).toISOString();

  try {
    const { count, error: capError } = await supabase.from("listings")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ip_hash)
      .gte("created_at", globalCapSince);

    if (capError) {
      console.error("Rate-limit check failed:", capError);
      return res.status(500).json({ error: "Could not verify submission — try again." });
    }
    if (count >= GLOBAL_CAP_PER_DAY) {
      return res.status(429).json({ error: "You've already posted the maximum of 3 listings today — try again tomorrow." });
    }

    const { data: inserted, error: insertError } = await supabase.from("listings").insert({
      title: title.trim(), price, address_text: address_text.trim(), lat, lon, city,
      background_tags: cleanBackgroundTags, lifestyle_tags: cleanLifestyleTags, ip_hash
    }).select("id").single();

    if (insertError || !inserted) {
      console.error("Listing insert failed:", insertError);
      return res.status(500).json({ error: "Could not save your listing — try again." });
    }

    const { error: contactError } = await supabase.from("listing_contacts").insert({
      listing_id: inserted.id, contact_method, contact_value: trimmedContact
    });
    if (contactError) {
      // The listing row exists but its contact record doesn't — clean up
      // rather than leave a listing that can never reveal a contact.
      console.error("Contact insert failed, rolling back listing:", contactError);
      await supabase.from("listings").delete().eq("id", inserted.id);
      return res.status(500).json({ error: "Could not save your listing — try again." });
    }

    return res.status(200).json({ ok: true, id: inserted.id });
  } catch (err) {
    console.error("submit-listing threw:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}
