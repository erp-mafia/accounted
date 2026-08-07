-- Byte-for-byte the same function as 20260806160000 (see that file for the
-- full rationale). Two versions exist because the PR's Supabase preview
-- branch applied 150000 while this change was still iterating: deleting the
-- file orphans the preview's migration tracker ("Remote migration versions
-- not found in local migrations directory"), and an earlier interim body
-- (preserve-for-everyone, no actor check) must not live on as a standalone
-- applyable unit. With identical content in both files, any environment that
-- applies either or both, in any order, lands on the same guarded function.
CREATE OR REPLACE FUNCTION public.set_committed_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_jwt_role text;
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
    v_jwt_role := coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
      nullif(current_setting('request.jwt.claim.role', true), ''),
      ''
    );
    IF NEW.committed_at IS NULL
       OR NOT (v_jwt_role = '' OR v_jwt_role = 'service_role') THEN
      NEW.committed_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
