-- ============================================================================
-- Migration : 20261113100002_rls_companies_and_profiles.sql
-- Module    : Labour Module — Row Level Security (part 2: companies + profiles)
-- Target    : Supabase PostgreSQL 17 (project: Suab)
--
-- DRAFT — DO NOT PUSH until reviewed and approved.
--
-- Policies:
--   companies        — SELECT own company only (no INSERT/UPDATE/DELETE for
--                      regular users; company onboarding is a service-role /
--                      edge-function concern).
--   labour_profiles  — SELECT/UPDATE own profile; privileged roles see and
--                      manage all profiles in their company.
--
-- Field protection on labour_profiles (company_id, user_id, role, status,
-- hourly_rate) is enforced by a BEFORE UPDATE trigger that raises an
-- exception on any attempt to change those columns.
--
-- WHY A TRIGGER (not column-level GRANTs):
--   * Column-level GRANTs would require revoking UPDATE on the whole table and
--     granting per-column — but then privileged roles (managers) legitimately
--     DO need to change role/status/hourly_rate of other profiles, so the
--     grant set would have to differ per caller role and be maintained in
--     sync with the role taxonomy. A trigger centralises the rule in one
--     place, works for every role uniformly, and gives a clear error message.
--   * RLS alone cannot protect columns: a policy only filters rows, so a
--     worker could silently overwrite their own hourly_rate without it.
--   * The trigger is SECURITY INVOKER (default) — it runs with the caller's
--     privileges and cannot be bypassed by policy tricks.
--
-- All policies are idempotent: DROP POLICY IF EXISTS then CREATE POLICY.
-- No tables are created, altered or dropped; no data is modified.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------------
drop policy if exists "companies_select_own" on public.companies;
create policy "companies_select_own"
  on public.companies
  for select
  to anon, authenticated
  using (public.is_company_member(id));

-- No INSERT/UPDATE/DELETE policies on companies for anon/authenticated:
-- with RLS enabled, absence of a policy denies the operation by default.
-- Company lifecycle (create/suspend) is performed by trusted server code
-- using the service_role key (which bypasses RLS).

-- ---------------------------------------------------------------------------
-- labour_profiles
-- ---------------------------------------------------------------------------
drop policy if exists "labour_profiles_select_own" on public.labour_profiles;
create policy "labour_profiles_select_own"
  on public.labour_profiles
  for select
  to anon, authenticated
  using (id = public.current_labour_profile_id());

drop policy if exists "labour_profiles_select_company" on public.labour_profiles;
create policy "labour_profiles_select_company"
  on public.labour_profiles
  for select
  to authenticated
  using (public.has_privileged_role(company_id));

drop policy if exists "labour_profiles_update_own" on public.labour_profiles;
create policy "labour_profiles_update_own"
  on public.labour_profiles
  for update
  to authenticated
  using (id = public.current_labour_profile_id())
  with check (id = public.current_labour_profile_id());

drop policy if exists "labour_profiles_all_company" on public.labour_profiles;
create policy "labour_profiles_all_company"
  on public.labour_profiles
  for all
  to authenticated
  using (public.has_privileged_role(company_id))
  with check (public.has_privileged_role(company_id));

-- No DELETE policy for regular users: workers cannot delete profiles.
-- The FOR ALL policy above does allow privileged roles to delete (they
-- manage profiles fully); prefer status -> 'terminated' for soft removal.

-- ---------------------------------------------------------------------------
-- Field-protection trigger on labour_profiles.
--   Workers may edit their own profile, but never these columns:
--     company_id, user_id, role, status, hourly_rate
--   Privileged roles bypass the guard (they manage other profiles anyway).
--   SECURITY INVOKER: runs as the caller; cannot be tricked via search_path.
-- ---------------------------------------------------------------------------
create or replace function public.guard_labour_profile_privileged_columns()
returns trigger
language plpgsql
as $$
begin
  -- Privileged roles may manage profiles (including privileged columns).
  if public.has_privileged_role(new.company_id) then
    return new;
  end if;

  if new.company_id  is distinct from old.company_id
  or new.user_id     is distinct from old.user_id
  or new.role        is distinct from old.role
  or new.status      is distinct from old.status
  or new.hourly_rate is distinct from old.hourly_rate
  then
    raise exception
      'labour_profiles: changing company_id, user_id, role, status or hourly_rate requires a privileged role'
      using errcode = 'insufficient_privilege'; -- 42501
  end if;

  return new;
end;
$$;

drop trigger if exists trg_labour_profiles_guard_privileged on public.labour_profiles;
create trigger trg_labour_profiles_guard_privileged
  before update on public.labour_profiles
  for each row execute function public.guard_labour_profile_privileged_columns();

comment on function public.guard_labour_profile_privileged_columns() is
  'RLS companion: blocks non-privileged users from changing company_id, user_id, role, status, hourly_rate on labour_profiles.';
