-- ============================================================================
-- Migration : 20261113170001_work_submission_quantities.sql
-- Module    : Labour Module — work submissions (quantities + attachment)
-- Target    : Supabase PostgreSQL 17 (project: Suab)
--
-- DRAFT — DO NOT PUSH until reviewed and approved.
--
-- The work_submissions table (…95008) has a single `quantity` column. The
-- Work Submission API needs three quantities (successful / rejected /
-- reusable) plus an optional voice-note / image attachment URL.
--
-- Mapping: the EXISTING `quantity` column stores the SUCCESSFUL quantity
-- (it is NOT NULL with CHECK (> 0) — exactly what a successful count needs).
-- This migration adds the two remaining counters and the attachment URL.
--
-- Additive only: no column is dropped or retyped, no data is modified,
-- no table is recreated. Safe on an empty or populated table.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- New columns
--   quantity_rejected : units produced but rejected by QC   (default 0)
--   quantity_reusable : units recoverable / reworkable      (default 0)
--   attachment_url    : optional voice note or image URL
-- ---------------------------------------------------------------------------
alter table public.work_submissions
  add column if not exists quantity_rejected integer not null default 0;

alter table public.work_submissions
  add column if not exists quantity_reusable integer not null default 0;

alter table public.work_submissions
  add column if not exists attachment_url text;

-- ---------------------------------------------------------------------------
-- CHECK constraints (idempotent — PostgreSQL has no ADD CONSTRAINT IF NOT
-- EXISTS, so guard each with a pg_constraint lookup)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_work_submissions_quantity_rejected_non_negative'
      and conrelid = 'public.work_submissions'::regclass
  ) then
    alter table public.work_submissions
      add constraint chk_work_submissions_quantity_rejected_non_negative
      check (quantity_rejected >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_work_submissions_quantity_reusable_non_negative'
      and conrelid = 'public.work_submissions'::regclass
  ) then
    alter table public.work_submissions
      add constraint chk_work_submissions_quantity_reusable_non_negative
      check (quantity_reusable >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_work_submissions_attachment_url'
      and conrelid = 'public.work_submissions'::regclass
  ) then
    alter table public.work_submissions
      add constraint chk_work_submissions_attachment_url
      check (
        attachment_url is null
        or (attachment_url ~* '^https?://\S+$' and length(attachment_url) <= 1000)
      );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Column comments (keep the schema self-documenting)
-- ---------------------------------------------------------------------------
comment on column public.work_submissions.quantity is
  'Successful (accepted) output quantity. Rejected/reusable are separate columns.';
comment on column public.work_submissions.quantity_rejected is
  'Units produced but rejected by quality control.';
comment on column public.work_submissions.quantity_reusable is
  'Units that can be reworked or reused.';
comment on column public.work_submissions.attachment_url is
  'Optional voice-note or image URL attached to the submission.';
