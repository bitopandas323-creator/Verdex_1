-- Interest count ("X people interested")
--
-- Run this once in the Supabase project's SQL Editor, same as every
-- migration before it.
--
-- listing_contact_reveals (see listings.sql) was created purely as a
-- rate-limit log — {id, ip_hash, created_at}, no listing_id at all — so
-- it could answer "has this IP revealed too many contacts today" but not
-- "how many people revealed THIS listing's contact." This adds that
-- column, then a view that exposes only the aggregate.

alter table listing_contact_reveals
  add column if not exists listing_id bigint references listings(id) on delete cascade;

create index if not exists listing_contact_reveals_listing_idx
  on listing_contact_reveals (listing_id);

-- Exposes ONLY {listing_id, interest_count} — never raw ip_hash values
-- or timestamps, which stay exactly as inaccessible to anon as they are
-- today (listing_contact_reveals itself keeps its zero-policy RLS
-- lockout unchanged). This works via Postgres's standard view-owner-
-- privilege behavior: a view created by the table owner reads through
-- RLS on the base table even though anon alone couldn't — but the view
-- can only ever return what its own SELECT names, so this is a
-- deliberate, narrow hole (one aggregate number per listing), not a
-- bypass of the table's real protection.
create or replace view listing_interest_counts as
  select listing_id, count(distinct ip_hash) as interest_count
  from listing_contact_reveals
  where listing_id is not null
  group by listing_id;

grant select on listing_interest_counts to anon;
