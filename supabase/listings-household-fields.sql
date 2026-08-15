-- "Post a listing" — household logistics facts
--
-- Run this once in the Supabase project's SQL Editor, same as every
-- migration before it.
--
-- Five optional facts about a listing, each a plain text column with a
-- check constraint standing in for an enum — same idiom
-- listing_contacts.contact_method already uses, no Postgres `enum` type
-- introduced. All five default to 'not_specified' and are NOT required
-- at posting time: a poster who doesn't want to say, say, whether a cook
-- is available just leaves it as-is. That default also means existing
-- rows and the seed JSON listings (which never send these fields at all)
-- read as "not specified" everywhere without any backfill.

alter table listings
  add column if not exists maid_available  text not null default 'not_specified'
    check (maid_available in ('yes', 'no', 'not_specified')),
  add column if not exists cook_available  text not null default 'not_specified'
    check (cook_available in ('yes', 'no', 'not_specified')),
  add column if not exists kitchen_type    text not null default 'not_specified'
    check (kitchen_type in ('veg_only', 'mixed', 'not_specified')),
  add column if not exists furnishing      text not null default 'not_specified'
    check (furnishing in ('furnished', 'semi_furnished', 'unfurnished', 'not_specified')),
  add column if not exists parking         text not null default 'not_specified'
    check (parking in ('two_wheeler', 'four_wheeler', 'both', 'none', 'not_specified'));
