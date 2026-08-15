// Shared field validation for listings — used by both api/submit-listing.js
// (new listing) and api/edit-listing.js's POST (edit an existing one), so
// an edited listing can never end up held to a looser standard than a
// freshly-submitted one just because the two checks drifted apart.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const NEIGHBOURHOODS = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "data", "neighbourhoods.json"), "utf8")
);
export const KNOWN_CITIES = new Set(NEIGHBOURHOODS.map(n => n.city));

export const CONTACT_METHODS = new Set(["email", "phone", "whatsapp"]);

// Household logistics facts (see supabase/listings-household-fields.sql)
// — unlike contact_method, these are OPTIONAL: a missing or unrecognized
// value is silently normalized to "not_specified" rather than rejected,
// since a poster genuinely might not want to say. Exported so
// index.html's button-group UI can build its own options from the same
// source rather than a second hardcoded list drifting out of sync.
export const HOUSEHOLD_FIELDS = [
  { key: "maid_available", options: new Set(["yes", "no", "not_specified"]) },
  { key: "cook_available", options: new Set(["yes", "no", "not_specified"]) },
  { key: "kitchen_type", options: new Set(["veg_only", "mixed", "not_specified"]) },
  { key: "furnishing", options: new Set(["furnished", "semi_furnished", "unfurnished", "not_specified"]) },
  { key: "parking", options: new Set(["two_wheeler", "four_wheeler", "both", "none", "not_specified"]) }
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Loosely permissive — real-world phone/WhatsApp numbers vary a lot in
// formatting (spaces, dashes, +country code). This just rejects obvious
// garbage, not a strict E.164 validator.
const PHONE_RE = /^[+\d][\d\s-]{6,19}$/;

export const TITLE_MAX_LEN = 120;
export const ADDRESS_MAX_LEN = 200;
export const TAG_MAX_LEN = 40;
export const TAGS_MAX_COUNT = 6;
export const PRICE_MAX = 1000000;
// Loose India bounding box — a sanity check against garbage/mistyped
// coordinates, not a precise per-city boundary (findNearestNeighbourhood
// on the client already resolved this address against a real
// neighbourhood before submission; this is a server-side backstop, not a
// duplicate of that logic).
export const INDIA_LAT_RANGE = [6, 38];
export const INDIA_LON_RANGE = [68, 98];

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

// Returns { error: "..." } on the first invalid field, or { value: {...} }
// with every field cleaned/trimmed and ready to write — same shape either
// caller can just check `.error` and bail, or spread `.value` into an
// insert/update.
export function validateListingFields(body) {
  const {
    title, price, address_text, lat, lon, city,
    background_tags, lifestyle_tags, contact_method, contact_value,
    maid_available, cook_available, kitchen_type, furnishing, parking
  } = body || {};

  if (typeof title !== "string" || title.trim().length === 0 || title.length > TITLE_MAX_LEN) {
    return { error: "Invalid title" };
  }
  if (!Number.isInteger(price) || price <= 0 || price > PRICE_MAX) {
    return { error: "Invalid price" };
  }
  if (typeof address_text !== "string" || address_text.trim().length === 0 || address_text.length > ADDRESS_MAX_LEN) {
    return { error: "Invalid address" };
  }
  if (typeof lat !== "number" || typeof lon !== "number"
    || lat < INDIA_LAT_RANGE[0] || lat > INDIA_LAT_RANGE[1]
    || lon < INDIA_LON_RANGE[0] || lon > INDIA_LON_RANGE[1]) {
    return { error: "Invalid coordinates" };
  }
  if (typeof city !== "string" || !KNOWN_CITIES.has(city)) {
    return { error: "Unknown city" };
  }
  const cleanBackgroundTags = cleanTags(background_tags || []);
  const cleanLifestyleTags = cleanTags(lifestyle_tags || []);
  if (!cleanBackgroundTags || !cleanLifestyleTags) {
    return { error: "Invalid tags" };
  }
  if (!CONTACT_METHODS.has(contact_method)) {
    return { error: "Invalid contact method" };
  }
  if (typeof contact_value !== "string") {
    return { error: "Invalid contact value" };
  }
  const trimmedContact = contact_value.trim();
  if (contact_method === "email" && !EMAIL_RE.test(trimmedContact)) {
    return { error: "Invalid email address" };
  }
  if ((contact_method === "phone" || contact_method === "whatsapp") && !PHONE_RE.test(trimmedContact)) {
    return { error: "Invalid phone number" };
  }

  // Optional facts — an absent or unrecognized value just falls back to
  // "not_specified" rather than failing the whole submission, unlike
  // every required field validated above.
  const providedHouseholdValues = { maid_available, cook_available, kitchen_type, furnishing, parking };
  const cleanHousehold = {};
  for (const field of HOUSEHOLD_FIELDS) {
    const provided = providedHouseholdValues[field.key];
    cleanHousehold[field.key] = field.options.has(provided) ? provided : "not_specified";
  }

  return {
    value: {
      title: title.trim(), price, address_text: address_text.trim(), lat, lon, city,
      background_tags: cleanBackgroundTags, lifestyle_tags: cleanLifestyleTags,
      contact_method, contact_value: trimmedContact,
      ...cleanHousehold
    }
  };
}
