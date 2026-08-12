-- "Edit/delete your listing" — v1
--
-- Run this once in the Supabase project's SQL Editor, after
-- listings.sql. Adds a private edit-token mechanism: api/submit-listing.js
-- generates a random 256-bit token at posting time, returns the raw
-- token to the poster exactly once, and stores only its SHA-256 hash
-- here. api/edit-listing.js and api/delete-listing.js verify a token by
-- hashing it and looking up this column — see api/_lib/listing-auth.js
-- for the full reasoning on token size and why a plain (not salted/slow)
-- hash is the right choice for a high-entropy random token.

-- default '' only so this ALTER doesn't fail against any rows that
-- already exist from before this migration — there shouldn't be many
-- (this repo's own test listings, if any), and any pre-existing row
-- simply becomes permanently un-editable/un-deletable via this
-- mechanism (its edit_token_hash can never match a real token's hash),
-- which is the correct, safe default for data that predates the feature
-- rather than granting it a guessable or shared token.
alter table listings add column if not exists edit_token_hash text not null default '';
create unique index if not exists listings_edit_token_hash_idx on listings (edit_token_hash);

-- Rate-limits verification attempts across api/edit-listing.js (GET+POST)
-- and api/delete-listing.js — same shape as every other rate-limit table
-- in this app. Logged on EVERY attempt, success or failure, so a script
-- trying tokens can't dodge the cap by only counting failures.
create table if not exists listing_edit_verify_attempts (
  id          bigint generated always as identity primary key,
  ip_hash     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists listing_edit_verify_attempts_ip_recency_idx
  on listing_edit_verify_attempts (ip_hash, created_at);

alter table listing_edit_verify_attempts enable row level security;
-- Zero policies — same posture as listing_contact_reveals: an internal
-- counter only, never read by the client or shown anywhere in the UI.
