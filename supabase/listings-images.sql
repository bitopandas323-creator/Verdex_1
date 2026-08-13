-- "Post a listing" — image upload
--
-- Run this once in the Supabase project's SQL Editor, same as
-- listings.sql and listings-edit-token.sql before it.
--
-- Two things happen here: a new listing_images table (same no-anon-write
-- posture as everything else in listings.sql — anon can read, only
-- service_role in api/listings.js can write), and a new PUBLIC storage
-- bucket for the actual image bytes. Splitting it this way means the
-- Postgres row (path, ownership via listing_id) and the Storage object
-- (bytes) are two different things that both need cleaning up on
-- delete — see api/listings.js's handleDelete, which now removes the
-- Storage objects explicitly before the listings row cascade removes
-- these rows.

create table if not exists listing_images (
  id                bigint generated always as identity primary key,
  listing_id        bigint not null references listings(id) on delete cascade,
  storage_path      text not null,
  ip_hash           text not null,
  created_at        timestamptz not null default now()
);

-- Doubles as the per-IP daily upload rate-limit log (api/listings.js's
-- upload_image action counts rows by ip_hash + created_at, same
-- count-then-compare pattern as every other rate limit in this app) —
-- no separate log table needed, since every upload already produces
-- exactly one natural row here, unlike a contact reveal.
create index if not exists listing_images_ip_recency_idx
  on listing_images (ip_hash, created_at);

create index if not exists listing_images_listing_idx
  on listing_images (listing_id);

alter table listing_images enable row level security;

-- Public, read-only — a storage path isn't sensitive (the bucket itself
-- is public-read too; see below), same posture as listings_select_anon.
-- Zero write policies: every insert/delete goes through api/listings.js
-- (service_role, bypasses RLS), which enforces the 4-per-listing cap and
-- the 20/day-per-IP rate limit BEFORE writing.
create policy "listing_images_select_anon"
  on listing_images
  for select
  to anon
  using (true);

-- Storage bucket. public=true means any object in it is readable via its
-- public URL (storage/v1/object/public/listing-images/...) unconditionally
-- — that's independent of the storage.objects policies below, which only
-- govern the Storage *API* (list/upload/update/delete), not public GETs.
-- file_size_limit and allowed_mime_types are a second, independent
-- enforcement layer alongside api/listings.js's own 2MB cap + magic-byte
-- check — free, native to Supabase Storage, defense in depth rather than
-- the only check.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('listing-images', 'listing-images', true, 2097152, array['image/jpeg'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- storage.objects: zero policies for anon on this bucket — no SELECT
-- policy needed (public=true above already makes GETs work), and
-- deliberately no INSERT/UPDATE/DELETE policy at all. Every write to
-- this bucket happens through api/listings.js using service_role, which
-- bypasses Storage policies the same way it bypasses table RLS — so
-- there is no direct anon-key upload path to this bucket, ever.
