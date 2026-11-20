-- Ordinary history writers observe stable company routing together. Repairs
-- and configuration keep their exclusive company lock. A row trigger may
-- already own a business row, so it must refuse an inverted wait immediately.
CREATE FUNCTION public.observe_cash_account_company(p_company_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
BEGIN
  IF (public.jwt_caller_is_end_user()
      OR current_setting('role', true) IN ('authenticated', 'anon')
      OR auth.uid() IS NOT NULL)
     AND NOT public.caller_can_write_company(p_company_id) THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_WRITE_DENIED' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.companies WHERE id = p_company_id FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'CASH_ACCOUNT_OPERATION_BUSY' USING ERRCODE = 'PT409';
END;
$function$;
REVOKE ALL ON FUNCTION public.observe_cash_account_company(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.observe_cash_account_company(uuid) TO authenticated, service_role;

DO $migration$
DECLARE v_signature text; v_definition text; v_old text; v_new text; v_count integer;
BEGIN
  FOR v_signature, v_old, v_new, v_count IN VALUES
    ('public.guard_bank_booking_context()',
      'public.lock_cash_account_company(NEW.company_id)',
      'public.observe_cash_account_company(NEW.company_id)', 2),
    ('public.guard_cash_transaction_binding()',
      'public.lock_cash_account_company(NEW.company_id, false)',
      'public.observe_cash_account_company(NEW.company_id)', 1),
    ('public.guard_cash_transaction_anchor()',
      'public.lock_cash_account_company(NEW.company_id, false)',
      'public.observe_cash_account_company(NEW.company_id)', 1),
    ('public.validate_journal_bank_anchors(uuid,uuid)',
      'public.lock_cash_account_company(p_company_id, false)',
      'public.observe_cash_account_company(p_company_id)', 1)
  LOOP
    v_definition := pg_get_functiondef(v_signature::regprocedure);
    IF (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> v_count THEN
      RAISE EXCEPTION 'Unexpected company observer call in %', v_signature;
    END IF;
    EXECUTE replace(v_definition, v_old, v_new);
  END LOOP;

  -- Shared company locks permit unrelated writers, not concurrent mutation
  -- of the voucher whose settlement lines are being validated. Anchor callers
  -- may own a transaction row, so taking the journal observation cannot wait.
  v_definition := pg_get_functiondef('public.assert_bank_anchor_journal(uuid,uuid,uuid,text,numeric,boolean)'::regprocedure);
  v_old := 'WHERE company_id = p_company_id AND id = p_journal_entry_id;';
  IF strpos(v_definition, v_old) = 0 THEN RAISE EXCEPTION 'Unexpected bank anchor journal lookup'; END IF;
  EXECUTE replace(v_definition, v_old,
    'WHERE company_id = p_company_id AND id = p_journal_entry_id FOR SHARE NOWAIT;');

  -- Posting owns its journal row before entering this trigger. Do not wait on
  -- a source row held by a writer that still needs that journal observation.
  v_definition := pg_get_functiondef('public.guard_bank_booking_context()'::regprocedure);
  IF strpos(v_definition, 'ORDER BY t.id FOR UPDATE;') = 0
     OR strpos(v_definition, '  RETURN NEW;' || E'\nEND;') = 0 THEN
    RAISE EXCEPTION 'Unexpected bank booking context lock definition';
  END IF;
  v_definition := replace(v_definition, 'ORDER BY id FOR SHARE;', 'ORDER BY id FOR SHARE NOWAIT;');
  v_definition := replace(v_definition, 'ORDER BY t.id FOR UPDATE;', 'ORDER BY t.id FOR UPDATE NOWAIT;');
  v_definition := replace(v_definition, '  RETURN NEW;' || E'\nEND;',
    E'  RETURN NEW;\nEXCEPTION WHEN lock_not_available THEN\n  RAISE EXCEPTION ''CASH_ACCOUNT_OPERATION_BUSY'' USING ERRCODE = ''PT409'';\nEND;');
  EXECUTE v_definition;
END;
$migration$;

-- Serialize line edits with posting and bank-anchor validation on this
-- journal only. The protected accounting enforcement functions stay intact.
CREATE OR REPLACE FUNCTION public.lock_cash_history_for_journal_line()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE v_company_id uuid;
BEGIN
  FOR v_company_id IN SELECT DISTINCT j.company_id FROM public.journal_entries j
    WHERE j.id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.journal_entry_id END,
                   CASE WHEN TG_OP <> 'DELETE' THEN NEW.journal_entry_id END)
    ORDER BY j.company_id
  LOOP
    PERFORM public.observe_cash_account_company(v_company_id);
  END LOOP;
  PERFORM 1 FROM public.journal_entries j
    WHERE j.id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.journal_entry_id END,
                   CASE WHEN TG_OP <> 'DELETE' THEN NEW.journal_entry_id END)
    ORDER BY j.id FOR UPDATE NOWAIT;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'CASH_ACCOUNT_OPERATION_BUSY' USING ERRCODE = 'PT409';
END;
$function$;

NOTIFY pgrst, 'reload schema';
