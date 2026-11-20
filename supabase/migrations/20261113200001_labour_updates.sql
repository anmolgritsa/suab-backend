-- ============================================================================
-- Migration : 20261113200001_labour_updates.sql
-- Module    : Labour Module — labour updates (field reports)
-- Target    : Supabase PostgreSQL 17 (project: Suab)
--
-- Creates the `labour_updates` table: reports submitted by labourers from the
-- shop floor — machine maintenance, machine breakdown, raw-material defects,
-- or other work activities — optionally with a voice-note / image URL.
--
-- Supervisors read them company-wide (GET /supervisor/updates); labourers
-- create and read their own (POST/GET /updates).
--
-- Idempotent, additive only: nothing existing is dropped, altered or reset.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Enum: what kind of update this is (guarded so re-running never errors).
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.labour_update_type as enum (
    'machine_maintenance',
    'machine_breakdown',
    'raw_material_defect',
    'other'
  );
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table if not exists public.labour_updates (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  labour_profile_id uuid not null references public.labour_profiles(id) on delete restrict,
  update_type       public.labour_update_type not null,
  description       text not null,
  voice_note_url    text,
  image_url         text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- Description is the one required free-text field; keep it bounded.
  constraint chk_labour_updates_description_len check (char_length(description) <= 2000),
  -- Attachment URLs must be http(s) and bounded (same rule as the other tables).
  constraint chk_labour_updates_voice_url check (
    voice_note_url is null or (voice_note_url ~* '^https?://.+' and char_length(voice_note_url) <= 1000)
  ),
  constraint chk_labour_updates_image_url check (
    image_url is null or (image_url ~* '^https?://.+' and char_length(image_url) <= 1000)
  )
);

-- ---------------------------------------------------------------------------
-- Indexes (FK columns + the common filters: type and time)
-- ---------------------------------------------------------------------------
create index if not exists idx_labour_updates_company
  on public.labour_updates (company_id);
create index if not exists idx_labour_updates_labour
  on public.labour_updates (labour_profile_id);
create index if not exists idx_labour_updates_type
  on public.labour_updates (update_type);
create index if not exists idx_labour_updates_created_at
  on public.labour_updates (created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at trigger (same shared function as every other table)
-- ---------------------------------------------------------------------------
drop trigger if exists trg_labour_updates_updated_at on public.labour_updates;
create trigger trg_labour_updates_updated_at
  before update on public.labour_updates
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — same model as shift_sessions:
--   SELECT   : anyone in the same company (supervisors read their labourers)
--   INSERT   : the labourer themselves, or a privileged profile
--   UPDATE   : the labourer themselves, or a privileged profile
--   DELETE   : none (no policy — service role only)
-- ---------------------------------------------------------------------------
alter table public.labour_updates enable row level security;

drop policy if exists labour_updates_select_company on public.labour_updates;
create policy labour_updates_select_company on public.labour_updates
  for select to authenticated
  using (public.is_company_member(company_id));

drop policy if exists labour_updates_insert_own_or_privileged on public.labour_updates;
create policy labour_updates_insert_own_or_privileged on public.labour_updates
  for insert to authenticated
  with check (
    public.is_own_labour_profile(labour_profile_id)
    or public.has_privileged_role(labour_profile_id)
  );

drop policy if exists labour_updates_update_own_or_privileged on public.labour_updates;
create policy labour_updates_update_own_or_privileged on public.labour_updates
  for update to authenticated
  using (
    public.is_own_labour_profile(labour_profile_id)
    or public.has_privileged_role(labour_profile_id)
  )
  with check (
    public.is_own_labour_profile(labour_profile_id)
    or public.has_privileged_role(labour_profile_id)
  );
