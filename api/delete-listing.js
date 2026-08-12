// Verifies the edit token (same shared check as api/edit-listing.js —
// see api/_lib/listing-auth.js) then permanently deletes the listing.
// listing_contacts and listing_reports both reference listings.id with
// ON DELETE CASCADE (see supabase/listings.sql), so a single delete here
// removes all three rows together — there's no separate cleanup step
// that could be forgotten or fail independently.

import { createClient } from "@supabase/supabase-js";
import { hashIp, getClientIp, verifyEditToken } from "./_lib/listing-auth.js";

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

  const { token } = req.body || {};
  const ip = getClientIp(req);
  const ip_hash = hashIp(ip, IP_HASH_SECRET);
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    const { listing, error, status } = await verifyEditToken(supabase, token, ip_hash);
    if (error) {
      return res.status(status).json({ error });
    }

    const { error: deleteError } = await supabase.from("listings").delete().eq("id", listing.id);
    if (deleteError) {
      console.error("Listing delete failed:", deleteError);
      return res.status(500).json({ error: "Could not delete your listing — try again." });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("delete-listing threw:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}
