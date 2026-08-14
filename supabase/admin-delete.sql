-- Admin-delete capability
--
-- Run this once in the Supabase project's SQL Editor, same as every
-- migration before it.
--
-- Just one table: a rate-limit log for ADMIN_SECRET verification
-- attempts, same shape and posture as listing_edit_verify_attempts —
-- api/_lib/listing-auth.js's verifyAdminSecret logs one row here BEFORE
-- comparing the provided secret to ADMIN_SECRET (a script trying values
-- must pay for every guess, not just the ones that happen to fail after
-- a real comparison), then counts recent rows to enforce a 10/day/IP cap.
--
-- ADMIN_SECRET itself is a Vercel environment variable, never written
-- here or anywhere in the codebase.

create table if not exists admin_verify_attempts (
  id                bigint generated always as identity primary key,
  ip_hash           text not null,
  created_at        timestamptz not null default now()
);

create index if not exists admin_verify_attempts_ip_recency_idx
  on admin_verify_attempts (ip_hash, created_at);

alter table admin_verify_attempts enable row level security;

-- Zero policies, same as listing_contacts/listing_reports/
-- listing_edit_verify_attempts — this table is never read or written by
-- anything except api/listings.js's service_role client.
