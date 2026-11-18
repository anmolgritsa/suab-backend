-- ============================================================================
-- Migration : 20261113150001_half_day_review_notes.sql
-- Module    : Labour Module — half-day review notes (supervisor decision note)
-- Target    : Supabase PostgreSQL 17 (project: Suab)
--
-- DRAFT — DO NOT PUSH until reviewed and approved.
--
-- Adds `review_notes` to half_day_requests: the supervisor's note recorded
-- when approving or rejecting a request (mainly the REJECTION reason).
--
-- WHY A NEW COLUMN: the existing `reason` column stores the WORKER's reason
-- for the request. Overwriting it with the supervisor's rejection reason
-- would destroy worker data, so a separate column is required.
--
-- Nothing is dropped; no existing column is modified; no data is changed.
-- Idempotent: ADD COLUMN IF NOT EXISTS + guarded ADD CONSTRAINT.
-- ============================================================================

alter table public.half_day_requests
  add column if not exists review_notes text;

-- Guarded constraint add (PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS).
do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'chk_half_day_requests_review_notes_len'
      and conrelid = 'public.half_day_requests'::regclass
  ) then
    alter table public.half_day_requests
      add constraint chk_half_day_requests_review_notes_len
      check (review_notes is null or char_length(review_notes) <= 1000);
  end if;
end $$;

comment on column public.half_day_requests.review_notes is
  'Supervisor note recorded when approving/rejecting (e.g. rejection reason).';
