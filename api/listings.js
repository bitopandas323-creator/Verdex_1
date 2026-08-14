// Consolidated listing-management endpoint — merges 5 previously separate
// files (submit-listing.js, edit-listing.js, delete-listing.js,
// get-listing-contact.js, report-listing.js) into one, purely to stay
// under Vercel's Hobby-plan 12-Serverless-Function limit (every file in
// /api counts as one function; this repo hit 13, which failed the
// deployment). Routing is the ONLY thing that changed here — every
// validation rule, RLS/service-role posture, and rate limit below is
// copied verbatim from its original file, not rewritten. See git history
// (the commit right before this one) for the pre-merge per-endpoint
// files if you need to see any individual piece in isolation.
//
// Routes:
//   POST /api/listings  { action: "submit", ... }                — was submit-listing.js
//   POST /api/listings  { action: "edit", token, ... }            — was edit-listing.js (POST)
//   POST /api/listings  { action: "delete", token }               — was delete-listing.js
//   POST /api/listings  { action: "delete", listing_id, admin_secret } — admin path, same handler
//   POST /api/listings  { action: "report", listing_id, reason }  — was report-listing.js
//   POST /api/listings  { action: "upload_image", token, image_base64 }
//   POST /api/listings  { action: "delete_image", token, image_id }
//   GET  /api/listings?action=edit&token=...                      — was edit-listing.js (GET)
//   GET  /api/listings?action=contact&id=...                      — was get-listing-contact.js
//
// The two get-listing-contact.js/report-listing.js files each had their
// own local, byte-identical copies of hashIp/getClientIp (predating
// api/_lib/listing-auth.js). Both now use the shared versions instead —
// same logic, computed once per request instead of duplicated in two
// more places; not a behavior change.
//
// upload_image/delete_image (see supabase/listings-images.sql for the
// listing_images table + storage bucket they depend on) are new — added
// as actions in this same file rather than new files, since this file
// only exists in its current merged form to stay under Vercel's Hobby
// 12-function limit; a new upload-image.js would undo that.

import { randomBytes } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { validateListingFields } from "./_lib/listing-validation.js";
import { hashIp, hashToken, getClientIp, verifyEditToken, verifyAdminSecret } from "./_lib/listing-auth.js";

const SUBMIT_GLOBAL_CAP_PER_DAY = 3;
const SUBMIT_GLOBAL_CAP_WINDOW_HOURS = 24;
const CONTACT_REVEAL_CAP_PER_DAY = 20;
const CONTACT_REVEAL_CAP_WINDOW_HOURS = 24;
const REPORT_CAP_PER_DAY = 5;
const REPORT_CAP_WINDOW_HOURS = 24;
const VALID_REPORT_REASONS = new Set(["fake_listing", "inappropriate", "spam", "other"]);

const IMAGE_STORAGE_BUCKET = "listing-images";
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_MAX_PER_LISTING = 4;
const IMAGE_UPLOAD_CAP_PER_DAY = 20;
const IMAGE_UPLOAD_CAP_WINDOW_HOURS = 24;
// JPEG SOI marker — the client-side compressor (index.html's
// compressImageToJpeg) always re-encodes to JPEG regardless of the
// source format, so this is the one and only format the server needs to
// accept. Checking the actual bytes, not any declared/claimed content
// type, is what makes this a real content check rather than an
// extension check.
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

export default async function handler(req, res) {
  // Method + action validity checked FIRST, before the env-config check
  // below — same precedence every original file had (each checked
  // req.method !== "..." as its literal first line, env vars second).
  let action;
  if (req.method === "GET") {
    action = req.query.action;
    if (action !== "edit" && action !== "contact") {
      return res.status(400).json({ error: "Unknown or missing action" });
    }
  } else if (req.method === "POST") {
    action = (req.body || {}).action;
    if (!["submit", "edit", "delete", "report", "upload_image", "delete_image"].includes(action)) {
      return res.status(400).json({ error: "Unknown or missing action" });
    }
  } else {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const IP_HASH_SECRET = process.env.IP_HASH_SECRET;
  if (!SUPABASE_URL || !SERVICE_KEY || !IP_HASH_SECRET) {
    console.error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or IP_HASH_SECRET env var.");
    return res.status(500).json({ error: "Server not configured" });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  const ip = getClientIp(req);
  const ip_hash = hashIp(ip, IP_HASH_SECRET);

  if (action === "submit") return handleSubmit(req, res, supabase, ip_hash);
  if (action === "edit" && req.method === "GET") return handleEditGet(req, res, supabase, ip_hash);
  if (action === "edit" && req.method === "POST") return handleEditPost(req, res, supabase, ip_hash);
  if (action === "delete") return handleDelete(req, res, supabase, ip_hash);
  if (action === "report") return handleReport(req, res, supabase, ip_hash);
  if (action === "contact") return handleContactGet(req, res, supabase, ip_hash);
  if (action === "upload_image") return handleUploadImage(req, res, supabase, ip_hash);
  if (action === "delete_image") return handleDeleteImage(req, res, supabase, ip_hash);
}

// --- submit (was submit-listing.js) ---
//
// One rate-limit layer, keyed on ip_hash (a SHA-256 of the submitter IP +
// IP_HASH_SECRET — never the raw IP, never stored or returned anywhere
// else, identical scheme to submit-safety-rating.js): max 3 listings per
// ip_hash per 24h. No per-area dimension the way safety ratings has one
// — a listing isn't naturally repeatable against the same area the way a
// rating is, so a single global cap is the right shape here.
//
// Also generates this listing's edit token here, once — see
// api/_lib/listing-auth.js's own comment for the full reasoning on token
// size and why only its hash is ever persisted. The raw token is
// returned in this response and NEVER AGAIN.
async function handleSubmit(req, res, supabase, ip_hash) {
  const { error: validationError, value: fields } = validateListingFields(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const globalCapSince = new Date(Date.now() - SUBMIT_GLOBAL_CAP_WINDOW_HOURS * 3600 * 1000).toISOString();

  try {
    const { count, error: capError } = await supabase.from("listings")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ip_hash)
      .gte("created_at", globalCapSince);

    if (capError) {
      console.error("Rate-limit check failed:", capError);
      return res.status(500).json({ error: "Could not verify submission — try again." });
    }
    if (count >= SUBMIT_GLOBAL_CAP_PER_DAY) {
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
    console.error("listings submit threw:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}

// --- edit: GET verifies + returns current fields (was edit-listing.js GET) ---
//
// Returning contact info here is deliberate and safe — unlike the
// anonymous "I'm interested" contact reveal below (rate-limited
// precisely because anyone could call it), token possession here IS the
// proof of ownership, so handing the owner their own contact info back
// is correct.
async function handleEditGet(req, res, supabase, ip_hash) {
  const token = req.query.token;
  try {
    const { listing, error, status } = await verifyEditToken(supabase, token, ip_hash);
    if (error) return res.status(status).json({ error });

    const { data: contact, error: contactError } = await supabase.from("listing_contacts")
      .select("contact_method, contact_value")
      .eq("listing_id", listing.id)
      .maybeSingle();
    if (contactError) {
      console.error("Contact fetch failed during listings edit GET:", contactError);
      return res.status(500).json({ error: "Could not load listing — try again." });
    }
    return res.status(200).json({
      id: listing.id, title: listing.title, price: listing.price,
      address_text: listing.address_text, lat: listing.lat, lon: listing.lon, city: listing.city,
      background_tags: listing.background_tags, lifestyle_tags: listing.lifestyle_tags,
      contact_method: contact ? contact.contact_method : null,
      contact_value: contact ? contact.contact_value : null
    });
  } catch (err) {
    console.error("listings edit GET threw:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}

// --- edit: POST verifies + applies validated changes (was edit-listing.js POST) ---
//
// Uses the SAME validator handleSubmit above uses (via
// api/_lib/listing-validation.js) — an edited listing is never held to a
// looser standard just because the two checks drifted apart.
async function handleEditPost(req, res, supabase, ip_hash) {
  const token = (req.body || {}).token;
  try {
    const { listing, error, status } = await verifyEditToken(supabase, token, ip_hash);
    if (error) return res.status(status).json({ error });

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
    console.error("listings edit POST threw:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}

// --- delete (was delete-listing.js) ---
//
// Also reachable via the admin view (?admin=1, see index.html) using
// ADMIN_SECRET + listing_id instead of the listing's own edit token —
// see the admin_secret branch above. Same function either way, so admin
// deletes get the exact same Storage cleanup as a normal delete.
//
// listing_contacts, listing_reports, and listing_images all reference
// listings.id with ON DELETE CASCADE (see supabase/listings.sql and
// listings-images.sql), so the listings delete below removes all four
// tables' rows together. That cascade only covers Postgres ROWS though —
// it does nothing to the actual image bytes sitting in Storage, so those
// have to be removed explicitly, and BEFORE the delete below (once the
// listings row is gone, cascade has already deleted listing_images too,
// and there'd be no way left to look up which storage paths belonged to
// this listing).
async function handleDelete(req, res, supabase, ip_hash) {
  const { token, listing_id, admin_secret } = req.body || {};
  try {
    // Two ways to reach this: the listing's own edit token (normal path),
    // or ADMIN_SECRET + a listing_id (admin view, see
    // api/_lib/listing-auth.js's own comment on why this is a separate
    // function from verifyEditToken, not a variant of it). Whichever
    // resolves `listing`, everything below — Storage cleanup, then the
    // row delete — runs exactly once, unchanged either way.
    const { listing, error, status } = (typeof admin_secret === "string" && admin_secret.length > 0)
      ? await verifyAdminSecret(supabase, admin_secret, listing_id, ip_hash)
      : await verifyEditToken(supabase, token, ip_hash);
    if (error) return res.status(status).json({ error });

    const { data: images, error: imagesFetchError } = await supabase.from("listing_images")
      .select("storage_path")
      .eq("listing_id", listing.id);
    if (imagesFetchError) {
      console.error("Fetching listing images before delete failed:", imagesFetchError);
      return res.status(500).json({ error: "Could not delete your listing — try again." });
    }
    if (images && images.length > 0) {
      const { error: removeError } = await supabase.storage
        .from(IMAGE_STORAGE_BUCKET)
        .remove(images.map(img => img.storage_path));
      // Non-fatal: an orphaned Storage object is a cleanup annoyance, not
      // a correctness or security issue, and failing the whole delete
      // over it would leave the listing (with its now-broken images)
      // stuck. Logged so it can be cleaned up manually if it ever happens.
      if (removeError) console.error("Removing listing images from storage failed (non-fatal):", removeError);
    }

    const { error: deleteError } = await supabase.from("listings").delete().eq("id", listing.id);
    if (deleteError) {
      console.error("Listing delete failed:", deleteError);
      return res.status(500).json({ error: "Could not delete your listing — try again." });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("listings delete threw:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}

// --- contact reveal, "I'm interested" (was get-listing-contact.js) ---
//
// The ONLY read path into listing_contacts — that table has no anon RLS
// policy at all. 20 reveals/IP/day, enforced against
// listing_contact_reveals (a small append-only log — listing_contacts
// itself only holds current state, not one row per reveal request, so it
// can't answer "how many times has this IP revealed a contact in the
// last 24h" on its own) — without this, someone could script through
// every listing id and harvest every contact value one request at a time.
async function handleContactGet(req, res, supabase, ip_hash) {
  const listingId = parseInt(req.query.id, 10);
  if (!Number.isInteger(listingId) || listingId <= 0) {
    return res.status(400).json({ error: "Invalid listing id" });
  }

  const capSince = new Date(Date.now() - CONTACT_REVEAL_CAP_WINDOW_HOURS * 3600 * 1000).toISOString();

  try {
    const { count, error: capError } = await supabase.from("listing_contact_reveals")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ip_hash)
      .gte("created_at", capSince);

    if (capError) {
      console.error("Reveal rate-limit check failed:", capError);
      return res.status(500).json({ error: "Could not process request — try again." });
    }
    if (count >= CONTACT_REVEAL_CAP_PER_DAY) {
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
    console.error("listings contact GET threw:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}

// --- report (was report-listing.js) ---
//
// No auto-moderation — this just logs the report for direct review in
// the Supabase dashboard. Rate-limited so the report button itself can't
// be used to spam/harass a poster by flooding their listing with fake
// reports.
async function handleReport(req, res, supabase, ip_hash) {
  const { listing_id, reason } = req.body || {};
  const listingId = parseInt(listing_id, 10);
  if (!Number.isInteger(listingId) || listingId <= 0) {
    return res.status(400).json({ error: "Invalid listing id" });
  }
  if (!VALID_REPORT_REASONS.has(reason)) {
    return res.status(400).json({ error: "Invalid reason" });
  }

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
    console.error("listings report threw:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}

// --- upload image ---
//
// Token-gated the same way edit/delete are — proof of listing ownership,
// not just a guessable listing_id, is what authorizes adding a photo to
// a listing. Bytes arrive base64-encoded in the JSON body (not
// multipart) since the client always compresses to well under Vercel's
// 4.5MB request-body ceiling before sending (see index.html's
// compressImageToJpeg) — base64 fits the same single-file JSON-action
// pattern every other route here already uses, no new body parsing.
//
// Three independent checks before anything is written, in order:
// decoded size (2MB hard backstop — real content, not the client's
// claim, since the client already compresses far below this), magic
// bytes (confirms it's actually a JPEG, not just labeled as one), then
// the two count-then-compare caps (4 images/listing, 20 uploads/IP/day)
// every other rate limit in this file uses the same pattern for.
async function handleUploadImage(req, res, supabase, ip_hash) {
  const { token, image_base64 } = req.body || {};
  try {
    const { listing, error, status } = await verifyEditToken(supabase, token, ip_hash);
    if (error) return res.status(status).json({ error });

    if (typeof image_base64 !== "string" || image_base64.length === 0) {
      return res.status(400).json({ error: "No image data provided" });
    }

    let buffer;
    try {
      buffer = Buffer.from(image_base64, "base64");
    } catch (e) {
      return res.status(400).json({ error: "Invalid image data" });
    }
    if (buffer.length === 0) {
      return res.status(400).json({ error: "No image data provided" });
    }
    if (buffer.length > IMAGE_MAX_BYTES) {
      return res.status(400).json({ error: "Image is too large (max 2MB)." });
    }
    const isJpeg = JPEG_MAGIC.every((byte, i) => buffer[i] === byte);
    if (!isJpeg) {
      return res.status(400).json({ error: "File does not appear to be a valid JPEG image." });
    }

    const { count: perListingCount, error: perListingError } = await supabase.from("listing_images")
      .select("id", { count: "exact", head: true })
      .eq("listing_id", listing.id);
    if (perListingError) {
      console.error("Per-listing image count check failed:", perListingError);
      return res.status(500).json({ error: "Could not upload image — try again." });
    }
    if (perListingCount >= IMAGE_MAX_PER_LISTING) {
      return res.status(400).json({ error: "This listing already has the maximum of 4 images." });
    }

    const capSince = new Date(Date.now() - IMAGE_UPLOAD_CAP_WINDOW_HOURS * 3600 * 1000).toISOString();
    const { count: dailyCount, error: dailyCapError } = await supabase.from("listing_images")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ip_hash)
      .gte("created_at", capSince);
    if (dailyCapError) {
      console.error("Daily image-upload rate-limit check failed:", dailyCapError);
      return res.status(500).json({ error: "Could not upload image — try again." });
    }
    if (dailyCount >= IMAGE_UPLOAD_CAP_PER_DAY) {
      return res.status(429).json({ error: "Too many images uploaded today — try again tomorrow." });
    }

    const storagePath = `${listing.id}/${randomBytes(16).toString("hex")}.jpg`;
    const { error: uploadError } = await supabase.storage
      .from(IMAGE_STORAGE_BUCKET)
      .upload(storagePath, buffer, { contentType: "image/jpeg" });
    if (uploadError) {
      console.error("Image storage upload failed:", uploadError);
      return res.status(500).json({ error: "Could not upload image — try again." });
    }

    const { data: inserted, error: insertError } = await supabase.from("listing_images").insert({
      listing_id: listing.id, storage_path: storagePath, ip_hash
    }).select("id").single();
    if (insertError || !inserted) {
      // Row failed after the object landed in Storage — clean up rather
      // than leave a storage object no DB row ever points to.
      console.error("Image row insert failed, rolling back storage upload:", insertError);
      await supabase.storage.from(IMAGE_STORAGE_BUCKET).remove([storagePath]);
      return res.status(500).json({ error: "Could not upload image — try again." });
    }

    return res.status(200).json({ ok: true, id: inserted.id, storage_path: storagePath });
  } catch (err) {
    console.error("listings upload_image threw:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}

// --- delete image ---
//
// Also token-gated. Confirms the image row actually belongs to the
// token's own listing (not just any image id) before touching anything
// — otherwise the token would let its holder delete images off any
// listing, not just their own.
async function handleDeleteImage(req, res, supabase, ip_hash) {
  const { token, image_id } = req.body || {};
  const imageId = parseInt(image_id, 10);
  try {
    const { listing, error, status } = await verifyEditToken(supabase, token, ip_hash);
    if (error) return res.status(status).json({ error });

    if (!Number.isInteger(imageId) || imageId <= 0) {
      return res.status(400).json({ error: "Invalid image id" });
    }

    const { data: image, error: fetchError } = await supabase.from("listing_images")
      .select("id, storage_path, listing_id")
      .eq("id", imageId)
      .maybeSingle();
    if (fetchError) {
      console.error("Image lookup failed:", fetchError);
      return res.status(500).json({ error: "Could not delete image — try again." });
    }
    if (!image || image.listing_id !== listing.id) {
      return res.status(404).json({ error: "Image not found" });
    }

    // Storage removed first, DB row second — if the row delete below
    // fails, the same request retried finds no storage object left
    // (remove() on an already-gone path is a no-op) and just cleans up
    // the row on the next attempt. The reverse order would risk a row
    // still pointing at bytes that are already gone.
    const { error: removeError } = await supabase.storage
      .from(IMAGE_STORAGE_BUCKET)
      .remove([image.storage_path]);
    if (removeError) {
      console.error("Image storage removal failed:", removeError);
      return res.status(500).json({ error: "Could not delete image — try again." });
    }

    const { error: deleteError } = await supabase.from("listing_images").delete().eq("id", imageId);
    if (deleteError) {
      console.error("Image row delete failed:", deleteError);
      return res.status(500).json({ error: "Could not delete image — try again." });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("listings delete_image threw:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}
