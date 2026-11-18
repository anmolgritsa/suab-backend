-- ============================================================================
-- Migration : 20261113095008_create_work_submissions.sql
-- Module    : Labour Module — work submissions
-- Target    : Supabase PostgreSQL 17 (project: Suab)
--
-- Creates `work_submissions`: output logged against work assignments.
-- Depends on: companies (…95001), work_assignments (…95005),
-- labour_profiles (…95003).
-- ============================================================================

create table if not exists public.work_submissions (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies (id) on delete cascade,
  work_assignment_id uuid not null references public.work_assignments (id) on delete restrict,
  labour_profile_id  uuid not null references public.labour_profiles (id) on delete restrict,
  quantity           integer not null,
  submitted_at       timestamptz not null default now(),
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint chk_work_submissions_quantity_positive
    check (quantity > 0)
);

comment on table public.work_submissions is
  'Output quantities logged by labourers against work assignments.';

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
drop trigger if exists trg_work_submissions_updated_at on public.work_submissions;
create trigger trg_work_submissions_updated_at
  before update on public.work_submissions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists idx_work_submissions_company_id on public.work_submissions (company_id);
create index if not exists idx_work_submissions_work_assignment_id on public.work_submissions (work_assignment_id);
create index if not exists idx_work_submissions_labour_profile_id on public.work_submissions (labour_profile_id);
create index if not exists idx_work_submissions_submitted_at on public.work_submissions (submitted_at);
create index if not exists idx_work_submissions_assignment_profile on public.work_submissions (work_assignment_id, labour_profile_id);
