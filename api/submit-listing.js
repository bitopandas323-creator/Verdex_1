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
//
// Also generates this listing's edit token here, once — see
// api/_lib/listing-auth.js's own comment for the full reasoning on token
// size and why only its hash is ever persisted. The raw token is
// returned in this response and NEVER AGAIN — there is no other way to
// retrieve it later, by design (the client is responsible for showing a
// "save this now" warning immediately after this call succeeds).

import { randomBytes } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { validateListingFields } from "./_lib/listing-validation.js";
import { hashIp, hashToken, getClientIp } from "./_lib/listing-auth.js";

const GLOBAL_CAP_PER_DAY = 3;
const GLOBAL_CAP_WINDOW_HOURS = 24;

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

  const { error: validationError, value: fields } = validateListingFields(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
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

    // 256 bits — see api/_lib/listing-auth.js's own comment for why this
    // is the right size and why a plain (not salted/slow) hash of it is
    // sufficient. base64url keeps the token URL-safe with no escaping.
    const editToken = randomBytes(32).toString("base64url");
    const edit_token_hash = hashToken(editToken);

    const { data: inserted, error: insertError } = await supabase.from("listings").insert({
      title: fields.title, price: fields.price, address_text: fields.address_text,
      lat: fields.lat, lon: fields.lon, city: fields.city,
      background_tags: fields.background_tags, lifestyle_tags: fields.lifestyle_tags,
      ip_hash, edit_token_hash
    }).select("id").single();

    if (insertError || !inserted) {
      console.error("Listing insert failed:", insertError);
      return res.status(500).json({ error: "Could not save your listing — try again." });
    }

    const { error: contactError } = await supabase.from("listing_contacts").insert({
      listing_id: inserted.id, contact_method: fields.contact_method, contact_value: fields.contact_value
    });
    if (contactError) {
      // The listing row exists but its contact record doesn't — clean up
      // rather than leave a listing that can never reveal a contact.
      console.error("Contact insert failed, rolling back listing:", contactError);
      await supabase.from("listings").delete().eq("id", inserted.id);
      return res.status(500).json({ error: "Could not save your listing — try again." });
    }

    return res.status(200).json({ ok: true, id: inserted.id, token: editToken });
  } catch (err) {
    console.error("submit-listing threw:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}
