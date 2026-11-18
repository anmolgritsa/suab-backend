-- ============================================================================
-- Migration : 20261113120001_assignment_accept.sql
-- Module    : Labour Module — assignment acceptance
-- Target    : Supabase PostgreSQL 17 (project: Suab)
--
-- DRAFT — DO NOT PUSH until reviewed and approved.
--
-- Two additive changes needed by the `assignments` edge function:
--
-- 1. work_assignments.accepted_at — records WHEN a labourer accepted the
--    task. Nullable; set by the edge function on accept. No backfill needed
--    (existing rows have never been accepted).
--
-- 2. An UPDATE policy letting a worker accept their OWN pending assignment.
--    Today the only write policy is work_assignments_write_privileged
--    (owner/admin/manager/supervisor), so a worker's accept is blocked by
--    RLS with 42501. This policy is narrower than it looks:
--      - USING  : the row must already belong to the caller
--      - CHECK  : the row must STILL belong to the caller after the update
--      - the edge function only ever sets status pending -> in_progress
--        (it never touches title, quantity, rate, company_id, etc.)
--    Workers still cannot create, delete, or reassign anything.
--
-- Idempotent: guarded ADD COLUMN + DROP POLICY IF EXISTS / CREATE POLICY.
-- Nothing is dropped, no data is modified.
-- ============================================================================

-- 1. accepted_at timestamp ---------------------------------------------------
do $$ begin
  alter table public.work_assignments
    add column accepted_at timestamptz;
exception
  when duplicate_column then null; -- already applied
end $$;

comment on column public.work_assignments.accepted_at is
  'When the assigned labourer accepted the task (set by the assignments edge function).';

-- 2. Worker can accept their OWN assignment ----------------------------------
drop policy if exists "work_assignments_accept_own" on public.work_assignments;
create policy "work_assignments_accept_own"
  on public.work_assignments
  for update
  to authenticated
  using (public.is_own_labour_profile(labour_profile_id))
  with check (public.is_own_labour_profile(labour_profile_id));

-- Index for the accept flow (find my pending assignments quickly).
create index if not exists idx_work_assignments_profile_pending
  on public.work_assignments (labour_profile_id, status)
  where status = 'pending';
