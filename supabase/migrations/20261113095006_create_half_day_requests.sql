-- ============================================================================
-- Migration : 20261113095006_create_half_day_requests.sql
-- Module    : Labour Module — half-day requests
-- Target    : Supabase PostgreSQL 17 (project: Suab)
--
-- Creates `half_day_requests`: AM/PM half-day leave requests.
-- Depends on: companies (…95001), labour_profiles (…95003).
-- ============================================================================

create table if not exists public.half_day_requests (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete cascade,
  labour_profile_id uuid not null references public.labour_profiles (id) on delete restrict,
  date              date not null,
  session           public.half_day_session not null,
  reason            text,
  status            public.request_status not null default 'pending',
  reviewed_by       uuid,
  reviewed_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint chk_half_day_requests_reviewed_at_set
    check ((status in ('approved','rejected')) = (reviewed_at is not null))
);

comment on table public.half_day_requests is
  'Half-day (AM/PM) leave requests with an approval lifecycle.';

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
drop trigger if exists trg_half_day_requests_updated_at on public.half_day_requests;
create trigger trg_half_day_requests_updated_at
  before update on public.half_day_requests
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists idx_half_day_requests_company_id on public.half_day_requests (company_id);
create index if not exists idx_half_day_requests_labour_profile_id on public.half_day_requests (labour_profile_id);
create index if not exists idx_half_day_requests_date on public.half_day_requests (date);
create index if not exists idx_half_day_requests_company_status on public.half_day_requests (company_id, status);
create index if not exists idx_half_day_requests_profile_date on public.half_day_requests (labour_profile_id, date);
