-- Zettle parity for every site that enumerates the webshop platforms or the
-- integration connection tables. The zettle extension (20260909100000) adds
-- zettle_connections and writes platform = 'zettle' into webshop_orders, but:
--
--   1. webshop_orders.platform and webshop_store_settings.platform still
--      CHECK (platform in ('woocommerce', 'shopify')), so every Zettle upsert
--      would have been refused at the database (the unit tests mock Supabase
--      and never saw it).
--   2. The writer-role gate trigger (20260902093000) was attached to the
--      shopify/woocommerce connection tables by name; zettle_connections had
--      no aa_enforce_company_writer_role, so a viewer could connect a POS.
--   3. The migration-reset snapshot counts pending/active integrations as a
--      blocker and the reset locks those tables FOR UPDATE (20260818084050);
--      both enumerate stripe/woocommerce/shopify and missed zettle.
--
-- 3 follows the wrapper pattern of 20260826150000 (rename, wrap, revoke)
-- instead of re-issuing the 400-line reset body for one PERFORM line.

-- 1. Platform CHECK constraints -------------------------------------------

ALTER TABLE public.webshop_orders
  DROP CONSTRAINT IF EXISTS webshop_orders_platform_check;
ALTER TABLE public.webshop_orders
  ADD CONSTRAINT webshop_orders_platform_check
    CHECK (platform IN ('woocommerce', 'shopify', 'zettle'));

ALTER TABLE public.webshop_store_settings
  DROP CONSTRAINT IF EXISTS webshop_store_settings_platform_check;
ALTER TABLE public.webshop_store_settings
  ADD CONSTRAINT webshop_store_settings_platform_check
    CHECK (platform IN ('woocommerce', 'shopify', 'zettle'));

-- 2. Writer-role gate ------------------------------------------------------

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.zettle_connections;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.zettle_connections
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

-- 3a. Reset snapshot: a pending/active Zettle connection blocks the reset ---

ALTER FUNCTION public.company_migration_reset_snapshot(uuid)
  RENAME TO company_migration_reset_snapshot_before_20260909100400;

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
  v_zettle   integer;
BEGIN
  v_snapshot := public.company_migration_reset_snapshot_before_20260909100400(
    p_company_id
  );

  IF v_snapshot ->> 'code' = 'COMPANY_RESET_NOT_FOUND' THEN
    RETURN v_snapshot;
  END IF;

  SELECT count(*) INTO v_zettle
  FROM public.zettle_connections
  WHERE company_id = p_company_id AND status IN ('pending', 'active');

  IF v_zettle = 0 THEN
    RETURN v_snapshot;
  END IF;

  -- Fold into the existing active_integrations_or_schedules blocker when the
  -- inner snapshot already raised one; otherwise append it.
  SELECT COALESCE(jsonb_agg(
    CASE
      WHEN existing.blocker ->> 'code' = 'active_integrations_or_schedules'
        THEN existing.blocker || jsonb_build_object(
          'count', COALESCE((existing.blocker ->> 'count')::integer, 0) + v_zettle
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
      'count', v_zettle
    ));
  END IF;

  RETURN v_snapshot || jsonb_build_object(
    'eligible', false,
    'blockers', v_blockers
  );
END;
$$;

COMMENT ON FUNCTION public.company_migration_reset_snapshot(uuid) IS
  'Internal fail-closed reset snapshot. Journal entries, voucher sequences, and invoices are retained data, not blockers; lock, filing, sync, import, integration (incl. Zettle), and worker state still block.';

REVOKE ALL ON FUNCTION public.company_migration_reset_snapshot_before_20260909100400(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.company_migration_reset_snapshot(uuid)
  FROM PUBLIC, anon, authenticated;

-- 3b. Reset execution: lock zettle_connections with the other integrations --

ALTER FUNCTION public.reset_company_for_migration(uuid, text, text, boolean, boolean)
  RENAME TO reset_company_for_migration_before_20260909100400;

CREATE OR REPLACE FUNCTION public.reset_company_for_migration(
  p_company_id uuid,
  p_confirmed_name text,
  p_reason text,
  p_confirm_no_filed_declarations boolean,
  p_confirm_retained_archive boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only an owner reaches the lock: outsiders and non-owner members fall
  -- through to the inner function's own fast-fail so they cannot hold row
  -- locks on a foreign company while it rejects them.
  IF EXISTS (
    SELECT 1 FROM public.company_members cm
    WHERE cm.company_id = p_company_id
      AND cm.user_id = auth.uid()
      AND cm.role = 'owner'
  ) THEN
    PERFORM 1 FROM public.zettle_connections
    WHERE company_id = p_company_id FOR UPDATE;
  END IF;

  RETURN public.reset_company_for_migration_before_20260909100400(
    p_company_id,
    p_confirmed_name,
    p_reason,
    p_confirm_no_filed_declarations,
    p_confirm_retained_archive
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reset_company_for_migration_before_20260909100400(uuid, text, text, boolean, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reset_company_for_migration(uuid, text, text, boolean, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reset_company_for_migration(uuid, text, text, boolean, boolean)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
