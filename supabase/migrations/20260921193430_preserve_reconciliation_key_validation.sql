CREATE OR REPLACE FUNCTION public.guard_bank_reconciliation_reference()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE v_company uuid; v_cash uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id
    AND NEW.account_key IS NOT DISTINCT FROM OLD.account_key THEN RETURN NEW; END IF;
  IF NEW.account_key NOT LIKE 'bank:%'
    AND (TG_OP = 'INSERT' OR OLD.account_key NOT LIKE 'bank:%') THEN RETURN NEW; END IF;

  -- Leave malformed keys to the existing table CHECK, preserving its error
  -- contract instead of attempting a UUID cast before validation.
  IF NEW.account_key LIKE 'bank:%' AND NEW.account_key !~
    '^bank:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NEW; END IF;
  FOR v_company IN SELECT DISTINCT id FROM unnest(ARRAY[
    CASE WHEN NEW.account_key LIKE 'bank:%' THEN NEW.company_id END,
    CASE WHEN TG_OP = 'UPDATE' AND OLD.account_key LIKE 'bank:%' THEN OLD.company_id END
  ]) id WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM public.lock_cash_account_company(v_company, false);
  END LOOP;
  IF NEW.account_key LIKE 'bank:%' THEN
    v_cash := substring(NEW.account_key FROM 6)::uuid;
    BEGIN
      PERFORM 1 FROM public.cash_accounts WHERE company_id = NEW.company_id AND id = v_cash FOR UPDATE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'CASH_ACCOUNT_REFERENCE_BUSY' USING ERRCODE = 'PT409';
    END;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CASH_ACCOUNT_REFERENCE_CHANGED' USING ERRCODE = 'PT409';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
NOTIFY pgrst, 'reload schema';
