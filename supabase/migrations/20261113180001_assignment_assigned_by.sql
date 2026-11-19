-- Step 4.11: record which supervisor created a work assignment.
--
-- Adds work_assignments.assigned_by (nullable uuid -> labour_profiles.id).
-- Additive only: no existing column is changed, nothing is dropped, no data
-- is modified. The supervisor function writes assigned_by only when this
-- column exists (it retries without it otherwise), so this migration is
-- optional — until it is applied the 201 response carries a warning.

-- 1. Add the column (guarded so re-running is a no-op).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'work_assignments'
      AND column_name  = 'assigned_by'
  ) THEN
    ALTER TABLE public.work_assignments
      ADD COLUMN assigned_by uuid REFERENCES public.labour_profiles (id)
        ON DELETE SET NULL;
  END IF;
END $$;

-- 2. Index for "assignments created by supervisor X" lookups.
CREATE INDEX IF NOT EXISTS idx_work_assignments_assigned_by
  ON public.work_assignments (assigned_by);
