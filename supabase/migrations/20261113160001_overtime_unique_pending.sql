-- ============================================================================
-- Migration : 20261113160001_overtime_unique_pending.sql
-- Module    : Labour Module — overtime requests
-- Target    : Supabase PostgreSQL 17 (project: Suab)
--
-- Adds a partial unique index so a labourer can have at most ONE pending
-- overtime request per date. This is the hard concurrency guard behind the
-- 409 "duplicate request" response in the overtime Edge Function (the
-- function's pre-check alone cannot stop two simultaneous requests).
--
-- Idempotent, additive only: nothing is dropped, altered or reset.
-- ============================================================================

-- One PENDING request per labourer per date. Approved/rejected/cancelled rows
-- are unaffected, so a labourer may re-apply after a rejection.
create unique index if not exists uq_overtime_requests_pending
  on public.overtime_requests (labour_profile_id, date)
  where status = 'pending';
