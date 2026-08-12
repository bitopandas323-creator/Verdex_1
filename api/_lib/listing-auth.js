// Shared edit-token verification for api/edit-listing.js and
// api/delete-listing.js — lives in exactly one place so the "generic
// invalid/expired message, never revealing why" behavior (and the rate
// limit protecting it) can't drift between the two endpoints.
//
// Tokens are 256-bit random values (crypto.randomBytes(32), base64url —
// see api/submit-listing.js) generated once at posting time and returned
// to the poster exactly once. Only sha256(token) is ever stored
// (listings.edit_token_hash) — a plain, unsalted hash is the right choice
// here, not a slow/salted password hash: salting+slow-hashing defends
// *low-entropy, guessable* secrets against offline brute force, but a
// 256-bit random token has no guessable structure to attack — the entropy
// itself is the defense, and a fast hash is enough to make the stored
// value non-reversible. No timing-safe comparison is needed either: the
// lookup is an indexed equality match on the HASH, not a byte-by-byte
// comparison of the raw token, so there's no partial-match signal for a
// timing attack to exploit in the first place.

import { createHash } from "crypto";

const VERIFY_CAP_PER_DAY = 20;
const VERIFY_CAP_WINDOW_HOURS = 24;

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function hashIp(ip, secret) {
  return createHash("sha256").update(ip + secret).digest("hex");
}

export function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

// Returns { error: "..." , status } on any failure (rate-limited, bad
// token shape, no matching listing) or { listing } on success. Every
// failure path uses the SAME generic message — callers must never
// surface capError/lookupError detail to the client, only log it
// server-side, so a response can never be used to distinguish "rate
// limited" from "wrong token" from "listing already deleted".
export async function verifyEditToken(supabase, token, ip_hash) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) {
    return { error: "Invalid or expired link", status: 400 };
  }

  const capSince = new Date(Date.now() - VERIFY_CAP_WINDOW_HOURS * 3600 * 1000).toISOString();
  const { count, error: capError } = await supabase.from("listing_edit_verify_attempts")
    .select("id", { count: "exact", head: true })
    .eq("ip_hash", ip_hash)
    .gte("created_at", capSince);

  if (capError) {
    console.error("Edit-token rate-limit check failed:", capError);
    return { error: "Invalid or expired link", status: 400 };
  }
  if (count >= VERIFY_CAP_PER_DAY) {
    // Distinct status (429) is fine to leak — it's the same signal a
    // normal browser rate-limit gives everywhere else in this app, and
    // doesn't reveal anything about whether the token itself is valid.
    return { error: "Too many attempts today — try again tomorrow.", status: 429 };
  }

  // Logged BEFORE the lookup, unconditionally — a script trying random
  // tokens must be charged for every guess, not just the ones that
  // happen to fail after a real DB round-trip.
  const { error: logError } = await supabase.from("listing_edit_verify_attempts").insert({ ip_hash });
  if (logError) console.error("Failed to log edit-token verify attempt (non-fatal):", logError);

  const { data: listing, error: lookupError } = await supabase.from("listings")
    .select("*")
    .eq("edit_token_hash", hashToken(token))
    .maybeSingle();

  if (lookupError) {
    console.error("Edit-token lookup failed:", lookupError);
    return { error: "Invalid or expired link", status: 400 };
  }
  if (!listing) {
    return { error: "Invalid or expired link", status: 400 };
  }

  return { listing };
}
