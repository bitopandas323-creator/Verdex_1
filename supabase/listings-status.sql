-- Listing status (active / filled)
--
-- Run this once in the Supabase project's SQL Editor, same as every
-- migration before it.
--
-- Same text+check idiom as contact_method and tonight's household
-- fields — no Postgres enum type. Filled listings are never deleted,
-- just marked — see api/listings.js's handleEditPost (unchanged logic,
-- status is just one more field in the same update) and index.html's
-- toggleManageListingStatus.

alter table listings
  add column if not exists status text not null default 'active'
    check (status in ('active', 'filled'));
