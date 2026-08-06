-- Superseded milliseconds later by 20260806160000, which adds the trusted-
-- role guard. This intermediate version is kept because the PR's Supabase
-- preview branch had already applied it: deleting the file orphans the
-- preview's migration tracker ("Remote migration versions not found in local
-- migrations directory") and fails the preview check. On a fresh database
-- (prod at merge) the two apply back to back inside the same deploy, so the
-- unguarded semantics below are never live on their own.
--
-- set_committed_at() (migration 017) stamped committed_at := now() on every
-- draft-to-posted transition, discarding any committed_at the row already
-- carried. Stamp only when the column is NULL so seeding flows that backdate
-- history keep their historical booking time.
CREATE OR REPLACE FUNCTION public.set_committed_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'posted' AND NEW.committed_at IS NULL THEN
    NEW.committed_at := now();
  END IF;
  RETURN NEW;
END;
$$;
