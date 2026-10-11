-- Undoing a SIE year flagged the next year for opening balance review only
-- when that year had its own IB verifikat (20260911165003). A year imported
-- after it (a continuation import) or booked natively has none: its IB is
-- derived from the prior year's lines (prior_opening_balance_lines), so the
-- undo took its basis away with no review and no notice (crm#1099).
-- The undo now flags the adjacent next year either way. Completion keeps
-- flagging only an explicit IB: a derived IB follows the newly imported year
-- by design, which is what the import is for.
-- No journal entry or line is changed by this migration.
CREATE OR REPLACE FUNCTION public.flag_sie_next_period_review() RETURNS trigger
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
      AND (next_period.opening_balance_entry_id IS NOT NULL OR NEW.job_state='undone')
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
  v_message:=CASE WHEN v_next.opening_balance_entry_id IS NULL THEN
      format('Ingående balanser för %s räknades fram från föregående räkenskapsår, som nu har ångrats. Lägg in ingående balanser för året eller läs in föregående år igen.',v_next.name)
    ELSE
      format('Granska ingående balanser för %s efter ändringen i föregående räkenskapsår. Ingående balanser har inte ändrats automatiskt.',v_next.name)
    END;
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
