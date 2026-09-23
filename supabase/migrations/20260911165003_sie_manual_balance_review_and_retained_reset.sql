-- Founder choice: retain durable-import history and review adjacent-year IB manually.
-- No journal entry or line is changed by this migration.
ALTER TABLE public.fiscal_periods
  ADD COLUMN opening_balance_review_import_id uuid,
  ADD COLUMN opening_balance_review_token uuid,
  ADD COLUMN opening_balance_review_entry_id uuid REFERENCES public.journal_entries(id),
  ADD COLUMN opening_balance_review_reason text CHECK (opening_balance_review_reason IN ('import','undo')),
  ADD CONSTRAINT fiscal_period_ob_review_company_fk FOREIGN KEY (opening_balance_review_import_id,company_id)
    REFERENCES public.sie_imports(id,company_id),
  ADD CONSTRAINT fiscal_period_ob_review_complete CHECK (
    (opening_balance_review_import_id IS NULL AND opening_balance_review_token IS NULL AND opening_balance_review_reason IS NULL AND opening_balance_review_entry_id IS NULL)
    OR (opening_balance_review_import_id IS NOT NULL AND opening_balance_review_token IS NOT NULL AND opening_balance_review_reason IS NOT NULL));

CREATE FUNCTION public.guard_sie_opening_balance_review() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF current_user IN ('anon','authenticated','service_role') AND
      (NEW.opening_balance_review_import_id IS NOT NULL OR NEW.opening_balance_review_token IS NOT NULL OR
       NEW.opening_balance_review_entry_id IS NOT NULL OR NEW.opening_balance_review_reason IS NOT NULL) THEN
      RAISE EXCEPTION 'Opening balance review requires an authorized RPC' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF current_user IN ('anon','authenticated','service_role') AND (
    NEW.opening_balance_review_import_id IS DISTINCT FROM OLD.opening_balance_review_import_id OR
    NEW.opening_balance_review_token IS DISTINCT FROM OLD.opening_balance_review_token OR
    NEW.opening_balance_review_entry_id IS DISTINCT FROM OLD.opening_balance_review_entry_id OR
    NEW.opening_balance_review_reason IS DISTINCT FROM OLD.opening_balance_review_reason) THEN
    RAISE EXCEPTION 'Opening balance review requires an authorized RPC' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_sie_opening_balance_review() FROM PUBLIC;
CREATE TRIGGER guard_sie_opening_balance_review BEFORE INSERT OR UPDATE ON public.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.guard_sie_opening_balance_review();

CREATE FUNCTION public.flag_sie_next_period_review() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE v_next public.fiscal_periods; v_review jsonb; v_token uuid; v_message text;
BEGIN
  IF NEW.job_kind<>'import' OR NEW.job_state IS NOT DISTINCT FROM OLD.job_state
    OR NEW.job_state NOT IN ('completed','undone') THEN RETURN NEW; END IF;
  -- A preparation-only cancellation has no balances to review.
  IF NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE import_batch_id=NEW.id) THEN RETURN NEW; END IF;
  SELECT next_period.* INTO v_next FROM public.fiscal_periods next_period
    JOIN public.fiscal_periods source_period ON source_period.id=NEW.fiscal_period_id
      AND source_period.company_id=NEW.company_id
    WHERE next_period.company_id=NEW.company_id AND next_period.period_start=source_period.period_end+1
      AND next_period.opening_balance_entry_id IS NOT NULL
    FOR UPDATE OF next_period NOWAIT;
  IF NOT FOUND THEN RETURN NEW; END IF;
  v_token:=gen_random_uuid();
  v_review:=jsonb_build_object('nextPeriodId',v_next.id,'nextPeriodName',v_next.name,
    'openingBalanceEntryId',v_next.opening_balance_entry_id,'importId',NEW.id,'reviewToken',v_token,
    'reason',CASE WHEN NEW.job_state='undone' THEN 'undo' ELSE 'import' END);
  UPDATE public.fiscal_periods SET opening_balance_review_import_id=NEW.id,opening_balance_review_token=v_token,
    opening_balance_review_entry_id=v_next.opening_balance_entry_id,
    opening_balance_review_reason=CASE WHEN NEW.job_state='undone' THEN 'undo' ELSE 'import' END
    WHERE id=v_next.id;
  -- The result is the shared web/REST/MCP receipt. The original manifest stays
  -- sealed on undo; the renewed token prevents an old acknowledgment clearing it.
  v_message:=format('Granska ingående balanser för %s efter ändringen i föregående räkenskapsår. Ingående balanser har inte ändrats automatiskt.',v_next.name);
  NEW.job_result:=coalesce(NEW.job_result,'{}'::jsonb)||jsonb_build_object('nextPeriodOpeningBalanceReview',v_review,
    'warnings',coalesce(NEW.job_result->'warnings','[]'::jsonb)||jsonb_build_array(v_message));
  IF NEW.job_state='completed' THEN
    NEW.manifest:=NEW.manifest||jsonb_build_object('nextPeriodOpeningBalanceReview',v_review);
  END IF;
  INSERT INTO public.audit_log(user_id,company_id,actor_id,actor_type,action,table_name,record_id,new_state,description)
    VALUES(NEW.user_id,NEW.company_id,coalesce(NEW.execution_actor_id,NEW.user_id),'user','UPDATE','fiscal_periods',v_next.id,
      v_review,'SIE: adjacent-year opening balance requires manual review');
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.flag_sie_next_period_review() FROM PUBLIC;
CREATE TRIGGER zz_sie_next_period_review BEFORE UPDATE OF job_state ON public.sie_imports
  FOR EACH ROW EXECUTE FUNCTION public.flag_sie_next_period_review();

CREATE FUNCTION public.acknowledge_sie_opening_balance_review(p_company_id uuid,p_period_id uuid,
  p_actor uuid,p_review_token uuid,p_expected_entry_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_period public.fiscal_periods;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id,p_actor);
  IF NOT EXISTS(SELECT 1 FROM public.company_members WHERE company_id=p_company_id AND user_id=p_actor AND role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'Opening balance review requires owner or administrator' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:'||p_company_id::text,0));
  SELECT * INTO v_period FROM public.fiscal_periods WHERE id=p_period_id AND company_id=p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fiscal period not found' USING ERRCODE='P0002'; END IF;
  IF v_period.import_hold IS NOT NULL OR EXISTS(SELECT 1 FROM public.sie_imports WHERE company_id=p_company_id
    AND job_state NOT IN ('completed','undone','failed')) THEN
    RAISE EXCEPTION 'SIE import is unfinished: review after it completes' USING ERRCODE='55000';
  END IF;
  IF p_review_token IS NULL OR v_period.opening_balance_review_token IS DISTINCT FROM p_review_token
    OR v_period.opening_balance_entry_id IS DISTINCT FROM p_expected_entry_id THEN
    RAISE EXCEPTION 'Opening balance review changed; reload before confirming' USING ERRCODE='40001';
  END IF;
  INSERT INTO public.audit_log(user_id,company_id,actor_id,actor_type,action,table_name,record_id,old_state,new_state,description)
    VALUES(p_actor,p_company_id,p_actor,'user','UPDATE','fiscal_periods',p_period_id,
      jsonb_build_object('importId',v_period.opening_balance_review_import_id,'reviewToken',p_review_token,
        'observedEntryId',v_period.opening_balance_review_entry_id,'reason',v_period.opening_balance_review_reason),
      jsonb_build_object('reviewedEntryId',p_expected_entry_id,'reviewedAt',clock_timestamp()),
      'Manual review of adjacent-year opening balance confirmed');
  UPDATE public.fiscal_periods SET opening_balance_review_import_id=NULL,opening_balance_review_token=NULL,
    opening_balance_review_entry_id=NULL,opening_balance_review_reason=NULL WHERE id=p_period_id;
END;
$$;
REVOKE ALL ON FUNCTION public.acknowledge_sie_opening_balance_review(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_sie_opening_balance_review(uuid,uuid,uuid,uuid,uuid) TO authenticated,service_role;

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

-- Preserve the existing integration/filing blockers and extend the single
-- snapshot used by both preview and the locked archive transaction.
ALTER FUNCTION public.company_migration_reset_snapshot(uuid) RENAME TO company_migration_reset_snapshot_before_sie_jobs;
REVOKE ALL ON FUNCTION public.company_migration_reset_snapshot_before_sie_jobs(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.company_migration_reset_snapshot(p_company_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_snapshot jsonb; v_blockers jsonb;
BEGIN
  v_snapshot:=public.company_migration_reset_snapshot_before_sie_jobs(p_company_id);
  IF v_snapshot->>'code'='COMPANY_RESET_NOT_FOUND' THEN RETURN v_snapshot; END IF;
  IF EXISTS(SELECT 1 FROM public.sie_imports WHERE company_id=p_company_id
      AND job_state NOT IN ('completed','undone','failed')) OR EXISTS(
      SELECT 1 FROM public.fiscal_periods WHERE company_id=p_company_id AND import_hold IS NOT NULL) THEN
    SELECT coalesce(jsonb_agg(b),'[]'::jsonb) INTO v_blockers FROM jsonb_array_elements(v_snapshot->'blockers') b
      WHERE b->>'code'<>'imports_in_progress';
    RETURN v_snapshot||jsonb_build_object('eligible',false,'blockers',
      v_blockers||jsonb_build_array(jsonb_build_object('code','imports_in_progress')));
  END IF;
  RETURN v_snapshot;
END;
$$;
REVOKE ALL ON FUNCTION public.company_migration_reset_snapshot(uuid) FROM PUBLIC,anon,authenticated,service_role;
NOTIFY pgrst, 'reload schema';
