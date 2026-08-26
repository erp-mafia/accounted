-- Reset an UNLOCKED fiscal year (issue #1883).
--
-- After a bad test import (SIE or otherwise) users saw no way out short of
-- deleting the whole company: undo_sie_import only covers entries a single
-- completed SIE import created, and manual/agent entries booked on top of a
-- bad import were unreachable. This adds a guarded, owner/admin-only reset of
-- one open fiscal year: hard-deletes ALL of the year's verifikationer
-- (every source_type and status), detaches documents (which are never
-- deleted: BFL 7 kap retention), resets voucher_sequences, and marks the
-- year's completed SIE imports as 'undone'.
--
-- Legality framing (BFL 5 kap, BFNAR 2013:2): this is the same category of
-- operation as the shipped undo_sie_import / replace_sie_import: re-doing the
-- löpande bokföring of a year that nothing has relied upon yet. The reset is
-- refused whenever any reliance state exists:
--   * the year is locked or closed (fiscal_periods.locked_at / is_closed)
--   * the company lock date covers any part of the year
--   * a year-end closing entry exists (fiscal_periods.closing_entry_id)
--   * an arsredovisning submission or signature request exists for the year
--   * a later year depends on this year's UB (next period has opening
--     balances, or is itself locked/closed/has a closing entry)
--   * VAT declared evidence: a posted/reversed vat_settlement verifikat in
--     the year, a successful Skatteverket declaration lock/submit for a
--     redovisningsperiod inside the year, or a Skatteverket-extension VAT
--     submission workflow key for the year (fail-closed on unparsable keys)
--   * AGI declared evidence: an agi_declarations row for a month inside the
--     year in a submitted/accepted/rejected state
--   * ROT/RUT reliance: a begäran om utbetalning that reached Skatteverket
--     (submitted/paid/partially_paid/rejected) whose settlement voucher or
--     source invoices are booked in the year
--   * cross-year rättelse/storno chains: an entry OUTSIDE the year whose
--     correction_of_id / reverses_id / reversed_by_id points INTO the year
--     (the delete's ON DELETE SET NULL referential action would either be
--     refused by the immutability trigger on a posted referrer, or silently
--     sever a draft's chain; both mean the year has been relied upon)
-- Entries referenced by other records (assets, accrual schedules, salary
-- runs: RESTRICT / NO ACTION FKs) make the whole reset roll back with a
-- distinct error instead of half-deleting. SET NULL references (invoices,
-- invoice payments, supplier invoices, bank/skattekonto transactions,
-- mileage trips) unlink and return to unbooked, which is the meaning of
-- resetting the year; the UI copy discloses this. Behandlingshistorik is
-- preserved: every deleted entry fires write_audit_log, and before the
-- delete a company-scoped RESET_SNAPSHOT audit row archives the FULL
-- content of every verifikat (accounts, amounts, line text, dimensions) so
-- the destroyed räkenskapsinformation stays retrievable (BFL 7 kap), plus
-- one summary audit_log row.
--
-- Deletion mechanism: the SAME escape hatch as undo_sie_import
-- (20260727121000): set_config('gnubok.allow_delete','true',true) inside a
-- SECURITY DEFINER RPC. No enforcement trigger is modified.
--
-- Actor gate mirrors undo_sie_import (20260727121000): p_user_id is honored
-- only for service_role callers (the cookieless server client, auth.uid()
-- NULL); every other caller is pinned to its own auth.uid().

-- ---------------------------------------------------------------------------
-- audit_log gains a RESET_SNAPSHOT action: the pre-delete verifikat content
-- archive written by reset_fiscal_year below. NOT VALID skips the full-table
-- validation scan: every existing row satisfies the previous, strictly
-- narrower constraint, and NOT VALID still enforces all new rows.
-- ---------------------------------------------------------------------------
ALTER TABLE public.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action = ANY (ARRAY[
    'INSERT','UPDATE','DELETE','COMMIT','REVERSE','CORRECT',
    'LOCK_PERIOD','CLOSE_PERIOD','DOCUMENT_DELETE_BLOCKED',
    'RETENTION_BLOCK','SECURITY_EVENT','INTEGRITY_FAILURE',
    'COMMITTED_AT_OVERRIDE','RESET_SNAPSHOT'
  ])) NOT VALID;

-- ---------------------------------------------------------------------------
-- Internal snapshot: eligibility + counts. Not callable by clients (REVOKEd);
-- both public functions below call it so the preview and the execution can
-- never drift apart.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fiscal_year_reset_snapshot(
  p_company_id uuid,
  p_period_id  uuid
)
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
  -- (mirrors findNextPeriod / scripts/undo-year-end-closing.ts). A next year
  -- whose IB was generated from this year's UB, or that is itself locked,
  -- closed or has a closing entry, blocks the reset.
  SELECT id, is_closed, locked_at, closing_entry_id,
         opening_balance_entry_id, opening_balances_set
    INTO v_next
    FROM public.fiscal_periods
   WHERE company_id = p_company_id
     AND previous_period_id = p_period_id
   LIMIT 1;
  IF NOT FOUND THEN
    SELECT id, is_closed, locked_at, closing_entry_id,
           opening_balance_entry_id, opening_balances_set
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
       OR v_next.opening_balance_entry_id IS NOT NULL
       OR v_next.opening_balances_set
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
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fiscal_year_reset_snapshot(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fiscal_year_reset_snapshot(uuid, uuid) IS
  'Internal fail-closed eligibility snapshot for reset_fiscal_year. Not client-callable.';

-- ---------------------------------------------------------------------------
-- Eligibility preview for the UI. Owner/admin only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_fiscal_year_reset_eligibility(
  p_company_id uuid,
  p_period_id  uuid,
  p_user_id    uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor       uuid;
  v_caller_role text;
BEGIN
  -- Actor resolution: p_user_id is honored only for service_role callers
  -- (auth.uid() NULL on the cookieless server client); everyone else is
  -- pinned to their own auth.uid(). Same shape as undo_sie_import
  -- (20260727121000).
  IF auth.role() = 'service_role' THEN
    v_actor := COALESCE(p_user_id, auth.uid());
  ELSE
    v_actor := auth.uid();
  END IF;

  SELECT cm.role INTO v_caller_role
    FROM company_members cm
   WHERE cm.company_id = p_company_id
     AND cm.user_id = v_actor;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FISCAL_YEAR_RESET_FORBIDDEN');
  END IF;

  RETURN public.fiscal_year_reset_snapshot(p_company_id, p_period_id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_fiscal_year_reset_eligibility(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_fiscal_year_reset_eligibility(uuid, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_fiscal_year_reset_eligibility(uuid, uuid, uuid) IS
  'Owner/admin-only eligibility preview for reset_fiscal_year. p_user_id is honored only for service_role callers.';

-- ---------------------------------------------------------------------------
-- The reset itself.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_fiscal_year(
  p_company_id     uuid,
  p_period_id      uuid,
  p_confirmed_name text,
  p_user_id        uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 -- The authenticated role carries statement_timeout=8s on hosted Supabase; a
 -- year-sized batch delete (each row firing write_audit_log with a JSONB
 -- snapshot, plus cascading lines) must not race that budget. Same shape as
 -- undo_sie_import (20260629160100 / 20260727121000).
 SET statement_timeout TO '290s'
AS $function$
DECLARE
  v_actor         uuid;
  v_caller_role   text;
  v_snapshot      jsonb;
  v_period_name   text;
  v_period_start  date;
  v_period_end    date;
  v_deleted       integer := 0;
  v_docs_detached integer := 0;
  v_flipped       uuid[] := '{}';
BEGIN
  IF auth.role() = 'service_role' THEN
    v_actor := COALESCE(p_user_id, auth.uid());
  ELSE
    v_actor := auth.uid();
  END IF;

  SELECT cm.role INTO v_caller_role
    FROM company_members cm
   WHERE cm.company_id = p_company_id
     AND cm.user_id = v_actor;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FISCAL_YEAR_RESET_FORBIDDEN');
  END IF;

  -- Serialize concurrent resets / lock-state changes on the same year.
  SELECT name, period_start, period_end
    INTO v_period_name, v_period_start, v_period_end
    FROM public.fiscal_periods
   WHERE id = p_period_id
     AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FISCAL_YEAR_RESET_NOT_FOUND');
  END IF;

  v_snapshot := public.fiscal_year_reset_snapshot(p_company_id, p_period_id);
  IF NOT (v_snapshot ->> 'ok')::boolean THEN
    RETURN v_snapshot;
  END IF;
  IF NOT (v_snapshot ->> 'eligible')::boolean THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FISCAL_YEAR_RESET_INELIGIBLE',
      'blockers', v_snapshot -> 'blockers'
    );
  END IF;

  -- Typed confirmation: the caller must restate the year's label exactly.
  IF p_confirmed_name IS NULL OR btrim(p_confirmed_name) <> btrim(v_period_name) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FISCAL_YEAR_RESET_CONFIRMATION_MISMATCH');
  END IF;

  BEGIN
    -- The sanctioned escape hatch (same as undo_sie_import): disarms the
    -- immutability/retention DELETE guards for this transaction only. The
    -- enforcement triggers themselves are untouched.
    PERFORM set_config('gnubok.allow_delete', 'true', true);

    -- Detach documents (entry- and line-level). Documents are NEVER deleted:
    -- BFL 7 kap retention. They stay in the archive as unlinked underlag.
    UPDATE public.document_attachments da
       SET journal_entry_id      = NULL,
           journal_entry_line_id = NULL
     WHERE da.journal_entry_id IN (
             SELECT je.id FROM public.journal_entries je
              WHERE je.company_id = p_company_id AND je.fiscal_period_id = p_period_id)
        OR da.journal_entry_line_id IN (
             SELECT jel.id
               FROM public.journal_entry_lines jel
               JOIN public.journal_entries je ON je.id = jel.journal_entry_id
              WHERE je.company_id = p_company_id AND je.fiscal_period_id = p_period_id);
    GET DIAGNOSTICS v_docs_detached = ROW_COUNT;

    -- Clear the fiscal-period OB pointer (two-step around
    -- enforce_opening_balance_immutability, same as undo_sie_import).
    UPDATE public.fiscal_periods
       SET opening_balances_set = false
     WHERE id = p_period_id
       AND opening_balance_entry_id IS NOT NULL;
    UPDATE public.fiscal_periods
       SET opening_balance_entry_id = NULL
     WHERE id = p_period_id
       AND opening_balance_entry_id IS NOT NULL;

    -- Drop sie_imports -> opening_balance_entry FKs before the delete.
    UPDATE public.sie_imports
       SET opening_balance_entry_id = NULL
     WHERE company_id = p_company_id
       AND fiscal_period_id = p_period_id
       AND opening_balance_entry_id IS NOT NULL;

    -- Räkenskapsinformation preservation (BFL 7 kap, BFNAR 2013:2 kap 8):
    -- the trigger's per-entry DELETE audit row keeps only the voucher
    -- header, and line-level trigger rows carry no company_id (invisible to
    -- every company-scoped surface). Archive the FULL content of every
    -- verifikat (accounts, amounts, line text, dimensions) in company-scoped
    -- RESET_SNAPSHOT rows BEFORE deleting, so what is destroyed stays
    -- retrievable for the retention period.
    INSERT INTO public.audit_log (
      user_id, company_id, action, table_name, record_id, actor_id,
      old_state, description
    )
    SELECT v_actor, p_company_id, 'RESET_SNAPSHOT', 'journal_entries', je.id, v_actor,
           to_jsonb(je) || jsonb_build_object('lines', COALESCE(l.lines, '[]'::jsonb)),
           'Fiscal year reset: full verifikat content archived before deletion (BFL 7 kap)'
      FROM public.journal_entries je
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
                 'account_number',   jel.account_number,
                 'debit_amount',     jel.debit_amount,
                 'credit_amount',    jel.credit_amount,
                 'line_description', jel.line_description,
                 'dimensions',       jel.dimensions
               ) ORDER BY jel.sort_order) AS lines
          FROM public.journal_entry_lines jel
         WHERE jel.journal_entry_id = je.id
      ) l ON true
     WHERE je.company_id = p_company_id
       AND je.fiscal_period_id = p_period_id;

    -- Hard-delete the year's journal entries: every source_type and status.
    -- SET NULL FKs (transactions, invoice payments) unlink, which is the
    -- meaning of resetting the year; RESTRICT / NO ACTION FKs (assets,
    -- accrual schedules, salary runs) abort the whole reset below.
    WITH deleted AS (
      DELETE FROM public.journal_entries
       WHERE company_id = p_company_id
         AND fiscal_period_id = p_period_id
      RETURNING id
    )
    SELECT count(*) INTO v_deleted FROM deleted;

    -- The year's completed SIE imports no longer have any vouchers: mark
    -- them undone so the import history reflects reality and the partial
    -- unique slot (sie_imports_company_id_file_hash_active_idx) frees for a
    -- clean re-import.
    WITH flipped AS (
      UPDATE public.sie_imports
         SET status = 'undone', replaced_at = now()
       WHERE company_id = p_company_id
         AND fiscal_period_id = p_period_id
         AND status = 'completed'
      RETURNING id
    )
    SELECT COALESCE(array_agg(id), '{}') INTO v_flipped FROM flipped;

    -- Registry lockstep (mirrors undo_sie_import, 20260702154500): dimension
    -- values and custom dimensions the flipped imports introduced would
    -- otherwise be orphaned forever: undo_sie_import requires
    -- status = 'completed' and can never run for an import this reset just
    -- marked undone. Remove the ones no surviving posted/reversed line still
    -- references; user-created rows (created_by_import_id NULL) are never
    -- touched.
    DELETE FROM public.dimension_values dv
     USING public.dimensions d
     WHERE dv.created_by_import_id = ANY (v_flipped)
       AND dv.company_id           = p_company_id
       AND d.id                    = dv.dimension_id
       AND NOT EXISTS (
         SELECT 1
           FROM public.journal_entries je
           JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
          WHERE je.company_id = p_company_id
            AND je.status IN ('posted', 'reversed')
            AND jel.dimensions ->> d.sie_dim_no::text = dv.code
       );

    DELETE FROM public.dimensions d
     WHERE d.created_by_import_id = ANY (v_flipped)
       AND d.company_id           = p_company_id
       AND d.is_system            = false
       AND NOT EXISTS (
         SELECT 1 FROM public.dimension_values dv WHERE dv.dimension_id = d.id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.journal_entries je
           JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
          WHERE je.company_id = p_company_id
            AND je.status IN ('posted', 'reversed')
            AND jel.dimensions ? d.sie_dim_no::text
       );

    -- Gap explanations describe a numbering that no longer exists.
    DELETE FROM public.voucher_gap_explanations
     WHERE company_id = p_company_id
       AND fiscal_period_id = p_period_id;

    -- Reset voucher_sequences per series to the max remaining number (0
    -- after a full delete; same query as undo_sie_import for consistency).
    UPDATE public.voucher_sequences vs
       SET last_number = COALESCE((
             SELECT MAX(je.voucher_number)
               FROM public.journal_entries je
              WHERE je.company_id       = vs.company_id
                AND je.fiscal_period_id = vs.fiscal_period_id
                AND je.voucher_series   = vs.voucher_series
                AND je.voucher_number  > 0
           ), 0),
           updated_at = now()
     WHERE vs.company_id       = p_company_id
       AND vs.fiscal_period_id = p_period_id;

    -- The year's IB continuity claim no longer describes anything.
    UPDATE public.fiscal_periods
       SET continuity_verified = NULL,
           opening_balances_set = false
     WHERE id = p_period_id
       AND company_id = p_company_id;

    -- Disarm the escape hatch before leaving the block (mirrors
    -- cleanup_sandbox_user, 20260807130000): nothing later in the same
    -- transaction may run with the delete guard down.
    PERFORM set_config('gnubok.allow_delete', '', true);

  EXCEPTION
    WHEN foreign_key_violation THEN
      -- An entry in the year is referenced by another record (asset,
      -- periodisering, salary run, ...). Half-deleting is worse than
      -- refusing: the exception rolls back every change made in this block.
      RETURN jsonb_build_object('ok', false, 'code', 'FISCAL_YEAR_RESET_LINKED_ENTRIES');
    WHEN raise_exception THEN
      -- A protection trigger refused part of the reset (defense in depth
      -- behind the snapshot guards, e.g. an immutability RAISE on a
      -- referential-action UPDATE). The exception rolls back every change
      -- made in this block; surface a typed refusal instead of a bare 500.
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'FISCAL_YEAR_RESET_LINKED_ENTRIES',
        'detail', SQLERRM
      );
  END;

  -- Behandlingshistorik (BFNAR 2013:2 kap 8): each deleted entry already
  -- fired write_audit_log; this summary row records the reset as one control
  -- action with who/when/what.
  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    old_state, new_state, description
  ) VALUES (
    v_actor, p_company_id, 'DELETE', 'journal_entries', p_period_id, v_actor,
    jsonb_build_object(
      'fiscal_period_id', p_period_id,
      'period_name', v_period_name,
      'period_start', v_period_start,
      'period_end', v_period_end
    ),
    jsonb_build_object(
      'deleted_entries', v_deleted,
      'detached_documents', v_docs_detached
    ),
    'Fiscal year reset: all verifikationer in the open year hard-deleted on user request; documents detached, never deleted (BFL 7 kap)'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'deleted', v_deleted,
    'detached_documents', v_docs_detached,
    'period_name', v_period_name
  );
END;
$function$;

-- Least privilege, same discipline as undo_sie_import (20260727121000).
REVOKE EXECUTE ON FUNCTION public.reset_fiscal_year(uuid, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reset_fiscal_year(uuid, uuid, text, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.reset_fiscal_year(uuid, uuid, text, uuid) IS
  'Hard-deletes ALL verifikationer in one OPEN, un-relied-upon fiscal year (any source_type/status), detaches documents (never deletes them), resets voucher_sequences and marks the year''s completed SIE imports undone. Refuses on lock/close/lock-date/year-end/arsredovisning/VAT/AGI/ROT-RUT/next-year-dependency/cross-year-reference state and on entries referenced by other records. Archives every verifikat''s full content in RESET_SNAPSHOT audit rows before deleting (BFL 7 kap). Requires owner/admin; p_user_id honored only for service_role callers. Typed confirmation: p_confirmed_name must equal the period name.';

NOTIFY pgrst, 'reload schema';
