-- "Post a listing" — v1
--
-- Run this once in the Supabase project's SQL Editor (Dashboard > SQL
-- Editor > New query > paste > Run), same as safety_ratings.sql.
--
-- THREE tables, not one — this is the important part. A single table
-- with one blanket "anon can SELECT everything" policy (safety_ratings'
-- own pattern) would let anyone read every listing's raw contact info
-- directly from Supabase's REST API using the same public anon key
-- index.html already embeds client-side, regardless of whatever the
-- on-page UI does to "hide" it until a click. RLS in Postgres is
-- row-level, not field-level, so the only way to make contact info
-- genuinely absent from a client-side read of `listings` — not just
-- hidden by JS — is to keep it in a separate table that anon can never
-- SELECT at all. listing_contacts and listing_reports below get RLS
-- enabled with NO policies whatsoever: with RLS on and no policy
-- granting a right, that right is denied by default for every
-- non-service-role caller. Only api/get-listing-contact.js and
-- api/report-listing.js (service_role, bypasses RLS) can ever touch them.

create table if not exists listings (
  id                bigint generated always as identity primary key,
  title             text not null,
  price             integer not null check (price > 0),
  address_text      text not null,
  lat               double precision not null,
  lon               double precision not null,
  city              text not null,
  background_tags   text[] not null default '{}',
  lifestyle_tags    text[] not null default '{}',
  created_at        timestamptz not null default now(),
  ip_hash           text not null
);

create table if not exists listing_contacts (
  listing_id        bigint primary key references listings(id) on delete cascade,
  contact_method    text not null check (contact_method in ('email', 'phone', 'whatsapp')),
  contact_value     text not null
);

create table if not exists listing_reports (
  id                bigint generated always as identity primary key,
  listing_id        bigint not null references listings(id) on delete cascade,
  reason            text not null,
  created_at        timestamptz not null default now(),
  ip_hash           text not null
);

-- Append-only log of successful contact reveals, purely so
-- api/get-listing-contact.js can answer "how many times has this IP
-- revealed a contact in the last 24h" — listing_contacts itself only
-- holds current state (one row per listing), not one row per reveal
-- request, so it can't answer that on its own. Same no-anon-policy
-- posture as listing_contacts/listing_reports below.
create table if not exists listing_contact_reveals (
  id                bigint generated always as identity primary key,
  ip_hash           text not null,
  created_at        timestamptz not null default now()
);

-- Rate-limit checks in api/submit-listing.js and api/report-listing.js
-- both filter on ip_hash + created_at, same as safety_ratings' own index.
create index if not exists listings_ip_recency_idx
  on listings (ip_hash, created_at);

create index if not exists listing_reports_ip_recency_idx
  on listing_reports (ip_hash, created_at);

-- Convenience for reviewing reports against their listing in the
-- Supabase dashboard table view (the only place reports are ever read —
-- see the no-anon-policy note above).
create index if not exists listing_reports_listing_idx
  on listing_reports (listing_id);

create index if not exists listing_contact_reveals_ip_recency_idx
  on listing_contact_reveals (ip_hash, created_at);

alter table listings enable row level security;
alter table listing_contacts enable row level security;
alter table listing_reports enable row level security;
alter table listing_contact_reveals enable row level security;

-- Public, read-only access to the non-sensitive listing fields — same
-- posture as safety_ratings_select_anon. Deliberately no INSERT policy:
-- every insert must go through api/submit-listing.js (service_role,
-- bypasses RLS), which enforces the 3/day rate limit BEFORE writing.
create policy "listings_select_anon"
  on listings
  for select
  to anon
  using (true);

-- listing_contacts: deliberately ZERO policies of any kind. Contact info
-- is only ever readable via api/get-listing-contact.js, which uses
-- service_role specifically so it can enforce its own 20/day-per-IP
-- reveal limit first — without that, anyone could script through every
-- listing id and harvest every contact value one request at a time.
--
-- listing_reports: also zero policies — reviewed directly in the
-- Supabase dashboard, never through the app's own UI (no in-app
-- moderation queue in v1).
--
-- listing_contact_reveals: also zero policies — purely an internal
-- counter for api/get-listing-contact.js's own rate limit, never read by
-- the client or shown anywhere in the UI.
