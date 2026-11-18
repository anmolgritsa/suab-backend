-- ============================================================================
-- Migration : 20261113110001_company_geofence.sql
-- Module    : Labour Module — company geofence (attendance location check)
-- Target    : Supabase PostgreSQL 17 (project: Suab)
--
-- DRAFT — DO NOT PUSH until reviewed and approved.
--
-- Adds geofence configuration to `companies` so the `attendance` edge
-- function can validate check-in GPS against the factory location.
--
-- Design: dedicated typed columns (not companies.settings jsonb) so the
-- values are validated by a CHECK constraint and easy to index/query.
--
-- Idempotent: guarded ALTERs — nothing is dropped, no data is modified,
-- no tables are recreated. Safe to re-run.
-- ============================================================================

-- 1. Columns (each guarded so re-running never errors on existing columns).
do $$ begin
  alter table public.companies add column geofence_enabled boolean not null default false;
exception when duplicate_column then null; end $$;

do $$ begin
  alter table public.companies add column geofence_latitude double precision;
exception when duplicate_column then null; end $$;

do $$ begin
  alter table public.companies add column geofence_longitude double precision;
exception when duplicate_column then null; end $$;

do $$ begin
  alter table public.companies add column geofence_radius_m integer;
exception when duplicate_column then null; end $$;

-- 2. Validity: when the geofence is enabled, all three values must be present
--    and sane (lat -90..90, lon -180..180, radius 10..100000 m).
do $$ begin
  alter table public.companies add constraint chk_companies_geofence_config check (
    geofence_enabled = false
    or (
      geofence_latitude  is not null and geofence_latitude  >= -90 and geofence_latitude  <= 90
      and geofence_longitude is not null and geofence_longitude >= -180 and geofence_longitude <= 180
      and geofence_radius_m  is not null and geofence_radius_m  >= 10  and geofence_radius_m  <= 100000
    )
  );
exception when duplicate_object then null; end $$;

-- 3. Index for company lookups by geofence state (minor; company count is small).
create index if not exists idx_companies_geofence_enabled
  on public.companies (geofence_enabled)
  where geofence_enabled = true;

comment on column public.companies.geofence_enabled is
  'When true, attendance check-ins must be inside the configured geofence.';
comment on column public.companies.geofence_latitude is
  'Factory geofence centre latitude (-90..90). Required when geofence_enabled.';
comment on column public.companies.geofence_longitude is
  'Factory geofence centre longitude (-180..180). Required when geofence_enabled.';
comment on column public.companies.geofence_radius_m is
  'Factory geofence radius in metres (10..100000). Required when geofence_enabled.';
