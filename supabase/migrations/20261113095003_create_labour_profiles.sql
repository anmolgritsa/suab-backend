-- ============================================================================
-- Migration : 20261113095003_create_labour_profiles.sql
-- Module    : Labour Module — labour profiles
-- Target    : Supabase PostgreSQL 17 (project: Suab)
--
-- Creates `labour_profiles`: workers, linked to a company and optionally to
-- an auth.users account. Depends on: companies (20261113095001).
-- ============================================================================

create table if not exists public.labour_profiles (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete cascade,
  user_id           uuid references auth.users (id) on delete set null,
  full_name         text not null,
  employee_code     text not null,
  phone             text,
  role              text,
  employment_type   public.employment_type not null default 'full_time',
  wage_type         public.wage_type not null default 'monthly',
  hourly_rate       numeric(10,2),
  status            public.labour_status not null default 'active',
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint chk_labour_profiles_hourly_rate_non_negative
    check (hourly_rate is null or hourly_rate >= 0)
);

comment on table public.labour_profiles is
  'Workers per company; optionally linked to auth.users for login identity.';

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
drop trigger if exists trg_labour_profiles_updated_at on public.labour_profiles;
create trigger trg_labour_profiles_updated_at
  before update on public.labour_profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists idx_labour_profiles_company_id on public.labour_profiles (company_id);
create index if not exists idx_labour_profiles_user_id on public.labour_profiles (user_id);
create index if not exists idx_labour_profiles_status on public.labour_profiles (company_id, status);
create index if not exists idx_labour_profiles_full_name on public.labour_profiles (company_id, full_name);
