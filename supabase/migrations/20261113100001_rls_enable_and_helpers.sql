-- ============================================================================
-- Migration : 20261113100001_rls_enable_and_helpers.sql
-- Module    : Labour Module — Row Level Security (part 1: enable + helpers)
-- Target    : Supabase PostgreSQL 17 (project: Suab)
--
-- DRAFT — DO NOT PUSH until reviewed and approved.
--
-- Enables RLS on all 8 Labour Module tables and creates the shared helper
-- functions used by every policy in the following migrations.
--
-- SECURITY MODEL (summary):
--   * `anon` / `authenticated` reach these tables through PostgREST with a JWT.
--   * `service_role` has BYPASSRLS and full grants — it bypasses every policy
--     below. NEVER expose the service_role key to a frontend/client; it is for
--     trusted server-side code (edge functions, admin jobs) only.
--   * No DELETE policies are created for anon/authenticated: with RLS enabled
--     and no policy, DELETE is denied by default.
--
-- Idempotency: ENABLE ROW LEVEL SECURITY is idempotent; functions use
-- CREATE OR REPLACE; nothing is dropped or recreated.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Enable RLS on every Labour Module table.
--    (Tables are owned by `postgres`; RLS does not apply to the table owner
--    or superusers — by design. `service_role` bypasses via BYPASSRLS.)
-- ---------------------------------------------------------------------------
alter table public.companies          enable row level security;
alter table public.shifts             enable row level security;
alter table public.labour_profiles    enable row level security;
alter table public.attendance         enable row level security;
alter table public.work_assignments   enable row level security;
alter table public.half_day_requests  enable row level security;
alter table public.overtime_requests  enable row level security;
alter table public.work_submissions   enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Helper: current user's labour profile id (NULL when not linked).
--    SECURITY DEFINER so policies can read labour_profiles without requiring
--    a policy on labour_profiles itself (avoids recursive policy evaluation).
--    STABLE: safe in policies, evaluated once per statement.
--    search_path pinned: prevents search_path hijacking (security definer).
-- ---------------------------------------------------------------------------
create or replace function public.current_labour_profile_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select lp.id
  from public.labour_profiles lp
  where lp.user_id = auth.uid()
  order by lp.created_at
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 3. Helper: is the caller a member of the given company?
--    True when auth.uid() maps to a labour_profiles row of that company.
-- ---------------------------------------------------------------------------
create or replace function public.is_company_member(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.labour_profiles lp
    where lp.user_id = auth.uid()
      and lp.company_id = p_company_id
  );
$$;

-- ---------------------------------------------------------------------------
-- 4. Helper: does the caller hold one of the privileged roles?
--    labour_profiles.role is free-form text; privileged = manager/admin/supervisor/owner.
--    Case-insensitive; NULL role or unlinked user => false.
-- ---------------------------------------------------------------------------
create or replace function public.has_privileged_role(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.labour_profiles lp
    where lp.user_id = auth.uid()
      and lp.company_id = p_company_id
      and lower(lp.role) in ('owner', 'admin', 'manager', 'supervisor')
  );
$$;

-- ---------------------------------------------------------------------------
-- 5. Helper: is the caller's own profile the given profile id?
-- ---------------------------------------------------------------------------
create or replace function public.is_own_labour_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.labour_profiles lp
    where lp.id = p_profile_id
      and lp.user_id = auth.uid()
  );
$$;

comment on function public.current_labour_profile_id() is
  'RLS helper: labour profile id linked to auth.uid(), or NULL.';
comment on function public.is_company_member(uuid) is
  'RLS helper: true when the caller belongs to the given company.';
comment on function public.has_privileged_role(uuid) is
  'RLS helper: true when the caller holds owner/admin/manager/supervisor in the company.';
comment on function public.is_own_labour_profile(uuid) is
  'RLS helper: true when the profile id belongs to the caller.';
