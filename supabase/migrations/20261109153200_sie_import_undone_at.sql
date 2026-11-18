-- An undone SIE import reads as undone (#200, audit INT-1).
--
-- sie_imports carries two lifecycles. job_state is the durable job's state
-- machine, owned by the import RPCs; status and replaced_at are the columns
-- from before durable jobs. undo_sie_import_chunk and
-- undo_sie_duplicate_repair_chunk end a job with job_state 'undone' and
-- status 'replaced' and record no time, so nothing said when an undo took a
-- batch back out of the ledger, and the behandlingshistorik (BFL 5 kap 11 §,
-- BFNAR 2013:2) showed an undone import as merely started.
--
--   1. sie_imports.undone_at: when the job reached job_state 'undone'. For an
--      import that is the end of its undo, after the last storno chunk; for
--      a reviewed duplicate repair it is the end of the repair.
--   2. stamp_sie_undone_at stamps it on that transition and owns the column:
--      a write by anon, authenticated or service_role never sets or moves
--      it. A trigger rather than a change to the two chunk RPCs: it holds for
--      every writer that ends a job as undone, and the RPCs stay as they are.
--   3. fiscal_year_reset_snapshot refuses a year that holds a completed
--      durable SIE import (blocker 'sie_import_in_place'). reset_fiscal_year
--      marks the year's completed imports status 'undone' and never touches
--      job_state, so a job row could read completed and undone at once. A
--      year whose import still stands is reset after its own undo, the storno
--      track. Where the year already holds batch entries the existing
--      'retained_import_history' blocker answers, and this one is not added.
--      The snapshot is the 20260911165003 definition copied byte for byte
--      with one ELSIF added after that blocker; CREATE OR REPLACE keeps its
--      signature, owner and ACL, and the revoke and comment are restated.
--
-- Imports undone before this migration keep undone_at NULL: their time is in
-- the audit_log UPDATE rows, and writing it back is a separate data change.
-- The behandlingshistorik shows such an undo without a time.
--
-- Rollout: the application reads undone_at and falls back to the columns
-- before it on 42703 (src/lib/reports/behandlingshistorik.ts), and an unknown
-- blocker code reads as the generic one in the reset dialog.
--
-- pg-test: tests/pg/sie-import-undone-at.pg.test.ts

ALTER TABLE public.sie_imports ADD COLUMN IF NOT EXISTS undone_at timestamptz;

COMMENT ON COLUMN public.sie_imports.undone_at IS
  'When the durable job reached job_state ''undone'' (the undo of an import, or the end of a reviewed duplicate repair). Stamped by the stamp_sie_undone_at trigger only. NULL on a job that is not undone and on one undone before 20261109153200.';

CREATE OR REPLACE FUNCTION public.stamp_sie_undone_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.job_state = 'undone' AND OLD.job_state IS DISTINCT FROM 'undone' THEN
    NEW.undone_at := clock_timestamp();
  ELSIF current_user IN ('anon', 'authenticated', 'service_role') THEN
    NEW.undone_at := CASE WHEN TG_OP = 'UPDATE' THEN OLD.undone_at END;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_sie_undone_at() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER stamp_sie_undone_at
  BEFORE INSERT OR UPDATE ON public.sie_imports
  FOR EACH ROW EXECUTE FUNCTION public.stamp_sie_undone_at();

CREATE OR REPLACE FUNCTION public.fiscal_year_reset_snapshot(p_company_id uuid, p_period_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_period        record;
  v_next          record;
  v_blockers      jsonb := '[]'::jsonb;
  v_lock_through  date;
  v_arsred        integer;
  v_vat           integer;
  v_agi           integer;
  v_vouchers      integer;
  v_docs          integer;
  v_start_ym      text;
  v_end_ym        text;
  v_xref          integer;
  v_rotrut        integer;
BEGIN
  SELECT id, name, period_start, period_end, is_closed, locked_at,
         closing_entry_id, opening_balance_entry_id
    INTO v_period
    FROM public.fiscal_periods
   WHERE id = p_period_id
     AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FISCAL_YEAR_RESET_NOT_FOUND');
  END IF;

  IF EXISTS (SELECT 1 FROM public.fiscal_periods WHERE id=p_period_id AND company_id=p_company_id AND import_hold IS NOT NULL)
    OR EXISTS (SELECT 1 FROM public.sie_imports WHERE company_id=p_company_id AND fiscal_period_id=p_period_id
      AND job_state NOT IN ('completed','undone','failed')) THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code','unfinished_import'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.journal_entries WHERE company_id=p_company_id AND fiscal_period_id=p_period_id
      AND import_batch_id IS NOT NULL) OR EXISTS (
      SELECT 1 FROM public.sie_duplicate_repair_items r JOIN public.sie_imports j ON j.id=r.import_id
      WHERE j.company_id=p_company_id AND j.fiscal_period_id=p_period_id) THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code','retained_import_history'));
  ELSIF EXISTS (SELECT 1 FROM public.sie_imports WHERE company_id=p_company_id AND fiscal_period_id=p_period_id
      AND job_kind='import' AND job_state='completed') THEN
    -- A durable import that still stands is taken out by its own undo, the
    -- storno track, before the year is reset (20261109153200).
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code','sie_import_in_place'));
  END IF;

  IF v_period.is_closed THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'period_closed'));
  END IF;
  IF v_period.locked_at IS NOT NULL THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'period_locked'));
  END IF;

  SELECT bookkeeping_locked_through
    INTO v_lock_through
    FROM public.company_settings
   WHERE company_id = p_company_id;
  IF v_lock_through IS NOT NULL AND v_lock_through >= v_period.period_start THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'company_lock_date', 'date', to_char(v_lock_through, 'YYYY-MM-DD')
    ));
  END IF;

  IF v_period.closing_entry_id IS NOT NULL THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'year_end_state'));
  END IF;

  SELECT (SELECT count(*) FROM public.arsredovisning_submissions
           WHERE company_id = p_company_id AND fiscal_period_id = p_period_id)
       + (SELECT count(*) FROM public.arsredovisning_signature_requests
           WHERE company_id = p_company_id AND fiscal_period_id = p_period_id)
    INTO v_arsred;
  IF v_arsred > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'arsredovisning_state', 'count', v_arsred
    ));
  END IF;

  -- Later-year dependency: chain lookup first, then date-based fallback
  -- (mirrors findNextPeriod / scripts/undo-year-end-closing.ts). The next
  -- year blocks the reset only when it has been FINALISED on top of this
  -- year: locked, closed, or carrying its own closing entry. An opening
  -- balance verifikat in the next year is not reliance: the dominant
  -- migration shape (import the first year with its own #IB, later backfill
  -- the year before it) always leaves an IB there, and that IB is its own
  -- verifikat with its own underlag, which the reset leaves untouched and
  -- reports back as next_period.has_opening_balances so the UI can say so.
  -- An IB generated by this year's bokslut is still refused, via
  -- closing_entry_id on THIS period (year_end_state above).
  SELECT id, name, is_closed, locked_at, closing_entry_id,
         opening_balance_entry_id
    INTO v_next
    FROM public.fiscal_periods
   WHERE company_id = p_company_id
     AND previous_period_id = p_period_id
   LIMIT 1;
  IF NOT FOUND THEN
    SELECT id, name, is_closed, locked_at, closing_entry_id,
           opening_balance_entry_id
      INTO v_next
      FROM public.fiscal_periods
     WHERE company_id = p_company_id
       AND period_start = v_period.period_end + 1
     LIMIT 1;
  END IF;
  IF v_next.id IS NOT NULL AND (
       v_next.is_closed
       OR v_next.locked_at IS NOT NULL
       OR v_next.closing_entry_id IS NOT NULL
     ) THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'next_year_dependency'));
  END IF;

  -- Cross-year rättelse/storno chains: an entry OUTSIDE the year whose
  -- correction_of_id / reverses_id / reversed_by_id points INTO the year.
  -- Deleting the target fires the FK's ON DELETE SET NULL as an UPDATE on
  -- the referrer; enforce_journal_entry_immutability refuses that on a
  -- posted referrer (the delete escape hatch covers only TG_OP = 'DELETE'),
  -- and on a draft it would silently sever the rättelse chain. Either way
  -- the year has been relied upon: refuse up front, so the preview and the
  -- execution agree (mirrors the delete_last_voucher reference check,
  -- 20260528120600).
  SELECT count(*) INTO v_xref
    FROM public.journal_entries outside
   WHERE outside.company_id = p_company_id
     AND outside.fiscal_period_id <> p_period_id
     AND EXISTS (
       SELECT 1 FROM public.journal_entries inside
        WHERE inside.company_id = p_company_id
          AND inside.fiscal_period_id = p_period_id
          AND inside.id IN (outside.correction_of_id, outside.reverses_id, outside.reversed_by_id)
     );
  IF v_xref > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'cross_year_reference', 'count', v_xref
    ));
  END IF;

  -- VAT declared evidence. Skatteverket declaration state cannot be observed
  -- reliably from this database (the final signature happens at SKV), so
  -- every local trace counts and unparsable workflow keys fail closed. Same
  -- conservative posture as company_migration_reset (20260818224000).
  v_start_ym := to_char(v_period.period_start, 'YYYYMM');
  v_end_ym   := to_char(v_period.period_end,   'YYYYMM');
  SELECT (SELECT count(*) FROM public.journal_entries
           WHERE company_id = p_company_id
             AND fiscal_period_id = p_period_id
             AND source_type = 'vat_settlement'
             AND status IN ('posted', 'reversed'))
       + (SELECT count(*) FROM public.skatteverket_api_audit_log
           WHERE company_id = p_company_id
             AND outcome = 'ok'
             AND endpoint IN ('declaration/lock', 'declaration/submit')
             AND (redovisningsperiod IS NULL
                  OR (redovisningsperiod >= v_start_ym AND redovisningsperiod <= v_end_ym)))
       + (SELECT count(*) FROM public.extension_data
           WHERE company_id = p_company_id
             AND extension_id = 'skatteverket'
             AND key LIKE 'submission\_%' ESCAPE '\'
             AND (substring(key FROM 12) !~ '^[0-9]{6}$'
                  OR (substring(key FROM 12) >= v_start_ym AND substring(key FROM 12) <= v_end_ym)))
    INTO v_vat;
  IF v_vat > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'vat_declared', 'count', v_vat
    ));
  END IF;

  -- AGI declared evidence for months inside the year.
  SELECT count(*) INTO v_agi
    FROM public.agi_declarations
   WHERE company_id = p_company_id
     AND (submitted_at IS NOT NULL OR status IN ('submitted', 'accepted', 'rejected'))
     AND make_date(period_year, period_month, 1)
         BETWEEN date_trunc('month', v_period.period_start)::date AND v_period.period_end;
  IF v_agi > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'agi_declared', 'count', v_agi
    ));
  END IF;

  -- ROT/RUT reliance: a begäran om utbetalning that has reached Skatteverket
  -- (submitted, or decided: paid/partially_paid/rejected) is external
  -- reliance in the same category as VAT/AGI. Its links into the year are
  -- ON DELETE SET NULL, so without this guard the reset would silently erase
  -- the bokföring behind a filed and possibly decided myndighetsärende.
  -- 'generated' (file never uploaded) and 'cancelled' do not block.
  SELECT count(*) INTO v_rotrut
    FROM public.rot_rut_payout_requests r
   WHERE r.company_id = p_company_id
     AND r.status IN ('submitted', 'paid', 'partially_paid', 'rejected')
     AND (
       EXISTS (
         SELECT 1 FROM public.journal_entries je
          WHERE je.id = r.settlement_journal_entry_id
            AND je.fiscal_period_id = p_period_id
       )
       OR EXISTS (
         SELECT 1
           FROM public.rot_rut_payout_request_items ri
           JOIN public.invoices inv ON inv.id = ri.invoice_id
           JOIN public.journal_entries je ON je.id = inv.journal_entry_id
          WHERE ri.request_id = r.id
            AND je.fiscal_period_id = p_period_id
       )
     );
  IF v_rotrut > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'rot_rut_state', 'count', v_rotrut
    ));
  END IF;

  SELECT count(*) INTO v_vouchers
    FROM public.journal_entries
   WHERE company_id = p_company_id
     AND fiscal_period_id = p_period_id;

  SELECT count(*) INTO v_docs
    FROM public.document_attachments da
   WHERE da.journal_entry_id IN (
           SELECT je.id FROM public.journal_entries je
            WHERE je.company_id = p_company_id AND je.fiscal_period_id = p_period_id)
      OR da.journal_entry_line_id IN (
           SELECT jel.id
             FROM public.journal_entry_lines jel
             JOIN public.journal_entries je ON je.id = jel.journal_entry_id
            WHERE je.company_id = p_company_id AND je.fiscal_period_id = p_period_id);

  RETURN jsonb_build_object(
    'ok', true,
    'eligible', jsonb_array_length(v_blockers) = 0,
    'blockers', v_blockers,
    'period', jsonb_build_object(
      'id', v_period.id,
      'name', v_period.name,
      'period_start', to_char(v_period.period_start, 'YYYY-MM-DD'),
      'period_end', to_char(v_period.period_end, 'YYYY-MM-DD')
    ),
    'counts', jsonb_build_object(
      'vouchers', v_vouchers,
      'documents_to_detach', v_docs
    ),
    'next_period', CASE
      WHEN v_next.id IS NULL THEN NULL
      ELSE jsonb_build_object(
        'id', v_next.id,
        'name', v_next.name,
        'has_opening_balances', v_next.opening_balance_entry_id IS NOT NULL
      )
    END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fiscal_year_reset_snapshot(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fiscal_year_reset_snapshot(uuid, uuid) IS
  'Internal fail-closed eligibility snapshot for reset_fiscal_year. Not client-callable. Refuses a year that holds a completed durable SIE import (sie_import_in_place, 20261109153200).';

NOTIFY pgrst, 'reload schema';
