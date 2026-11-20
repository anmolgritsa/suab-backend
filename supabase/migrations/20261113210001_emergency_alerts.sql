-- ============================================================================
-- Migration : 20261113210001_emergency_alerts.sql
-- Module    : Labour Module — emergency alerts (SOS)
-- Target    : Supabase PostgreSQL 17 (project: Suab)
--
-- Creates the `emergency_alerts` table: SOS alerts triggered by labourers
-- from the shop floor, with GPS location, emergency type and a status
-- lifecycle (pending -> acknowledged -> resolved) handled by supervisors.
--
-- Labourers create and read their own alerts (POST /emergency); supervisors
-- read and manage alerts company-wide (GET /emergency, PATCH /emergency/:id).
-- Notification channel for now: the pending queue itself (GET /emergency).
-- Email/push would need an external service + secret — separate step.
--
-- Idempotent, additive only: nothing existing is dropped, altered or reset.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Enum: alert lifecycle (guarded so re-running never errors).
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.emergency_status as enum (
    'pending',
    'acknowledged',
    'resolved'
  );
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Enum: what kind of emergency (guarded so re-running never errors).
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.emergency_type as enum (
    'accident',
    'medical',
    'fire',
    'other'
  );
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table if not exists public.emergency_alerts (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  labour_profile_id uuid not null references public.labour_profiles(id) on delete restrict,
  emergency_type    public.emergency_type not null,
  latitude          double precision,
  longitude         double precision,
  status            public.emergency_status not null default 'pending',
  acknowledged_by   uuid references public.labour_profiles(id) on delete set null,
  acknowledged_at   timestamptz,
  resolved_by       uuid references public.labour_profiles(id) on delete set null,
  resolved_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- GPS is optional (a failed fix must never block an SOS) but bounded.
  constraint chk_emergency_alerts_lat check (
    latitude is null or latitude between -90 and 90
  ),
  constraint chk_emergency_alerts_lon check (
    longitude is null or longitude between -180 and 180
  ),
  -- Lifecycle consistency: an acknowledged/resolved alert carries its timestamps.
  constraint chk_emergency_alerts_ack check (
    status not in ('acknowledged', 'resolved') or acknowledged_at is not null
  ),
  constraint chk_emergency_alerts_resolved check (
    status <> 'resolved' or resolved_at is not null
  )
);

-- ---------------------------------------------------------------------------
-- Indexes (FK columns + the common filters: status and time)
-- ---------------------------------------------------------------------------
create index if not exists idx_emergency_alerts_company
  on public.emergency_alerts (company_id);
create index if not exists idx_emergency_alerts_labour
  on public.emergency_alerts (labour_profile_id);
create index if not exists idx_emergency_alerts_status
  on public.emergency_alerts (status);
create index if not exists idx_emergency_alerts_created_at
  on public.emergency_alerts (created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at trigger (same shared function as every other table)
-- ---------------------------------------------------------------------------
drop trigger if exists trg_emergency_alerts_updated_at on public.emergency_alerts;
create trigger trg_emergency_alerts_updated_at
  before update on public.emergency_alerts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — same model as labour_updates, with one deliberate difference:
--   SELECT   : anyone in the same company (supervisors read their labourers)
--   INSERT   : the labourer themselves, or a privileged profile
--   UPDATE   : privileged profiles ONLY — a labourer must never be able to
--              acknowledge or resolve their own SOS (the lifecycle belongs
--              to the supervisor side)
--   DELETE   : none (no policy — service role only)
-- ---------------------------------------------------------------------------
alter table public.emergency_alerts enable row level security;

drop policy if exists emergency_alerts_select_company on public.emergency_alerts;
create policy emergency_alerts_select_company on public.emergency_alerts
  for select to authenticated
  using (public.is_company_member(company_id));

drop policy if exists emergency_alerts_insert_own_or_privileged on public.emergency_alerts;
create policy emergency_alerts_insert_own_or_privileged on public.emergency_alerts
  for insert to authenticated
  with check (
    public.is_own_labour_profile(labour_profile_id)
    or public.has_privileged_role(company_id)
  );

-- Cleanup: an earlier draft of this migration (run by mistake during
-- validation) created an UPDATE policy that also allowed the labourer to
-- update their own alert. Drop it so only the privileged-only policy remains.
drop policy if exists emergency_alerts_update_own_or_privileged on public.emergency_alerts;

drop policy if exists emergency_alerts_update_privileged on public.emergency_alerts;
create policy emergency_alerts_update_privileged on public.emergency_alerts
  for update to authenticated
  using (public.has_privileged_role(company_id))
  with check (public.has_privileged_role(company_id));
