-- ============================================================================
-- Migration : 20261113095001_create_companies.sql
-- Module    : Labour Module — companies (tenant root)
-- Target    : Supabase PostgreSQL 17 (project: Suab)
--
-- Creates the `companies` table, the tenant root for the Labour Module.
-- Every other labour table carries company_id for multi-company isolation.
--
-- Idempotency: CREATE TYPE guards (DO $$ ... pg_type) and
-- CREATE TABLE IF NOT EXISTS — nothing existing is dropped or overwritten.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Shared updated_at trigger function (created once, reused by all tables).
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Enumerated types (guarded so re-running never errors on existing types).
-- ---------------------------------------------------------------------------

-- Lifecycle status of a company tenant.
do $$ begin
  create type public.company_status as enum ('onboarding', 'active', 'inactive', 'suspended');
exception when duplicate_object then null; end $$;

-- How a labourer is engaged.
do $$ begin
  create type public.employment_type as enum ('full_time', 'part_time', 'contract', 'temporary', 'intern', 'daily_wager');
exception when duplicate_object then null; end $$;

-- Lifecycle status of a labour profile.
do $$ begin
  create type public.labour_status as enum ('probation', 'active', 'on_leave', 'suspended', 'terminated');
exception when duplicate_object then null; end $$;

-- Basis on which wages are computed.
do $$ begin
  create type public.wage_type as enum ('hourly', 'daily', 'monthly', 'piece_rate');
exception when duplicate_object then null; end $$;

-- Broad category of a work shift.
do $$ begin
  create type public.shift_type as enum ('morning', 'afternoon', 'evening', 'night', 'split', 'flexible');
exception when duplicate_object then null; end $$;

-- Outcome of a day's attendance for a labourer.
do $$ begin
  create type public.attendance_status as enum ('present', 'absent', 'late', 'half_day', 'leave', 'holiday', 'on_duty');
exception when duplicate_object then null; end $$;

-- Shared approval lifecycle for half-day / overtime requests.
do $$ begin
  create type public.request_status as enum ('pending', 'approved', 'rejected', 'cancelled');
exception when duplicate_object then null; end $$;

-- Which half of the day a half-day request covers.
do $$ begin
  create type public.half_day_session as enum ('morning', 'afternoon');
exception when duplicate_object then null; end $$;

-- Execution lifecycle of a work assignment.
do $$ begin
  create type public.assignment_status as enum ('pending', 'in_progress', 'completed', 'cancelled', 'overdue');
exception when duplicate_object then null; end $$;

-- Review lifecycle of a work submission.
do $$ begin
  create type public.submission_status as enum ('pending', 'approved', 'rejected', 'needs_revision');
exception when duplicate_object then null; end $$;

-- Size class of a company / factory (scales across industries).
do $$ begin
  create type public.company_size as enum ('small', 'medium', 'large');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------------
create table if not exists public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  industry    text,
  size        public.company_size not null default 'small',
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.companies is
  'Tenant root for the Labour Module; all labour tables reference companies.id via company_id.';

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
drop trigger if exists trg_companies_updated_at on public.companies;
create trigger trg_companies_updated_at
  before update on public.companies
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists idx_companies_slug on public.companies (slug);
create index if not exists idx_companies_industry on public.companies (industry);
create index if not exists idx_companies_size on public.companies (size);
