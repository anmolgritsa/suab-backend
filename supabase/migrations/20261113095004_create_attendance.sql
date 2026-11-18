-- ============================================================================
-- Migration : 20261113095004_create_attendance.sql
-- Module    : Labour Module — attendance
-- Target    : Supabase PostgreSQL 17 (project: Suab)
--
-- Creates `attendance`: one row per labourer per day. Depends on:
-- companies (…95001), labour_profiles (…95003), shifts (…95002).
-- ============================================================================

create table if not exists public.attendance (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete cascade,
  labour_profile_id uuid not null references public.labour_profiles (id) on delete restrict,
  shift_id          uuid references public.shifts (id) on delete set null,
  date              date not null,
  check_in          timestamptz,
  check_out         timestamptz,
  status            public.attendance_status not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint uq_attendance_profile_date unique (labour_profile_id, date),
  constraint chk_attendance_check_in_before_check_out
    check (check_in is null or check_out is null or check_in <= check_out)
);

comment on table public.attendance is
  'Daily attendance per labourer; unique on (labour_profile_id, date).';

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
drop trigger if exists trg_attendance_updated_at on public.attendance;
create trigger trg_attendance_updated_at
  before update on public.attendance
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists idx_attendance_company_id on public.attendance (company_id);
create index if not exists idx_attendance_labour_profile_id on public.attendance (labour_profile_id);
create index if not exists idx_attendance_shift_id on public.attendance (shift_id);
create index if not exists idx_attendance_date on public.attendance (date);
create index if not exists idx_attendance_company_date on public.attendance (company_id, date);
create index if not exists idx_attendance_company_date_status on public.attendance (company_id, date, status);
