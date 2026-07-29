-- Safety crowdsourced ratings — v1
--
-- Run this once in the Supabase project's SQL Editor (Dashboard > SQL
-- Editor > New query > paste > Run). No existing table this repo tracks
-- in SQL — score_snapshots was created by hand in the dashboard; this
-- file exists so safety_ratings has a real, reviewable definition instead.
--
-- ip_hash is a SHA-256 of (submitter IP + IP_HASH_SECRET), computed
-- server-side in api/submit-safety-rating.js — never the raw IP. It
-- exists purely so that function can enforce per-IP rate limits (see its
-- own comments); it's never surfaced in the UI.
--
-- RLS is the actual security boundary here, not obscurity: the anon/
-- publishable key is already embedded in index.html's client-side source
-- (same as it is for score_snapshots' read path), so SELECT is safe to
-- open to anon (ip_hash is a one-way hash, not identifying data) but
-- INSERT deliberately is NOT granted to anon — every insert must go
-- through api/submit-safety-rating.js, which uses the service_role key
-- (bypasses RLS, server-only, never shipped to the browser) and enforces
-- the rate limits BEFORE writing. If anon could insert directly, anyone
-- could bypass the rate limiter entirely by POSTing straight to
-- Supabase's REST API with the same public key.

create table if not exists safety_ratings (
  id                  bigint generated always as identity primary key,
  neighbourhood       text not null,
  city                text not null,
  overall_rating      smallint not null check (overall_rating between 1 and 5),
  well_lit            text not null check (well_lit in ('yes', 'somewhat', 'no')),
  walk_alone_comfort  text not null check (walk_alone_comfort in ('yes', 'with_caution', 'no')),
  created_at          timestamptz not null default now(),
  ip_hash             text not null
);

-- Aggregation read (buildLiveabilityCard's "Community rating" line) filters
-- on neighbourhood+city; the rate-limit checks in api/submit-safety-
-- rating.js filter on ip_hash+created_at and ip_hash+neighbourhood+city+
-- created_at. Both covered directly by these two indexes.
create index if not exists safety_ratings_area_idx
  on safety_ratings (city, neighbourhood);

create index if not exists safety_ratings_ip_recency_idx
  on safety_ratings (ip_hash, created_at);

alter table safety_ratings enable row level security;

-- Public, read-only aggregation access — same posture as score_snapshots.
create policy "safety_ratings_select_anon"
  on safety_ratings
  for select
  to anon
  using (true);

-- Deliberately no INSERT/UPDATE/DELETE policy for anon or authenticated —
-- with RLS enabled and no policy granting it, those are denied by
-- default for every non-service-role caller. Only api/submit-safety-
-- rating.js (service_role, bypasses RLS) can write.
