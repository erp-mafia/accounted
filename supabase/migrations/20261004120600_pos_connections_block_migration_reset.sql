-- A live POS connection blocks a company migration reset, like every other
-- integration. reset_company_for_migration archives the source company and
-- creates a replacement; a connection left behind would keep fetching
-- business days into the archived company while the replacement gets none.
-- The snapshot counts pending/active integrations as the
-- active_integrations_or_schedules blocker (20260818084050, Zettle added by
-- 20260909100400); pos_connections (20261004120000) joins it here.
--
-- Same wrapper pattern as 20260909100400 (rename, wrap, revoke) instead of
-- re-issuing the snapshot body for one count. No row lock in the reset
-- itself: an ended connection never goes live again (a new connection is a
-- new row), so there is no state for a lock to hold still.
--
-- pg-test: tests/pg/company-migration-reset.pg.test.ts

ALTER FUNCTION public.company_migration_reset_snapshot(uuid)
  RENAME TO company_migration_reset_snapshot_before_20261004120600;

CREATE OR REPLACE FUNCTION public.company_migration_reset_snapshot(p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_snapshot jsonb;
  v_blockers jsonb;
  v_pos      integer;
BEGIN
  v_snapshot := public.company_migration_reset_snapshot_before_20261004120600(
    p_company_id
  );

  IF v_snapshot ->> 'code' = 'COMPANY_RESET_NOT_FOUND' THEN
    RETURN v_snapshot;
  END IF;

  SELECT count(*) INTO v_pos
  FROM public.pos_connections
  WHERE company_id = p_company_id AND status <> 'disconnected';

  IF v_pos = 0 THEN
    RETURN v_snapshot;
  END IF;

  -- Fold into the existing active_integrations_or_schedules blocker when the
  -- inner snapshot already raised one; otherwise append it.
  SELECT COALESCE(jsonb_agg(
    CASE
      WHEN existing.blocker ->> 'code' = 'active_integrations_or_schedules'
        THEN existing.blocker || jsonb_build_object(
          'count', COALESCE((existing.blocker ->> 'count')::integer, 0) + v_pos
        )
      ELSE existing.blocker
    END
    ORDER BY existing.position
  ), '[]'::jsonb)
  INTO v_blockers
  FROM jsonb_array_elements(v_snapshot -> 'blockers')
    WITH ORDINALITY AS existing(blocker, position);

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_blockers) AS b
    WHERE b ->> 'code' = 'active_integrations_or_schedules'
  ) THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'active_integrations_or_schedules',
      'count', v_pos
    ));
  END IF;

  RETURN v_snapshot || jsonb_build_object(
    'eligible', false,
    'blockers', v_blockers
  );
END;
$$;

COMMENT ON FUNCTION public.company_migration_reset_snapshot(uuid) IS
  'Internal fail-closed reset snapshot. Journal entries, voucher sequences, and invoices are retained data, not blockers; lock, filing, sync, import, integration (incl. Zettle and POS connections), and worker state still block.';

REVOKE ALL ON FUNCTION public.company_migration_reset_snapshot_before_20261004120600(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.company_migration_reset_snapshot(uuid)
  FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
