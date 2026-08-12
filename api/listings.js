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
//   POST /api/listings  { action: "report", listing_id, reason }  — was report-listing.js
//   GET  /api/listings?action=edit&token=...                      — was edit-listing.js (GET)
//   GET  /api/listings?action=contact&id=...                      — was get-listing-contact.js
//
// The two get-listing-contact.js/report-listing.js files each had their
// own local, byte-identical copies of hashIp/getClientIp (predating
// api/_lib/listing-auth.js). Both now use the shared versions instead —
// same logic, computed once per request instead of duplicated in two
// more places; not a behavior change.

import { randomBytes } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { validateListingFields } from "./_lib/listing-validation.js";
import { hashIp, hashToken, getClientIp, verifyEditToken } from "./_lib/listing-auth.js";

const SUBMIT_GLOBAL_CAP_PER_DAY = 3;
const SUBMIT_GLOBAL_CAP_WINDOW_HOURS = 24;
const CONTACT_REVEAL_CAP_PER_DAY = 20;
const CONTACT_REVEAL_CAP_WINDOW_HOURS = 24;
const REPORT_CAP_PER_DAY = 5;
const REPORT_CAP_WINDOW_HOURS = 24;
const VALID_REPORT_REASONS = new Set(["fake_listing", "inappropriate", "spam", "other"]);

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
    if (!["submit", "edit", "delete", "report"].includes(action)) {
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
// listing_contacts and listing_reports both reference listings.id with
// ON DELETE CASCADE (see supabase/listings.sql), so a single delete here
// removes all three rows together.
async function handleDelete(req, res, supabase, ip_hash) {
  const token = (req.body || {}).token;
  try {
    const { listing, error, status } = await verifyEditToken(supabase, token, ip_hash);
    if (error) return res.status(status).json({ error });

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
