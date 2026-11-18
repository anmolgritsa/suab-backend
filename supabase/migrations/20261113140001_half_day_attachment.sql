-- ============================================================================
-- Migration : 20261113140001_half_day_attachment.sql
-- Module    : Labour Module — half-day requests (voice-note attachment)
-- Target    : Supabase PostgreSQL 17 (project: Suab)
--
-- DRAFT — NOT APPLIED. Awaiting explicit approval before `supabase db push`.
--
-- What it adds to `half_day_requests`:
--   1. attachment_url  — optional voice-note / document URL (Supabase Storage
--      or any https URL). Nullable; max length enforced by CHECK.
--   2. Partial unique index — at most ONE pending request per labourer per
--      date. This is the hard concurrency guard behind the API's 409s
--      (two simultaneous "apply" requests -> the second fails with 23505).
--
-- Nothing is dropped or altered beyond these two additions; no data changes.
-- ============================================================================

-- 1. attachment_url column (idempotent guard: skip if it already exists)
do $$
begin
  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.half_day_requests'::regclass
      and attname = 'attachment_url'
      and not attisdropped
  ) then
    alter table public.half_day_requests
      add column attachment_url text;
    comment on column public.half_day_requests.attachment_url is
      'Optional voice-note or document URL (e.g. Supabase Storage). Nullable.';
  end if;
end
$$;

-- 2. CHECK: attachment_url must be an http(s) URL when present
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_half_day_requests_attachment_url'
      and conrelid = 'public.half_day_requests'::regclass
  ) then
    alter table public.half_day_requests
      add constraint chk_half_day_requests_attachment_url
      check (attachment_url is null or
             (length(attachment_url) <= 1000 and attachment_url ~ '^https?://'));
  end if;
end
$$;

-- 3. Partial unique index: one PENDING request per labourer per date.
--    (approved/rejected/cancelled rows do not count — re-applying is allowed.)
create unique index if not exists uq_half_day_requests_pending
  on public.half_day_requests (labour_profile_id, date)
  where status = 'pending';

-- 4. Index for attachment lookups (rare, but cheap to add now)
create index if not exists idx_half_day_requests_attachment
  on public.half_day_requests (attachment_url)
  where attachment_url is not null;
