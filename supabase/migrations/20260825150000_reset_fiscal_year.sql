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
-- Entries referenced by other records (assets, accrual schedules, salary
-- runs: RESTRICT / NO ACTION FKs) make the whole reset roll back with a
-- distinct error instead of half-deleting. Behandlingshistorik is preserved:
-- every deleted entry fires write_audit_log, plus one summary audit_log row.
--
-- Deletion mechanism: the SAME escape hatch as undo_sie_import
-- (20260727121000): set_config('gnubok.allow_delete','true',true) inside a
-- SECURITY DEFINER RPC. No enforcement trigger is modified.
--
-- Actor gate mirrors undo_sie_import (20260727121000): p_user_id is honored
-- only for service_role callers (the cookieless server client, auth.uid()
-- NULL); every other caller is pinned to its own auth.uid().

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
    UPDATE public.sie_imports
       SET status = 'undone', replaced_at = now()
     WHERE company_id = p_company_id
       AND fiscal_period_id = p_period_id
       AND status = 'completed';

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

  EXCEPTION WHEN foreign_key_violation THEN
    -- An entry in the year is referenced by another record (asset,
    -- periodisering, salary run, ...). Half-deleting is worse than refusing:
    -- the exception rolls back every change made in this block.
    RETURN jsonb_build_object('ok', false, 'code', 'FISCAL_YEAR_RESET_LINKED_ENTRIES');
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
  'Hard-deletes ALL verifikationer in one OPEN, un-relied-upon fiscal year (any source_type/status), detaches documents (never deletes them), resets voucher_sequences and marks the year''s completed SIE imports undone. Refuses on lock/close/lock-date/year-end/arsredovisning/VAT/AGI/next-year-dependency state and on entries referenced by other records. Requires owner/admin; p_user_id honored only for service_role callers. Typed confirmation: p_confirmed_name must equal the period name.';

NOTIFY pgrst, 'reload schema';
