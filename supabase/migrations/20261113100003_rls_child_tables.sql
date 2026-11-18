-- ============================================================================
-- Migration : 20261113100003_rls_child_tables.sql
-- Module    : Labour Module — Row Level Security (part 3: child tables)
-- Target    : Supabase PostgreSQL 17 (project: Suab)
--
-- DRAFT — DO NOT PUSH until reviewed and approved.
--
-- Policies for: shifts, attendance, work_assignments, half_day_requests,
-- overtime_requests, work_submissions.
--
-- Model per table:
--   SELECT  — same company as the caller (company-wide visibility).
--   INSERT  — same company AND (own profile | privileged role).
--   UPDATE  — same company AND (own profile | privileged role).
--   DELETE  — none for anon/authenticated (denied by default under RLS).
--
-- service_role bypasses all of this via BYPASSRLS. Never expose the
-- service_role key to a frontend — it is for trusted server-side code only.
--
-- All policies are idempotent (DROP POLICY IF EXISTS / CREATE POLICY).
-- No tables are created or altered; no data is modified.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- shifts — company-scoped shift templates.
--   No labour_profile_id column; company membership is the only gate.
--   INSERT/UPDATE restricted to privileged roles (shift templates are
--   company configuration, not worker-owned data).
-- ---------------------------------------------------------------------------
drop policy if exists "shifts_select_company" on public.shifts;
create policy "shifts_select_company"
  on public.shifts
  for select
  to anon, authenticated
  using (public.is_company_member(company_id));

drop policy if exists "shifts_write_company" on public.shifts;
create policy "shifts_write_company"
  on public.shifts
  for all
  to authenticated
  using (public.has_privileged_role(company_id))
  with check (public.has_privileged_role(company_id));

-- ---------------------------------------------------------------------------
-- attendance — one row per labourer per day.
--   INSERT/UPDATE: own rows, or privileged roles (marking attendance for
--   others). No DELETE for regular users.
-- ---------------------------------------------------------------------------
drop policy if exists "attendance_select_company" on public.attendance;
create policy "attendance_select_company"
  on public.attendance
  for select
  to anon, authenticated
  using (public.is_company_member(company_id));

drop policy if exists "attendance_insert_own_or_privileged" on public.attendance;
create policy "attendance_insert_own_or_privileged"
  on public.attendance
  for insert
  to authenticated
  with check (
    public.is_company_member(company_id)
    and (
      public.is_own_labour_profile(labour_profile_id)
      or public.has_privileged_role(company_id)
    )
  );

drop policy if exists "attendance_update_own_or_privileged" on public.attendance;
create policy "attendance_update_own_or_privileged"
  on public.attendance
  for update
  to authenticated
  using (
    public.is_company_member(company_id)
    and (
      public.is_own_labour_profile(labour_profile_id)
      or public.has_privileged_role(company_id)
    )
  )
  with check (
    public.is_company_member(company_id)
    and (
      public.is_own_labour_profile(labour_profile_id)
      or public.has_privileged_role(company_id)
    )
  );

-- ---------------------------------------------------------------------------
-- work_assignments — tasks assigned to labourers.
--   INSERT/UPDATE: privileged roles only (assignments are created by
--   managers); workers get SELECT (company-wide) and can see their tasks.
-- ---------------------------------------------------------------------------
drop policy if exists "work_assignments_select_company" on public.work_assignments;
create policy "work_assignments_select_company"
  on public.work_assignments
  for select
  to anon, authenticated
  using (public.is_company_member(company_id));

drop policy if exists "work_assignments_write_privileged" on public.work_assignments;
create policy "work_assignments_write_privileged"
  on public.work_assignments
  for all
  to authenticated
  using (public.has_privileged_role(company_id))
  with check (public.has_privileged_role(company_id));

-- ---------------------------------------------------------------------------
-- half_day_requests — worker-submitted, manager-approved.
--   INSERT: own profile, or privileged roles filing on behalf of a worker.
--   UPDATE: own rows, or privileged roles (approving/rejecting).
-- ---------------------------------------------------------------------------
drop policy if exists "half_day_requests_select_company" on public.half_day_requests;
create policy "half_day_requests_select_company"
  on public.half_day_requests
  for select
  to anon, authenticated
  using (public.is_company_member(company_id));

drop policy if exists "half_day_requests_insert_own_or_privileged" on public.half_day_requests;
create policy "half_day_requests_insert_own_or_privileged"
  on public.half_day_requests
  for insert
  to authenticated
  with check (
    public.is_company_member(company_id)
    and (
      public.is_own_labour_profile(labour_profile_id)
      or public.has_privileged_role(company_id)
    )
  );

drop policy if exists "half_day_requests_update_own_or_privileged" on public.half_day_requests;
create policy "half_day_requests_update_own_or_privileged"
  on public.half_day_requests
  for update
  to authenticated
  using (
    public.is_company_member(company_id)
    and (
      public.is_own_labour_profile(labour_profile_id)
      or public.has_privileged_role(company_id)
    )
  )
  with check (
    public.is_company_member(company_id)
    and (
      public.is_own_labour_profile(labour_profile_id)
      or public.has_privileged_role(company_id)
    )
  );

-- ---------------------------------------------------------------------------
-- overtime_requests — same model as half_day_requests.
-- ---------------------------------------------------------------------------
drop policy if exists "overtime_requests_select_company" on public.overtime_requests;
create policy "overtime_requests_select_company"
  on public.overtime_requests
  for select
  to anon, authenticated
  using (public.is_company_member(company_id));

drop policy if exists "overtime_requests_insert_own_or_privileged" on public.overtime_requests;
create policy "overtime_requests_insert_own_or_privileged"
  on public.overtime_requests
  for insert
  to authenticated
  with check (
    public.is_company_member(company_id)
    and (
      public.is_own_labour_profile(labour_profile_id)
      or public.has_privileged_role(company_id)
    )
  );

drop policy if exists "overtime_requests_update_own_or_privileged" on public.overtime_requests;
create policy "overtime_requests_update_own_or_privileged"
  on public.overtime_requests
  for update
  to authenticated
  using (
    public.is_company_member(company_id)
    and (
      public.is_own_labour_profile(labour_profile_id)
      or public.has_privileged_role(company_id)
    )
  )
  with check (
    public.is_company_member(company_id)
    and (
      public.is_own_labour_profile(labour_profile_id)
      or public.has_privileged_role(company_id)
    )
  );

-- ---------------------------------------------------------------------------
-- work_submissions — output logged against assignments.
--   INSERT/UPDATE: own submissions, or privileged roles.
-- ---------------------------------------------------------------------------
drop policy if exists "work_submissions_select_company" on public.work_submissions;
create policy "work_submissions_select_company"
  on public.work_submissions
  for select
  to anon, authenticated
  using (public.is_company_member(company_id));

drop policy if exists "work_submissions_insert_own_or_privileged" on public.work_submissions;
create policy "work_submissions_insert_own_or_privileged"
  on public.work_submissions
  for insert
  to authenticated
  with check (
    public.is_company_member(company_id)
    and (
      public.is_own_labour_profile(labour_profile_id)
      or public.has_privileged_role(company_id)
    )
  );

drop policy if exists "work_submissions_update_own_or_privileged" on public.work_submissions;
create policy "work_submissions_update_own_or_privileged"
  on public.work_submissions
  for update
  to authenticated
  using (
    public.is_company_member(company_id)
    and (
      public.is_own_labour_profile(labour_profile_id)
      or public.has_privileged_role(company_id)
    )
  )
  with check (
    public.is_company_member(company_id)
    and (
      public.is_own_labour_profile(labour_profile_id)
      or public.has_privileged_role(company_id)
    )
  );
