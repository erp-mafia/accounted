-- Stale review acknowledgments are conflicts, not transaction serialization
-- failures. PostgREST must return them instead of automatically retrying.
CREATE OR REPLACE FUNCTION public.acknowledge_sie_opening_balance_review(p_company_id uuid,p_period_id uuid,
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
    RAISE EXCEPTION 'Opening balance review changed; reload before confirming' USING ERRCODE='55000';
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
NOTIFY pgrst, 'reload schema';
