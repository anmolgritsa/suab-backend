-- ============================================================================
-- Migration : 20261113095002_create_shifts.sql
-- Module    : Labour Module — shifts
-- Target    : Supabase PostgreSQL 17 (project: Suab)
--
-- Creates `shifts`: reusable shift templates per company (morning/night/etc.).
-- Depends on: companies (20261113095001).
-- ============================================================================

create table if not exists public.shifts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  name          text not null,
  start_time    time not null,
  end_time      time not null,
  break_minutes integer not null default 0,
  is_overnight  boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint chk_shifts_break_minutes_non_negative
    check (break_minutes >= 0)
);

comment on table public.shifts is
  'Shift templates per company; attendance and work_assignments may reference a shift.';

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
drop trigger if exists trg_shifts_updated_at on public.shifts;
create trigger trg_shifts_updated_at
  before update on public.shifts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists idx_shifts_company_id on public.shifts (company_id);
create index if not exists idx_shifts_company_name on public.shifts (company_id, name);
