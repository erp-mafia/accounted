-- Close the remaining archive-and-replace boundaries found in compliance
-- review. Existing invoice records are accounting documents even before a
-- voucher is posted, and retained filing/import evidence must stay static.

ALTER FUNCTION public.company_migration_reset_snapshot(uuid)
  RENAME TO company_migration_reset_snapshot_before_20260818143004;

CREATE OR REPLACE FUNCTION public.company_migration_reset_snapshot(p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_snapshot        jsonb;
  v_blockers        jsonb;
  v_invoice_records integer;
BEGIN
  v_snapshot := public.company_migration_reset_snapshot_before_20260818143004(
    p_company_id
  );

  IF v_snapshot ->> 'code' = 'COMPANY_RESET_NOT_FOUND' THEN
    RETURN v_snapshot;
  END IF;

  v_invoice_records :=
    COALESCE((v_snapshot -> 'counts' ->> 'invoices')::integer, 0)
    + COALESCE((v_snapshot -> 'counts' ->> 'supplier_invoices')::integer, 0);

  SELECT COALESCE(jsonb_agg(existing.blocker ORDER BY existing.position), '[]'::jsonb)
  INTO v_blockers
  FROM jsonb_array_elements(v_snapshot -> 'blockers')
    WITH ORDINALITY AS existing(blocker, position)
  WHERE existing.blocker ->> 'code' <> 'invoice_records_exist';

  IF v_invoice_records > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'invoice_records_exist',
      'count', v_invoice_records
    ));
  END IF;

  RETURN v_snapshot || jsonb_build_object(
    'eligible', jsonb_array_length(v_blockers) = 0,
    'blockers', v_blockers
  );
END;
$$;

COMMENT ON FUNCTION public.company_migration_reset_snapshot(uuid) IS
  'Internal fail-closed reset snapshot. Any journal, voucher sequence, or invoice record blocks archive-and-replace.';

REVOKE ALL ON FUNCTION public.company_migration_reset_snapshot_before_20260818143004(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.company_migration_reset_snapshot(uuid)
  FROM PUBLIC, anon, authenticated;

-- Check both sides of an UPDATE. The first version checked only OLD, which
-- blocked edits to an archived row but did not independently reject moving an
-- active row into an archived company through an elevated writer.
CREATE OR REPLACE FUNCTION public.block_migration_reset_source_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_company_id uuid;
  v_new_company_id uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old_company_id := OLD.company_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new_company_id := NEW.company_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.company_migration_resets
    WHERE source_company_id IN (v_old_company_id, v_new_company_id)
  ) THEN
    RAISE EXCEPTION 'Archived migration reset source records are immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.block_migration_reset_source_mutation()
  FROM PUBLIC, anon, authenticated;

-- These tables can still contain draft or disconnected evidence on an
-- otherwise eligible source. Once archived, all such rows must be as static as
-- transactions and documents. The existing trigger function checks the reset
-- audit row and does not affect active companies.
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'bank_connections',
    'company_settings',
    'salary_runs',
    'salary_run_employees',
    'salary_line_items',
    'agi_declarations',
    'arsredovisning_submissions',
    'rot_rut_payout_requests',
    'skatteverket_api_audit_log'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation()',
      v_table || '_block_migration_reset_source_mutation',
      v_table
    );
  END LOOP;
END;
$$;

-- Company identity and archive metadata are part of the retained system
-- documentation. The reset transaction finishes all source-company updates
-- before inserting the audit link, so later source updates are never needed.
CREATE OR REPLACE FUNCTION public.block_migration_reset_source_company_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.company_migration_resets
    WHERE source_company_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Archived migration reset source company is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER zz_companies_block_migration_reset_source_mutation
  BEFORE UPDATE ON public.companies
  FOR EACH ROW
  EXECUTE FUNCTION public.block_migration_reset_source_company_mutation();

REVOKE ALL ON FUNCTION public.block_migration_reset_source_company_mutation()
  FROM PUBLIC, anon, authenticated;

-- Journal lines are company-scoped through their parent. Check both parent
-- references on UPDATE so a line cannot be reassigned into a retained source.
CREATE OR REPLACE FUNCTION public.block_migration_reset_source_journal_line_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_entry_id uuid;
  v_new_entry_id uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old_entry_id := OLD.journal_entry_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new_entry_id := NEW.journal_entry_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.journal_entries entry
    JOIN public.company_migration_resets reset
      ON reset.source_company_id = entry.company_id
    WHERE entry.id IN (v_old_entry_id, v_new_entry_id)
  ) THEN
    RAISE EXCEPTION 'Archived migration reset source records are immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.block_migration_reset_source_journal_line_mutation()
  FROM PUBLIC, anon, authenticated;

-- ROT/RUT request items are company-scoped through their parent and therefore
-- need the same parent lookup pattern as journal-entry lines.
CREATE OR REPLACE FUNCTION public.block_migration_reset_source_rot_rut_item_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_request_id uuid;
  v_new_request_id uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old_request_id := OLD.request_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new_request_id := NEW.request_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.rot_rut_payout_requests request
    JOIN public.company_migration_resets reset
      ON reset.source_company_id = request.company_id
    WHERE request.id IN (v_old_request_id, v_new_request_id)
  ) THEN
    RAISE EXCEPTION 'Archived migration reset source records are immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rot_rut_payout_request_items_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.rot_rut_payout_request_items
  FOR EACH ROW
  EXECUTE FUNCTION public.block_migration_reset_source_rot_rut_item_mutation();

REVOKE ALL ON FUNCTION public.block_migration_reset_source_rot_rut_item_mutation()
  FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
