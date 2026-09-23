-- pg-test: covered-by tests/pg/file-subledger-import.pg.test.ts
-- Register-only file imports. The receipt is the retry boundary and source
-- provenance. No journal writes, numbering calls, or invoice-issued events.
CREATE TABLE public.subledger_file_imports (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('customer','supplier')),
  snapshot_date date NOT NULL,
  fingerprint text NOT NULL,
  source_rows jsonb NOT NULL,
  invoice_ids uuid[] NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,kind,fingerprint)
);
ALTER TABLE public.subledger_file_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY subledger_file_imports_read ON public.subledger_file_imports
  FOR SELECT TO authenticated USING (company_id IN (SELECT public.user_company_ids()));
REVOKE ALL ON public.subledger_file_imports FROM anon,authenticated;
GRANT SELECT ON public.subledger_file_imports TO authenticated;
GRANT ALL ON public.subledger_file_imports TO service_role;
CREATE TRIGGER subledger_file_imports_updated BEFORE UPDATE ON public.subledger_file_imports
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER subledger_file_imports_audit AFTER INSERT OR UPDATE OR DELETE ON public.subledger_file_imports
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE FUNCTION public.import_file_subledger(
  p_company_id uuid, p_kind text, p_snapshot_date date, p_rows jsonb,
  p_execute boolean DEFAULT false, p_preview_token text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
SET statement_timeout='15s' SET lock_timeout='2s' AS $$
DECLARE
  caller uuid:=auth.uid(); company public.companies; period public.fiscal_periods;
  row_data jsonb; normalized jsonb:='[]'; preview_rows jsonb:='[]'; ids uuid[]:='{}';
  party_ids uuid[]; party uuid; party_name text; vouchers uuid[]; voucher uuid;
  total_value numeric; vat_value numeric; remaining numeric; row_no integer:=1;
  account text; direction integer; ledger numeric:=0; existing numeric:=0; imported numeric:=0;
  v_fingerprint text; token text; receipt jsonb; invoice_id uuid; rate numeric; treatment text;
  table_name text; number_column text;
  opening numeric:=0; activity numeric:=0;
BEGIN
  IF caller IS NULL OR NOT EXISTS(SELECT 1 FROM company_members
    WHERE company_id=p_company_id AND user_id=caller AND role IN ('owner','admin','member')) THEN
    RAISE EXCEPTION 'SUBLEDGER_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  SELECT * INTO company FROM companies WHERE id=p_company_id AND archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'SUBLEDGER_COMPANY_NOT_FOUND'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('customer','supplier') OR p_snapshot_date IS NULL
    OR p_snapshot_date>CURRENT_DATE OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'SUBLEDGER_INPUT_INVALID';
  END IF;
  -- Separate from provider jobs, but serialize with their per-company gate.
  PERFORM pg_advisory_xact_lock(hashtextextended('provider-migration:'||p_company_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:'||p_company_id::text,0));
  PERFORM 1 FROM fiscal_periods WHERE company_id=p_company_id ORDER BY id FOR SHARE;
  IF EXISTS(SELECT 1 FROM fiscal_periods WHERE company_id=p_company_id AND import_hold IS NOT NULL)
    OR EXISTS(SELECT 1 FROM migration_jobs WHERE company_id=p_company_id AND state<>'completed')
    OR EXISTS(SELECT 1 FROM sie_imports WHERE company_id=p_company_id AND status IN ('pending','processing')) THEN
    RAISE EXCEPTION 'SUBLEDGER_IMPORT_BUSY';
  END IF;
  v_fingerprint:=md5(jsonb_build_array(p_snapshot_date,p_rows)::text);
  SELECT s.receipt,s.invoice_ids INTO receipt,ids FROM subledger_file_imports s
    WHERE s.company_id=p_company_id AND s.kind=p_kind AND s.fingerprint=v_fingerprint;
  IF FOUND THEN
    EXECUTE format('SELECT count(*) FROM %I WHERE company_id=$1 AND id=ANY($2)',
      CASE p_kind WHEN 'customer' THEN 'invoices' ELSE 'supplier_invoices' END)
      INTO row_no USING p_company_id,ids;
    IF row_no<>cardinality(ids) THEN RAISE EXCEPTION 'SUBLEDGER_RECEIPT_STALE'; END IF;
    RETURN receipt||jsonb_build_object('already_imported',true);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM company_settings WHERE company_id=p_company_id AND accounting_method='accrual') THEN
    RAISE EXCEPTION 'SUBLEDGER_ACCRUAL_REQUIRED';
  END IF;
  SELECT * INTO period FROM fiscal_periods WHERE company_id=p_company_id
    AND p_snapshot_date BETWEEN period_start AND period_end;
  IF NOT FOUND THEN RAISE EXCEPTION 'SUBLEDGER_PERIOD_NOT_FOUND'; END IF;
  account:=CASE p_kind WHEN 'customer' THEN '1510' ELSE '2440' END;
  direction:=CASE p_kind WHEN 'customer' THEN 1 ELSE -1 END;
  table_name:=CASE p_kind WHEN 'customer' THEN 'invoices' ELSE 'supplier_invoices' END;
  number_column:=CASE p_kind WHEN 'customer' THEN 'invoice_number' ELSE 'supplier_invoice_number' END;

  -- Current outstanding balances cannot safely be compared with a historical
  -- snapshot if there have been subsequent control-account movements.
  IF EXISTS(SELECT 1 FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id=e.id
    WHERE e.company_id=p_company_id AND e.status IN ('posted','reversed')
      AND e.entry_date>p_snapshot_date AND l.account_number=account) THEN
    RAISE EXCEPTION 'SUBLEDGER_SNAPSHOT_OUTDATED';
  END IF;
  -- Match the canonical trial balance: explicit IB, otherwise prior balance
  -- accounts, plus period activity with the IB entry excluded.
  IF period.opening_balance_entry_id IS NOT NULL THEN
    SELECT COALESCE(sum(l.debit_amount-l.credit_amount),0) INTO opening
      FROM journal_entry_lines l JOIN journal_entries e ON e.id=l.journal_entry_id
      WHERE e.id=period.opening_balance_entry_id AND e.company_id=p_company_id AND l.account_number=account;
  ELSE
    SELECT COALESCE(sum(b.debit-b.credit),0) INTO opening
      FROM compute_prior_opening_balances(p_company_id,period.period_start) b WHERE b.account_number=account;
  END IF;
  SELECT COALESCE(sum((a->>'debit')::numeric-(a->>'credit')::numeric),0) INTO activity
    FROM jsonb_array_elements(get_trial_balance_aggregates(p_company_id,period.id,'include',
      NULL,p_snapshot_date,period.opening_balance_entry_id,NULL)) a WHERE a->>'account_number'=account;
  ledger:=round((opening+activity)*direction,2);

  -- Freeze existing balances while evaluating and inserting this batch.
  EXECUTE format('SELECT id FROM %I WHERE company_id=$1 ORDER BY id FOR SHARE',table_name) USING p_company_id;
  EXECUTE format('SELECT COALESCE(sum(remaining_amount),0) FROM %I WHERE company_id=$1
    AND status NOT IN (''draft'',''cancelled'',''credited'',''reversed'')',table_name) INTO existing USING p_company_id;
  IF p_kind='customer' AND EXISTS(SELECT 1 FROM invoices WHERE company_id=p_company_id
    AND remaining_amount<>0 AND status NOT IN ('draft','cancelled','credited')
    AND (currency<>'SEK' OR document_type<>'invoice')) THEN RAISE EXCEPTION 'SUBLEDGER_EXISTING_UNSUPPORTED'; END IF;
  IF p_kind='supplier' AND EXISTS(SELECT 1 FROM supplier_invoices WHERE company_id=p_company_id
    AND remaining_amount<>0 AND status NOT IN ('credited','reversed') AND currency<>'SEK') THEN
    RAISE EXCEPTION 'SUBLEDGER_EXISTING_UNSUPPORTED'; END IF;

  FOR row_data IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    row_no:=row_no+1;
    total_value:=(row_data->>'total')::numeric;
    vat_value:=(row_data->>'vat_amount')::numeric;
    remaining:=(row_data->>'remaining_amount')::numeric;
    treatment:=row_data->>'vat_treatment';
    IF (jsonb_typeof(row_data)='object' AND row_data->>'currency'='SEK'
      AND length(row_data->>'invoice_number') BETWEEN 1 AND 100
      AND length(row_data->>'counterparty') BETWEEN 1 AND 100
      AND length(row_data->>'voucher_series') BETWEEN 1 AND 20
      AND length(COALESCE(row_data->>'payment_reference',''))<=100
      AND (row_data->>'voucher_number')::integer>0
      AND (row_data->>'voucher_year')::integer BETWEEN 1900 AND 9999
      AND (row_data->>'invoice_date')::date<=p_snapshot_date
      AND (row_data->>'due_date')::date IS NOT NULL
      AND total_value>0 AND total_value<=999999999.99 AND total_value=round(total_value,2)
      AND vat_value BETWEEN 0 AND total_value AND vat_value=round(vat_value,2)
      AND remaining>0 AND remaining<=total_value AND remaining=round(remaining,2)
      AND treatment IN ('standard_25','reduced_12','reduced_6','reverse_charge','export','exempt')) IS NOT TRUE THEN
      RAISE EXCEPTION 'SUBLEDGER_ROW_INVALID:%',row_no;
    END IF;
    rate:=CASE treatment WHEN 'standard_25' THEN 25 WHEN 'reduced_12' THEN 12 WHEN 'reduced_6' THEN 6 ELSE 0 END;
    IF abs(round((total_value-vat_value)*rate/100,2)-vat_value)>0.01 THEN
      RAISE EXCEPTION 'SUBLEDGER_ROW_INVALID:%',row_no;
    END IF;
    -- Exact, unambiguous identities only. Names may be used when unique.
    IF p_kind='customer' THEN
      SELECT array_agg(id) INTO party_ids FROM customers WHERE company_id=p_company_id
        AND (id::text=row_data->>'counterparty' OR customer_number=row_data->>'counterparty'
          OR org_number=row_data->>'counterparty' OR name=row_data->>'counterparty');
    ELSE
      SELECT array_agg(id) INTO party_ids FROM suppliers WHERE company_id=p_company_id
        AND (id::text=row_data->>'counterparty' OR org_number=row_data->>'counterparty' OR name=row_data->>'counterparty');
    END IF;
    IF COALESCE(cardinality(party_ids),0)<>1 THEN RAISE EXCEPTION 'SUBLEDGER_PARTY_UNRESOLVED:%',row_no; END IF;
    party:=party_ids[1];
    EXECUTE format('SELECT name FROM %I WHERE id=$1 AND company_id=$2',
      CASE p_kind WHEN 'customer' THEN 'customers' ELSE 'suppliers' END) INTO party_name USING party,p_company_id;
    EXECUTE format('SELECT array_agg(id) FROM %I WHERE company_id=$1 AND %I=$2 %s',table_name,number_column,
      CASE p_kind WHEN 'supplier' THEN 'AND supplier_id=$3' ELSE '' END)
      INTO ids USING p_company_id,row_data->>'invoice_number',party;
    IF cardinality(ids)>0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(normalized) r
      WHERE r->>'invoice_number'=row_data->>'invoice_number'
        AND (p_kind='customer' OR r->>'party_id'=party::text)) THEN
      RAISE EXCEPTION 'SUBLEDGER_DUPLICATE:%',row_no;
    END IF;
    -- Prefer the SIE source identity. Never match the same number across years.
    SELECT array_agg(e.id) INTO vouchers FROM journal_entries e JOIN fiscal_periods f ON f.id=e.fiscal_period_id
      WHERE e.company_id=p_company_id AND f.company_id=p_company_id AND e.status='posted'
        AND extract(year FROM f.period_start)=(row_data->>'voucher_year')::integer
        AND abs(e.entry_date-(row_data->>'invoice_date')::date)<=31
        AND e.entry_date<=p_snapshot_date
        AND COALESCE(e.source_voucher_series,e.voucher_series)=row_data->>'voucher_series'
        AND COALESCE(e.source_voucher_number,e.voucher_number)=(row_data->>'voucher_number')::integer;
    IF COALESCE(cardinality(vouchers),0)<>1 THEN RAISE EXCEPTION 'SUBLEDGER_VOUCHER_UNRESOLVED:%',row_no; END IF;
    voucher:=vouchers[1];
    IF (SELECT COALESCE(sum((debit_amount-credit_amount)*direction),0) FROM journal_entry_lines
        WHERE journal_entry_id=voucher AND account_number=account)<>total_value THEN
      RAISE EXCEPTION 'SUBLEDGER_VOUCHER_AMOUNT:%',row_no;
    END IF;
    IF EXISTS(SELECT 1 FROM invoices WHERE company_id=p_company_id AND journal_entry_id=voucher)
      OR EXISTS(SELECT 1 FROM supplier_invoices WHERE company_id=p_company_id AND registration_journal_entry_id=voucher)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(normalized) r WHERE r->>'voucher_id'=voucher::text) THEN
      RAISE EXCEPTION 'SUBLEDGER_VOUCHER_USED:%',row_no;
    END IF;
    normalized:=normalized||jsonb_build_array(row_data||jsonb_build_object('party_id',party,'voucher_id',voucher));
    preview_rows:=preview_rows||jsonb_build_array(jsonb_build_object('invoice_number',row_data->>'invoice_number',
      'counterparty_name',party_name,'remaining_amount',remaining));
    imported:=imported+remaining;
  END LOOP;
  token:=md5(jsonb_build_array(p_company_id,p_kind,p_snapshot_date,normalized,ledger,existing)::text);
  receipt:=jsonb_build_object('company_id',p_company_id,'company_name',company.name,'org_number',company.org_number,
    'kind',p_kind,'snapshot_date',p_snapshot_date,'token',token,'imported',jsonb_array_length(normalized),
    'already_imported',false,'ledger_balance',ledger,'existing_balance',existing,'imported_balance',imported,
    'difference',round(ledger-existing-imported,2),'rows',preview_rows);
  IF NOT COALESCE(p_execute,false) THEN RETURN receipt; END IF;
  IF p_preview_token IS DISTINCT FROM token THEN RAISE EXCEPTION 'SUBLEDGER_PREVIEW_STALE'; END IF;
  IF round(ledger-existing-imported,2)<>0 THEN RAISE EXCEPTION 'SUBLEDGER_UNRECONCILED'; END IF;
  ids:='{}';
  FOR row_data IN SELECT value FROM jsonb_array_elements(normalized) LOOP
    total_value:=(row_data->>'total')::numeric; vat_value:=(row_data->>'vat_amount')::numeric;
    remaining:=(row_data->>'remaining_amount')::numeric; treatment:=row_data->>'vat_treatment';
    rate:=CASE treatment WHEN 'standard_25' THEN 25 WHEN 'reduced_12' THEN 12 WHEN 'reduced_6' THEN 6 ELSE 0 END;
    IF p_kind='customer' THEN
      INSERT INTO invoices(company_id,user_id,customer_id,invoice_number,invoice_date,due_date,status,currency,
        subtotal,subtotal_sek,vat_amount,vat_amount_sek,total,total_sek,vat_treatment,vat_rate,
        paid_amount,remaining_amount,paid_at,journal_entry_id,document_type)
      VALUES(p_company_id,caller,(row_data->>'party_id')::uuid,row_data->>'invoice_number',
        (row_data->>'invoice_date')::date,(row_data->>'due_date')::date,'sent','SEK',
        total_value-vat_value,total_value-vat_value,vat_value,vat_value,total_value,total_value,treatment,rate,
        total_value-remaining,remaining,NULL,(row_data->>'voucher_id')::uuid,'invoice') RETURNING id INTO invoice_id;
    ELSE
      INSERT INTO supplier_invoices(company_id,user_id,supplier_id,arrival_number,supplier_invoice_number,
        invoice_date,due_date,received_date,status,currency,subtotal,subtotal_sek,vat_amount,vat_amount_sek,
        total,total_sek,vat_treatment,reverse_charge,paid_amount,remaining_amount,paid_at,
        registration_journal_entry_id,payment_reference)
      VALUES(p_company_id,caller,(row_data->>'party_id')::uuid,get_next_arrival_number(p_company_id),
        row_data->>'invoice_number',(row_data->>'invoice_date')::date,(row_data->>'due_date')::date,
        (row_data->>'invoice_date')::date,CASE WHEN remaining<total_value THEN 'partially_paid' ELSE 'registered' END,
        'SEK',total_value-vat_value,total_value-vat_value,vat_value,vat_value,total_value,total_value,treatment,
        treatment='reverse_charge',total_value-remaining,remaining,NULL,(row_data->>'voucher_id')::uuid,
        NULLIF(row_data->>'payment_reference','')) RETURNING id INTO invoice_id;
    END IF;
    ids:=array_append(ids,invoice_id);
  END LOOP;
  INSERT INTO subledger_file_imports(company_id,user_id,kind,snapshot_date,fingerprint,source_rows,invoice_ids,receipt)
    VALUES(p_company_id,caller,p_kind,p_snapshot_date,v_fingerprint,p_rows,ids,receipt);
  RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION public.import_file_subledger(uuid,text,date,jsonb,boolean,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.import_file_subledger(uuid,text,date,jsonb,boolean,text) TO authenticated;
NOTIFY pgrst, 'reload schema';
