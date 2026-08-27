-- Allow archive-and-replace migration resets after accounting records exist.
--
-- The 2026-08-18 eligibility rule stopped self-service before the first
-- journal entry, voucher sequence, or invoice on the retained source. The rule
-- protected voucher-namespace continuity inside the same legal entity, but the
-- reset never deletes anything: the source stays a write-closed retention
-- container holding every voucher, sequence, invoice, and document, and the
-- replacement owner can download it through the retained-source archive. The
-- unchecked "Radera företag" path already produced the same outcome (archived
-- source plus a fresh company with the same org number) with none of that
-- protection, so the blockers only pushed owners toward the weaker route.
-- Observed live 2026-08-26: an owner who imported two fiscal years in the
-- wrong order was shown "Självservice är blockerad" with no way forward.
--
-- Journal-entry, voucher-sequence, and invoice counts stay in the snapshot as
-- retained-data information. Every external-state blocker is unchanged: locked
-- or closed periods, authority submissions and staging state, live bank
-- connections, running imports, active integrations, background work, the
-- 30-day window, and sandbox companies.

ALTER FUNCTION public.company_migration_reset_snapshot(uuid)
  RENAME TO company_migration_reset_snapshot_before_20260826150000;

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
BEGIN
  v_snapshot := public.company_migration_reset_snapshot_before_20260826150000(
    p_company_id
  );

  IF v_snapshot ->> 'code' = 'COMPANY_RESET_NOT_FOUND' THEN
    RETURN v_snapshot;
  END IF;

  -- Accounting records are retained, not disposed of, so their presence is
  -- reported through counts and must not decide eligibility.
  SELECT COALESCE(jsonb_agg(existing.blocker ORDER BY existing.position), '[]'::jsonb)
  INTO v_blockers
  FROM jsonb_array_elements(v_snapshot -> 'blockers')
    WITH ORDINALITY AS existing(blocker, position)
  WHERE existing.blocker ->> 'code' NOT IN (
    'journal_entries_exist',
    'non_import_committed_entries',
    'voucher_sequence_state_exists',
    'invoice_records_exist'
  );

  RETURN v_snapshot || jsonb_build_object(
    'eligible', jsonb_array_length(v_blockers) = 0,
    'blockers', v_blockers
  );
END;
$$;

COMMENT ON FUNCTION public.company_migration_reset_snapshot(uuid) IS
  'Internal fail-closed reset snapshot. Journal entries, voucher sequences, and invoices are retained data, not blockers; lock, filing, sync, import, integration, and worker state still block.';

REVOKE ALL ON FUNCTION public.company_migration_reset_snapshot_before_20260826150000(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.company_migration_reset_snapshot(uuid)
  FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
