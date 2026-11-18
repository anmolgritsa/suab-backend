-- ============================================================================
-- Migration : 20261113130001_shift_sessions.sql
-- Module    : Labour Module — shift sessions (real start/end records)
-- Target    : Supabase PostgreSQL 17 (project: Suab)
--
-- DRAFT — DO NOT PUSH until reviewed and approved.
--
-- WHY THIS EXISTS
--   The existing `shifts` table is a TEMPLATE table (name, start_time,
--   end_time, break_minutes per company). It has no labour_profile_id,
--   started_at or ended_at, so it cannot record actual shift sessions.
--   `shift_sessions` stores one row per started shift; ending it fills
--   ended_at + duration_minutes.
--
-- SAFETY
--   Creates ONE new table. Nothing existing is altered, dropped or reset.
--   RLS follows the same model as attendance (select company, insert/update
--   own-or-privileged, no delete). Helpers come from 20261113100001.
-- ============================================================================

create table if not exists public.shift_sessions (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies (id) on delete cascade,
  labour_profile_id  uuid not null references public.labour_profiles (id) on delete restrict,
  -- optional link to the ACCEPTED work assignment being worked on
  work_assignment_id uuid references public.work_assignments (id) on delete set null,
  -- optional link to the company shift template (morning/night/...)
  shift_id           uuid references public.shifts (id) on delete set null,
  -- attendance-style date (company timezone) for clean day filtering
  shift_date         date not null default (now()::date),
  started_at         timestamptz not null default now(),
  ended_at           timestamptz,
  duration_minutes   integer,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint chk_shift_sessions_end_after_start
    check (ended_at is null or ended_at >= started_at),
  constraint chk_shift_sessions_duration_non_negative
    check (duration_minutes is null or duration_minutes >= 0)
);

comment on table public.shift_sessions is
  'Real shift sessions per labourer; ended_at null = shift still active.';

-- ---------------------------------------------------------------------------
-- updated_at trigger (shared function from 20261113095001)
-- ---------------------------------------------------------------------------
drop trigger if exists trg_shift_sessions_updated_at on public.shift_sessions;
create trigger trg_shift_sessions_updated_at
  before update on public.shift_sessions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists idx_shift_sessions_company_id
  on public.shift_sessions (company_id);
create index if not exists idx_shift_sessions_profile_id
  on public.shift_sessions (labour_profile_id);
create index if not exists idx_shift_sessions_assignment_id
  on public.shift_sessions (work_assignment_id);
create index if not exists idx_shift_sessions_profile_date
  on public.shift_sessions (labour_profile_id, shift_date);

-- THE concurrency guard: at most ONE active (not ended) shift per labourer.
-- Two simultaneous "start" requests -> the second insert fails with 23505.
create unique index if not exists uq_shift_sessions_one_active_per_profile
  on public.shift_sessions (labour_profile_id)
  where ended_at is null;

-- ---------------------------------------------------------------------------
-- RLS — same model as attendance (20261113100003):
--   SELECT  — same company (company-wide visibility)
--   INSERT  — own profile, or privileged role
--   UPDATE  — own profile, or privileged role
--   DELETE  — none for anon/authenticated (denied by default under RLS)
-- service_role bypasses via BYPASSRLS (server-side only; never to a frontend).
-- ---------------------------------------------------------------------------
alter table public.shift_sessions enable row level security;

drop policy if exists "shift_sessions_select_company" on public.shift_sessions;
create policy "shift_sessions_select_company"
  on public.shift_sessions
  for select
  to anon, authenticated
  using (public.is_company_member(company_id));

drop policy if exists "shift_sessions_insert_own_or_privileged" on public.shift_sessions;
create policy "shift_sessions_insert_own_or_privileged"
  on public.shift_sessions
  for insert
  to authenticated
  with check (
    public.is_company_member(company_id)
    and (
      public.is_own_labour_profile(labour_profile_id)
      or public.has_privileged_role(company_id)
    )
  );

drop policy if exists "shift_sessions_update_own_or_privileged" on public.shift_sessions;
create policy "shift_sessions_update_own_or_privileged"
  on public.shift_sessions
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

-- Grants mirror the other labour tables (RLS is the real boundary).
grant select, insert, update on public.shift_sessions to anon, authenticated;
