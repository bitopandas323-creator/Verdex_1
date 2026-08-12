// GET: verifies the edit token and returns the listing's current fields
// PLUS its contact info, for pre-filling the edit form. Returning contact
// info here is deliberate and safe — unlike api/get-listing-contact.js's
// anonymous "I'm interested" reveal (rate-limited precisely because
// anyone could call it), token possession here IS the proof of
// ownership, so handing the owner their own contact info back is correct.
//
// POST: verifies the token, validates the new field values with the SAME
// validator api/submit-listing.js uses (see api/_lib/listing-validation.js
// — an edited listing is never held to a looser standard just because
// the two checks drifted apart), then updates listings + listing_contacts
// together.
//
// Both methods share one rate-limit bucket via verifyEditToken (see
// api/_lib/listing-auth.js) — opening the edit link and saving a change
// both count as "attempts", 20/day/IP total across GET+POST here and
// api/delete-listing.js.

import { createClient } from "@supabase/supabase-js";
import { validateListingFields } from "./_lib/listing-validation.js";
import { hashIp, getClientIp, verifyEditToken } from "./_lib/listing-auth.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const IP_HASH_SECRET = process.env.IP_HASH_SECRET;
  if (!SUPABASE_URL || !SERVICE_KEY || !IP_HASH_SECRET) {
    console.error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or IP_HASH_SECRET env var.");
    return res.status(500).json({ error: "Server not configured" });
  }

  const token = req.method === "GET" ? req.query.token : (req.body || {}).token;
  const ip = getClientIp(req);
  const ip_hash = hashIp(ip, IP_HASH_SECRET);
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    const { listing, error, status } = await verifyEditToken(supabase, token, ip_hash);
    if (error) {
      return res.status(status).json({ error });
    }

    if (req.method === "GET") {
      const { data: contact, error: contactError } = await supabase.from("listing_contacts")
        .select("contact_method, contact_value")
        .eq("listing_id", listing.id)
        .maybeSingle();
      if (contactError) {
        console.error("Contact fetch failed during edit-listing GET:", contactError);
        return res.status(500).json({ error: "Could not load listing — try again." });
      }
      return res.status(200).json({
        id: listing.id, title: listing.title, price: listing.price,
        address_text: listing.address_text, lat: listing.lat, lon: listing.lon, city: listing.city,
        background_tags: listing.background_tags, lifestyle_tags: listing.lifestyle_tags,
        contact_method: contact ? contact.contact_method : null,
        contact_value: contact ? contact.contact_value : null
      });
    }

    // POST — apply the edit.
    const { error: validationError, value: fields } = validateListingFields(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const { error: updateError } = await supabase.from("listings").update({
      title: fields.title, price: fields.price, address_text: fields.address_text,
      lat: fields.lat, lon: fields.lon, city: fields.city,
      background_tags: fields.background_tags, lifestyle_tags: fields.lifestyle_tags
    }).eq("id", listing.id);
    if (updateError) {
      console.error("Listing update failed:", updateError);
      return res.status(500).json({ error: "Could not save your changes — try again." });
    }

    const { error: contactUpdateError } = await supabase.from("listing_contacts").upsert({
      listing_id: listing.id, contact_method: fields.contact_method, contact_value: fields.contact_value
    });
    if (contactUpdateError) {
      console.error("Contact update failed:", contactUpdateError);
      return res.status(500).json({ error: "Could not save your changes — try again." });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("edit-listing threw:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}
