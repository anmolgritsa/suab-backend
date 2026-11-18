-- ============================================================================
-- Migration : 20261113095007_create_overtime_requests.sql
-- Module    : Labour Module — overtime requests
-- Target    : Supabase PostgreSQL 17 (project: Suab)
--
-- Creates `overtime_requests`: extra-hours requests with a CHECK on hours.
-- Depends on: companies (…95001), labour_profiles (…95003).
-- ============================================================================

create table if not exists public.overtime_requests (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete cascade,
  labour_profile_id uuid not null references public.labour_profiles (id) on delete restrict,
  date              date not null,
  hours             numeric(4,2) not null,
  reason            text,
  status            public.request_status not null default 'pending',
  reviewed_by       uuid,
  reviewed_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint chk_overtime_requests_hours_positive
    check (hours > 0),
  constraint chk_overtime_requests_reviewed_at_set
    check ((status in ('approved','rejected')) = (reviewed_at is not null))
);

comment on table public.overtime_requests is
  'Overtime (extra hours) requests with an approval lifecycle.';

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
drop trigger if exists trg_overtime_requests_updated_at on public.overtime_requests;
create trigger trg_overtime_requests_updated_at
  before update on public.overtime_requests
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists idx_overtime_requests_company_id on public.overtime_requests (company_id);
create index if not exists idx_overtime_requests_labour_profile_id on public.overtime_requests (labour_profile_id);
create index if not exists idx_overtime_requests_date on public.overtime_requests (date);
create index if not exists idx_overtime_requests_company_status on public.overtime_requests (company_id, status);
create index if not exists idx_overtime_requests_profile_date on public.overtime_requests (labour_profile_id, date);
