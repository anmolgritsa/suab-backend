-- ============================================================================
-- Migration : 20261113095005_create_work_assignments.sql
-- Module    : Labour Module — work assignments
-- Target    : Supabase PostgreSQL 17 (project: Suab)
--
-- Creates `work_assignments`: tasks assigned to labourers, optionally
-- piece-rate. Depends on: companies (…95001), labour_profiles (…95003).
-- ============================================================================

create table if not exists public.work_assignments (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete cascade,
  labour_profile_id uuid not null references public.labour_profiles (id) on delete restrict,
  title             text not null,
  description       text,
  quantity_target   integer,
  rate_per_unit     numeric(10,2),
  due_date          date,
  status            public.assignment_status not null default 'pending',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint chk_work_assignments_quantity_target_positive
    check (quantity_target is null or quantity_target > 0),
  constraint chk_work_assignments_rate_per_unit_non_negative
    check (rate_per_unit is null or rate_per_unit >= 0)
);

comment on table public.work_assignments is
  'Tasks assigned to labourers; supports piece-rate via rate_per_unit.';

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
drop trigger if exists trg_work_assignments_updated_at on public.work_assignments;
create trigger trg_work_assignments_updated_at
  before update on public.work_assignments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists idx_work_assignments_company_id on public.work_assignments (company_id);
create index if not exists idx_work_assignments_labour_profile_id on public.work_assignments (labour_profile_id);
create index if not exists idx_work_assignments_due_date on public.work_assignments (due_date);
create index if not exists idx_work_assignments_company_status on public.work_assignments (company_id, status);
create index if not exists idx_work_assignments_profile_status on public.work_assignments (labour_profile_id, status);
