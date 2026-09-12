-- Exact-ID legacy repairs keep original import provenance unchanged.
-- Enqueue is service-only and records the separately approved preview digest.
ALTER TABLE public.sie_imports ADD COLUMN job_kind text NOT NULL DEFAULT 'import'
  CHECK (job_kind IN ('import','duplicate_repair'));

CREATE TABLE public.sie_duplicate_repair_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  keep_entry_id uuid NOT NULL REFERENCES public.journal_entries(id),
  reverse_entry_id uuid NOT NULL REFERENCES public.journal_entries(id),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  keep_links jsonb NOT NULL DEFAULT '[]',
  reverse_links jsonb NOT NULL DEFAULT '[]',
  reversal_id uuid REFERENCES public.journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (import_id,company_id) REFERENCES public.sie_imports(id,company_id),
  UNIQUE(import_id,ordinal),UNIQUE(reverse_entry_id),
  CHECK (keep_entry_id <> reverse_entry_id)
);
ALTER TABLE public.sie_duplicate_repair_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY sie_repair_items_read ON public.sie_duplicate_repair_items FOR SELECT TO authenticated
  USING(company_id IN (SELECT public.user_company_ids()));
REVOKE ALL ON public.sie_duplicate_repair_items FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.sie_duplicate_repair_items TO authenticated,service_role;
CREATE INDEX sie_repair_keep_idx ON public.sie_duplicate_repair_items(keep_entry_id);
CREATE INDEX sie_repair_company_idx ON public.sie_duplicate_repair_items(company_id);
CREATE TRIGGER sie_repair_items_updated_at BEFORE UPDATE ON public.sie_duplicate_repair_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE FUNCTION public.guard_sie_repair_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR current_user IN ('anon','authenticated','service_role') THEN
    RAISE EXCEPTION 'SIE repair scope is immutable' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-'reversal_id'-'updated_at') IS DISTINCT FROM
      (to_jsonb(OLD)-'reversal_id'-'updated_at') OR OLD.reversal_id IS NOT NULL) THEN
    RAISE EXCEPTION 'SIE repair receipt is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_sie_repair_item() FROM PUBLIC;
CREATE TRIGGER guard_sie_repair_item BEFORE INSERT OR UPDATE OR DELETE ON public.sie_duplicate_repair_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_sie_repair_item();

CREATE FUNCTION public.sie_repair_content_hash(p_entry_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT encode(extensions.digest(jsonb_build_object(
    'date',j.entry_date,'description',j.description,
    'lines',(SELECT jsonb_agg(line ORDER BY line::text) FROM
      (SELECT to_jsonb(l)-'id'-'journal_entry_id'-'created_at'-'sort_order' AS line
       FROM public.journal_entry_lines l WHERE l.journal_entry_id=j.id) x),
    'corrections',(SELECT coalesce(jsonb_agg(to_jsonb(r)-'id'-'journal_entry_id'-'created_at'-'sie_import_id'
      ORDER BY r.created_at),'[]'::jsonb) FROM public.journal_entry_rattelse_log r WHERE r.journal_entry_id=j.id)
  )::text,'sha256'),'hex') FROM public.journal_entries j WHERE j.id=p_entry_id;
$$;
REVOKE ALL ON FUNCTION public.sie_repair_content_hash(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.sie_active_repair_for_entry(p_entry_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT i.import_id FROM public.sie_duplicate_repair_items i JOIN public.sie_imports j ON j.id=i.import_id
    WHERE (i.keep_entry_id=p_entry_id OR i.reverse_entry_id=p_entry_id)
      AND (coalesce(auth.role(),'') <> 'authenticated' OR public.caller_is_company_member(i.company_id))
      AND j.job_state NOT IN ('completed','undone','failed') LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.sie_active_repair_for_entry(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.sie_active_repair_for_entry(uuid) TO authenticated,service_role;

CREATE FUNCTION public.stage_sie_duplicate_repair(p_company_id uuid,p_actor uuid,p_period_id uuid,
  p_review_hash text,p_items jsonb) RETURNS public.sie_imports
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='30s' AS $$
DECLARE v_job public.sie_imports; v_period public.fiscal_periods; v_hash text;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id,p_actor);
  IF p_review_hash IS NULL OR p_review_hash !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p_items) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 5000 OR octet_length(p_items::text)>1000000 THEN
    RAISE EXCEPTION 'Invalid bounded SIE repair review' USING ERRCODE='22023';
  END IF;
  v_hash:=encode(extensions.digest(p_items::text,'sha256'),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:'||p_company_id::text,0));
  SELECT * INTO v_job FROM public.sie_imports WHERE company_id=p_company_id AND fiscal_period_id=p_period_id
    AND job_kind='duplicate_repair' AND file_hash=p_review_hash;
  IF FOUND THEN
    IF v_job.manifest->>'itemsHash' IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'SIE repair retry changed the approved scope' USING ERRCODE='23505';
    END IF;
    RETURN v_job;
  END IF;
  SELECT * INTO v_period FROM public.fiscal_periods WHERE id=p_period_id AND company_id=p_company_id FOR UPDATE;
  IF NOT FOUND OR v_period.is_closed OR v_period.locked_at IS NOT NULL OR v_period.import_hold IS NOT NULL THEN
    RAISE EXCEPTION 'SIE repair needs an open unheld fiscal period' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.sie_imports WHERE company_id=p_company_id
    AND job_state NOT IN ('completed','undone','failed')) THEN
    RAISE EXCEPTION 'Another SIE execution is unfinished' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) r
    LEFT JOIN public.journal_entries k ON k.id=(r->>'keepId')::uuid
    LEFT JOIN public.journal_entries d ON d.id=(r->>'reverseId')::uuid
    WHERE k.id IS NULL OR d.id IS NULL OR k.id=d.id OR k.company_id<>p_company_id OR d.company_id<>p_company_id
      OR k.fiscal_period_id<>p_period_id OR d.fiscal_period_id<>p_period_id
      OR k.source_type<>'import' OR d.source_type<>'import' OR k.status<>'posted' OR d.status<>'posted'
      OR k.import_batch_id IS NOT NULL OR d.import_batch_id IS NOT NULL
      OR k.source_voucher_series IS DISTINCT FROM d.source_voucher_series
      OR k.source_voucher_number IS DISTINCT FROM d.source_voucher_number
      OR k.source_voucher_series IS NULL OR k.source_voucher_number IS NULL
      OR jsonb_typeof(coalesce(r->'keepLinks','[]'::jsonb))<>'array'
      OR jsonb_typeof(coalesce(r->'reverseLinks','[]'::jsonb))<>'array'
      OR r->>'contentHash' IS NULL OR r->>'contentHash' !~ '^[a-f0-9]{64}$') THEN
    RAISE EXCEPTION 'SIE repair requires exact legacy duplicate identities in one company and period' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT id FROM (SELECT r->>'keepId' id FROM jsonb_array_elements(p_items) r UNION ALL
      SELECT r->>'reverseId' FROM jsonb_array_elements(p_items) r) ids GROUP BY id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'SIE repair pairs overlap' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.sie_imports(company_id,user_id,execution_actor_id,filename,file_hash,sie_type,fiscal_period_id,
    fiscal_year_start,fiscal_year_end,status,job_state,job_phase,job_kind,chunks_total,transactions_count,manifest)
    VALUES(p_company_id,p_actor,p_actor,'Granskad rättelse av dubbla SIE-verifikationer',p_review_hash,4,p_period_id,
      v_period.period_start,v_period.period_end,'pending','undoing','undo','duplicate_repair',
      jsonb_array_length(p_items),jsonb_array_length(p_items),jsonb_build_object('reviewHash',p_review_hash,
        'itemsHash',v_hash,'treatment','storno','approvedActor',p_actor)) RETURNING * INTO v_job;
  INSERT INTO public.sie_duplicate_repair_items(import_id,company_id,user_id,ordinal,keep_entry_id,reverse_entry_id,
    content_hash,keep_links,reverse_links)
    SELECT v_job.id,p_company_id,p_actor,(ord-1)::integer,(r->>'keepId')::uuid,(r->>'reverseId')::uuid,
      r->>'contentHash',coalesce(r->'keepLinks','[]'::jsonb),coalesce(r->'reverseLinks','[]'::jsonb)
    FROM jsonb_array_elements(p_items) WITH ORDINALITY x(r,ord);
  UPDATE public.fiscal_periods SET import_hold=v_job.id WHERE id=p_period_id;
  RETURN v_job;
END;
$$;
REVOKE ALL ON FUNCTION public.stage_sie_duplicate_repair(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.stage_sie_duplicate_repair(uuid,uuid,uuid,text,jsonb) TO service_role;

-- Link inventory, atomic reversal, and hold integration follow below.

CREATE FUNCTION public.sie_repair_entry_links(p_entry_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(links) ORDER BY relationship,record_id),'[]'::jsonb) FROM (
SELECT 'accrual_schedule_installments.journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."accrual_schedule_installments" r WHERE r."journal_entry_id"=p_entry_id
UNION ALL
SELECT 'accrual_schedules.origin_journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."accrual_schedules" r WHERE r."origin_journal_entry_id"=p_entry_id
UNION ALL
SELECT 'agi_declarations.tax_payment_journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."agi_declarations" r WHERE r."tax_payment_journal_entry_id"=p_entry_id
UNION ALL
SELECT 'assets.disposal_journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."assets" r WHERE r."disposal_journal_entry_id"=p_entry_id
UNION ALL
SELECT 'depreciation_schedules.journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."depreciation_schedules" r WHERE r."journal_entry_id"=p_entry_id
UNION ALL
SELECT 'document_attachments.journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."document_attachments" r WHERE r."journal_entry_id"=p_entry_id
UNION ALL
SELECT 'document_attachments.journal_entry_line_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."document_attachments" r JOIN public.journal_entry_lines l ON l.id=r."journal_entry_line_id" WHERE l.journal_entry_id=p_entry_id
UNION ALL
SELECT 'expense_claims.journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."expense_claims" r WHERE r."journal_entry_id"=p_entry_id
UNION ALL
SELECT 'expense_payout_batches.journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."expense_payout_batches" r WHERE r."journal_entry_id"=p_entry_id
UNION ALL
SELECT 'fiscal_periods.closing_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."fiscal_periods" r WHERE r."closing_entry_id"=p_entry_id
UNION ALL
SELECT 'fiscal_periods.opening_balance_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."fiscal_periods" r WHERE r."opening_balance_entry_id"=p_entry_id
UNION ALL
SELECT 'invoice_inbox_items.created_journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."invoice_inbox_items" r WHERE r."created_journal_entry_id"=p_entry_id
UNION ALL
SELECT 'invoice_payments.journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."invoice_payments" r WHERE r."journal_entry_id"=p_entry_id
UNION ALL
SELECT 'invoice_reminders.fee_journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."invoice_reminders" r WHERE r."fee_journal_entry_id"=p_entry_id
UNION ALL
SELECT 'invoices.journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."invoices" r WHERE r."journal_entry_id"=p_entry_id
UNION ALL
SELECT 'journal_entries.correction_of_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."journal_entries" r WHERE r."correction_of_id"=p_entry_id
UNION ALL
SELECT 'journal_entries.reversed_by_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."journal_entries" r WHERE r."reversed_by_id"=p_entry_id
UNION ALL
SELECT 'journal_entries.reverses_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."journal_entries" r WHERE r."reverses_id"=p_entry_id
UNION ALL
SELECT 'journal_entry_no_doc_required.journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."journal_entry_no_doc_required" r WHERE r."journal_entry_id"=p_entry_id
UNION ALL
SELECT 'mileage_trips.journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."mileage_trips" r WHERE r."journal_entry_id"=p_entry_id
UNION ALL
SELECT 'rot_rut_payout_requests.reclaim_journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."rot_rut_payout_requests" r WHERE r."reclaim_journal_entry_id"=p_entry_id
UNION ALL
SELECT 'rot_rut_payout_requests.settlement_journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."rot_rut_payout_requests" r WHERE r."settlement_journal_entry_id"=p_entry_id
UNION ALL
SELECT 'salary_runs.avgifter_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."salary_runs" r WHERE r."avgifter_entry_id"=p_entry_id
UNION ALL
SELECT 'salary_runs.pension_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."salary_runs" r WHERE r."pension_entry_id"=p_entry_id
UNION ALL
SELECT 'salary_runs.salary_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."salary_runs" r WHERE r."salary_entry_id"=p_entry_id
UNION ALL
SELECT 'salary_runs.vacation_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."salary_runs" r WHERE r."vacation_entry_id"=p_entry_id
UNION ALL
SELECT 'sie_imports.opening_balance_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."sie_imports" r WHERE r."opening_balance_entry_id"=p_entry_id
UNION ALL
SELECT 'skattekonto_transactions.journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."skattekonto_transactions" r WHERE r."journal_entry_id"=p_entry_id
UNION ALL
SELECT 'skattekonto_transactions.suggested_journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."skattekonto_transactions" r WHERE r."suggested_journal_entry_id"=p_entry_id
UNION ALL
SELECT 'stripe_payment_events.journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."stripe_payment_events" r WHERE r."journal_entry_id"=p_entry_id
UNION ALL
SELECT 'stripe_payouts.journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."stripe_payouts" r WHERE r."journal_entry_id"=p_entry_id
UNION ALL
SELECT 'supplier_invoice_payments.journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."supplier_invoice_payments" r WHERE r."journal_entry_id"=p_entry_id
UNION ALL
SELECT 'supplier_invoices.payment_journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."supplier_invoices" r WHERE r."payment_journal_entry_id"=p_entry_id
UNION ALL
SELECT 'supplier_invoices.registration_journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."supplier_invoices" r WHERE r."registration_journal_entry_id"=p_entry_id
UNION ALL
SELECT 'transaction_voucher_links.journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."transaction_voucher_links" r WHERE r."journal_entry_id"=p_entry_id
UNION ALL
SELECT 'transactions.journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."transactions" r WHERE r."journal_entry_id"=p_entry_id
UNION ALL
SELECT 'transactions.potential_journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."transactions" r WHERE r."potential_journal_entry_id"=p_entry_id
UNION ALL
SELECT 'vacation_year_closures.adjustment_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."vacation_year_closures" r WHERE r."adjustment_entry_id"=p_entry_id
UNION ALL
SELECT 'webshop_orders.journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."webshop_orders" r WHERE r."journal_entry_id"=p_entry_id
UNION ALL
SELECT 'webshop_orders.manually_booked_journal_entry_id' relationship,coalesce(to_jsonb(r)->>'id',to_jsonb(r)->>'journal_entry_id') record_id,
  encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') record_hash
  FROM public."webshop_orders" r WHERE r."manually_booked_journal_entry_id"=p_entry_id
  ) links;
$$;
REVOKE ALL ON FUNCTION public.sie_repair_entry_links(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.undo_sie_duplicate_repair_chunk(p_company_id uuid,p_import_id uuid,p_worker_id uuid,p_attempt integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='30s' AS $$
DECLARE v_job public.sie_imports; v_actor uuid; v_ids uuid[]; v_keep_ids uuid[]; v_receipt jsonb;
  v_first integer; v_links uuid[]; v_bad uuid;
BEGIN
  v_job:=public.lock_sie_execution(p_company_id,p_import_id,p_worker_id,p_attempt);
  IF v_job.job_kind<>'duplicate_repair' OR v_job.job_phase<>'undo' THEN RAISE EXCEPTION 'SIE job is not a reviewed repair'; END IF;
  v_actor:=coalesce(v_job.execution_actor_id,v_job.user_id);
  IF NOT pg_try_advisory_xact_lock(hashtextextended('sie-writer-slot:0',0)) AND
    NOT pg_try_advisory_xact_lock(hashtextextended('sie-writer-slot:1',0)) THEN
    RAISE EXCEPTION 'SIE platform write capacity is busy' USING ERRCODE='55P03';
  END IF;
  WITH candidates AS (
    SELECT i.*,(SELECT count(*) FROM public.journal_entry_lines l WHERE l.journal_entry_id=i.reverse_entry_id) n
      FROM public.sie_duplicate_repair_items i WHERE i.import_id=p_import_id AND i.reversal_id IS NULL ORDER BY ordinal LIMIT 200
  ), sized AS (SELECT *,sum(n) OVER (ORDER BY ordinal) total FROM candidates)
  SELECT array_agg(reverse_entry_id ORDER BY ordinal),array_agg(keep_entry_id ORDER BY ordinal),min(ordinal)
    INTO v_ids,v_keep_ids,v_first FROM sized WHERE total<=2000;
  IF coalesce(cardinality(v_ids),0)=0 THEN
    IF EXISTS(SELECT 1 FROM public.sie_duplicate_repair_items WHERE import_id=p_import_id AND reversal_id IS NULL) THEN
      RAISE EXCEPTION 'SIE repair voucher exceeds 2000 lines' USING ERRCODE='22023';
    END IF;
    UPDATE public.sie_imports SET job_state='undone',status='replaced',worker_id=NULL,lease_until=NULL,error_message=NULL
      WHERE id=p_import_id;
    UPDATE public.fiscal_periods SET import_hold=NULL WHERE id=v_job.fiscal_period_id AND import_hold=p_import_id;
    RETURN jsonb_build_object('reversed',0,'done',true);
  END IF;
  PERFORM 1 FROM public.journal_entries WHERE id=ANY(v_ids||v_keep_ids) ORDER BY id FOR UPDATE;
  SELECT i.reverse_entry_id INTO v_bad FROM public.sie_duplicate_repair_items i
    JOIN public.journal_entries d ON d.id=i.reverse_entry_id JOIN public.journal_entries k ON k.id=i.keep_entry_id
    WHERE i.import_id=p_import_id AND i.reverse_entry_id=ANY(v_ids) AND (
      d.status<>'posted' OR k.status<>'posted' OR d.company_id<>p_company_id OR k.company_id<>p_company_id
      OR d.fiscal_period_id<>v_job.fiscal_period_id OR k.fiscal_period_id<>v_job.fiscal_period_id
      OR public.sie_repair_content_hash(d.id) IS DISTINCT FROM i.content_hash
      OR public.sie_repair_content_hash(k.id) IS DISTINCT FROM i.content_hash
      OR public.sie_repair_entry_links(d.id) IS DISTINCT FROM i.reverse_links
      OR public.sie_repair_entry_links(k.id) IS DISTINCT FROM i.keep_links) LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'SIE repair review changed for voucher %',v_bad USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM public.sie_duplicate_repair_items i,
    LATERAL jsonb_array_elements(i.reverse_links) l WHERE i.import_id=p_import_id AND i.reverse_entry_id=ANY(v_ids)
      AND l->>'relationship' NOT IN ('document_attachments.journal_entry_id','document_attachments.journal_entry_line_id',
        'transactions.journal_entry_id','transaction_voucher_links.journal_entry_id','journal_entry_no_doc_required.journal_entry_id')) THEN
    RAISE EXCEPTION 'SIE repair has a dependent record requiring separate review' USING ERRCODE='55000';
  END IF;
  PERFORM set_config('app.sie_repair_job',p_import_id::text,true);
  -- The atomic storno writer below is shared in shape with ordinary batch undo.
  PERFORM 1 FROM public.journal_entries WHERE id = ANY(v_ids) ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.journal_entries WHERE id = ANY(v_ids) AND
      (source_type NOT IN ('import','opening_balance') OR status <> 'posted')) THEN
    RAISE EXCEPTION 'SIE batch contains a changed or unsupported entry';
  END IF;
  WITH counts AS (
    SELECT voucher_series,count(*)::integer n FROM public.journal_entries WHERE id = ANY(v_ids) GROUP BY voucher_series
  ), reserved AS (
    INSERT INTO public.voucher_sequences(company_id,user_id,fiscal_period_id,voucher_series,last_number)
      SELECT p_company_id,v_actor,v_job.fiscal_period_id,voucher_series,n FROM counts ORDER BY voucher_series
      ON CONFLICT (company_id,fiscal_period_id,voucher_series) DO UPDATE
        SET last_number = voucher_sequences.last_number+EXCLUDED.last_number,updated_at = now()
      RETURNING voucher_series,last_number
  ), originals AS (
    SELECT j.*,r.last_number-c.n+row_number() OVER (PARTITION BY j.voucher_series ORDER BY j.voucher_number,j.id) number
      FROM public.journal_entries j JOIN counts c USING (voucher_series) JOIN reserved r USING (voucher_series)
      WHERE j.id = ANY(v_ids)
  ), headers AS (
    INSERT INTO public.journal_entries(company_id,user_id,fiscal_period_id,voucher_series,voucher_number,entry_date,
      description,source_type,source_id,reverses_id,status)
      SELECT p_company_id,v_actor,v_job.fiscal_period_id,voucher_series,number::integer,entry_date,
        'Makulering: ' || description,'storno',source_id,id,'draft' FROM originals
      RETURNING id,reverses_id,voucher_number,voucher_series
  ), lines AS (
    INSERT INTO public.journal_entry_lines(journal_entry_id,account_number,account_id,debit_amount,credit_amount,
      line_description,currency,amount_in_currency,exchange_rate,tax_code,dimensions,sort_order)
      SELECT h.id,l.account_number,l.account_id,greatest(l.credit_amount-l.debit_amount,0),
        greatest(l.debit_amount-l.credit_amount,0),'Reversal: ' || coalesce(l.line_description,''),l.currency,
        -l.amount_in_currency,l.exchange_rate,l.tax_code,l.dimensions,l.sort_order
      FROM headers h JOIN public.journal_entry_lines l ON l.journal_entry_id = h.reverses_id
      RETURNING journal_entry_id
  )
  SELECT jsonb_agg(jsonb_build_object('id',id,'reverses',reverses_id,'number',voucher_number,'series',voucher_series))
    INTO v_receipt FROM headers;
  UPDATE public.journal_entries SET status = 'posted'
    WHERE id IN (SELECT (r->>'id')::uuid FROM jsonb_array_elements(v_receipt) r);
  UPDATE public.journal_entries j SET status = 'reversed',reversed_by_id = (r->>'id')::uuid
    FROM jsonb_array_elements(v_receipt) r WHERE j.id = (r->>'reverses')::uuid AND j.status = 'posted';

  -- Preserve documents and audit records. Release bank anchors atomically.
  PERFORM 1 FROM public.transactions t WHERE t.company_id = p_company_id AND
    (t.journal_entry_id = ANY(v_ids) OR EXISTS (SELECT 1 FROM public.transaction_voucher_links l
      WHERE l.transaction_id = t.id AND l.company_id = p_company_id AND l.journal_entry_id = ANY(v_ids)))
    ORDER BY t.id FOR UPDATE;
  SELECT array_agg(DISTINCT transaction_id) INTO v_links FROM public.transaction_voucher_links
    WHERE company_id = p_company_id AND journal_entry_id = ANY(v_ids);
  DELETE FROM public.transaction_voucher_links WHERE company_id = p_company_id AND transaction_id IN (
    SELECT id FROM public.transactions WHERE company_id = p_company_id AND journal_entry_id = ANY(v_ids));
  UPDATE public.transactions SET journal_entry_id = NULL,is_business = NULL,category = NULL,reconciliation_method = NULL
    WHERE company_id = p_company_id AND journal_entry_id = ANY(v_ids);
  DELETE FROM public.transaction_voucher_links WHERE company_id = p_company_id AND journal_entry_id = ANY(v_ids);
  -- A partly reversed split no longer explains the transaction: release its
  -- remaining bank-line slices, as reverseEntry does for an individual storno.
  DELETE FROM public.transaction_voucher_links WHERE company_id = p_company_id AND transaction_id IN (
    SELECT t.id FROM public.transactions t JOIN public.transaction_voucher_links l ON l.transaction_id = t.id
      AND l.company_id = p_company_id WHERE t.company_id = p_company_id AND t.id = ANY(v_links) AND t.journal_entry_id IS NULL
    GROUP BY t.id,t.amount HAVING bool_and(l.role = 'bank_line') AND abs(round(sum(l.allocated_amount)-t.amount,2)) > 0.005);
  UPDATE public.transactions t SET is_business = NULL,category = NULL,reconciliation_method = NULL
    WHERE t.company_id = p_company_id AND t.id = ANY(v_links) AND t.journal_entry_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.transaction_voucher_links l WHERE l.company_id = p_company_id AND l.transaction_id = t.id);
  UPDATE public.fiscal_periods SET opening_balances_set = false
    WHERE company_id = p_company_id AND opening_balance_entry_id = ANY(v_ids);
  UPDATE public.fiscal_periods SET opening_balance_entry_id = NULL
    WHERE company_id = p_company_id AND opening_balance_entry_id = ANY(v_ids);
  UPDATE public.sie_duplicate_repair_items i SET reversal_id=(r->>'id')::uuid
    FROM jsonb_array_elements(v_receipt) r WHERE i.import_id=p_import_id AND i.reverse_entry_id=(r->>'reverses')::uuid;
  INSERT INTO public.sie_import_chunks(import_id,company_id,user_id,phase,chunk_no,payload_hash,state,result,completed_at)
    VALUES(p_import_id,p_company_id,v_actor,'undo',v_first,encode(extensions.digest(v_receipt::text,'sha256'),'hex'),
      'completed',jsonb_build_object('entries',v_receipt,'reviewHash',v_job.manifest->>'reviewHash'),clock_timestamp());
  UPDATE public.sie_imports SET chunks_done=chunks_done+cardinality(v_ids) WHERE id=p_import_id;
  RETURN jsonb_build_object('reversed',cardinality(v_ids),'done',false);
END;
$$;
REVOKE ALL ON FUNCTION public.undo_sie_duplicate_repair_chunk(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.undo_sie_duplicate_repair_chunk(uuid,uuid,uuid,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.guard_sie_held_entry() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_hold uuid; v_phase text; v_original_batch uuid; v_repair uuid;
BEGIN
  IF NEW.import_batch_id IS NULL AND (TG_OP='UPDATE' OR NEW.correction_of_id IS NOT NULL OR NEW.reverses_id IS NOT NULL) THEN
    v_repair:=coalesce(public.sie_active_repair_for_entry(NEW.id),
      public.sie_active_repair_for_entry(NEW.correction_of_id),public.sie_active_repair_for_entry(NEW.reverses_id));
  END IF;
  IF v_repair IS NOT NULL THEN
    IF current_user NOT IN ('anon','authenticated','service_role') AND
      current_setting('app.sie_repair_job',true)=v_repair::text AND
      (NEW.source_type='storno' OR (TG_OP='UPDATE' AND NEW.status='reversed')) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'SIE_IMPORT_HOLD: granskad dubbletträttelse pågår' USING ERRCODE='55000';
  END IF;
  -- Native unrelated bookkeeping does not depend on the import. In particular
  -- commit_journal_entry already owns its sequence lock when this trigger runs.
  IF NEW.import_batch_id IS NULL AND NEW.correction_of_id IS NULL AND
    NEW.source_type NOT IN ('import','opening_balance','year_end','storno') THEN RETURN NEW; END IF;
  SELECT import_hold INTO v_hold FROM public.fiscal_periods
    WHERE id = NEW.fiscal_period_id AND company_id = NEW.company_id FOR UPDATE NOWAIT;
  IF v_hold IS NULL THEN RETURN NEW; END IF;
  SELECT job_phase INTO v_phase FROM public.sie_imports WHERE id = v_hold;
  IF current_user NOT IN ('anon','authenticated','service_role') THEN
    IF NEW.import_batch_id = v_hold AND v_phase IN ('vouchers','finalize') AND
      ((TG_OP = 'INSERT' AND NEW.status = 'draft') OR
       (TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status = 'posted')) THEN RETURN NEW; END IF;
    IF v_phase = 'undo' THEN
      IF TG_OP = 'UPDATE' AND NEW.import_batch_id = v_hold AND NEW.status = 'reversed' THEN RETURN NEW; END IF;
      IF NEW.source_type = 'storno' THEN
        SELECT import_batch_id INTO v_original_batch FROM public.journal_entries WHERE id = NEW.reverses_id AND company_id = NEW.company_id;
        IF v_original_batch = v_hold THEN RETURN NEW; END IF;
      END IF;
    END IF;
  END IF;
  IF NEW.correction_of_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.journal_entries
    WHERE id = NEW.correction_of_id AND company_id = NEW.company_id AND import_batch_id = v_hold) THEN
    RAISE EXCEPTION 'SIE_IMPORT_HOLD: vänta med rättelser tills importen är slutförd' USING ERRCODE = '55000';
  END IF;
  -- Ordinary unrelated bookkeeping remains usable; work that changes the
  -- import or period balances' initialization must wait for finalization.
  IF NEW.import_batch_id IS NOT NULL OR NEW.source_type IN ('import','opening_balance','year_end','storno') THEN
    RAISE EXCEPTION 'SIE_IMPORT_HOLD: importen pågår eller är oavslutad' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_sie_held_lines() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_entry public.journal_entries; v_hold uuid;
BEGIN
  SELECT * INTO v_entry FROM public.journal_entries
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.journal_entry_id ELSE NEW.journal_entry_id END;
  IF v_entry.import_batch_id IS NULL AND public.sie_active_repair_for_entry(v_entry.id) IS NOT NULL THEN
    RAISE EXCEPTION 'SIE_IMPORT_HOLD: granskad dubbletträttelse pågår' USING ERRCODE='55000';
  END IF;
  IF v_entry.import_batch_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT import_hold INTO v_hold FROM public.fiscal_periods WHERE id = v_entry.fiscal_period_id FOR UPDATE NOWAIT;
  IF v_hold IS NOT NULL AND v_entry.import_batch_id = v_hold AND v_entry.status <> 'draft' THEN
    RAISE EXCEPTION 'SIE_IMPORT_HOLD: vänta med rättelser tills importen är slutförd' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_sie_held_attachment() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_entry uuid; v_period uuid; v_batch uuid; v_hold uuid; v_repair uuid;
BEGIN
  v_entry := NEW.journal_entry_id;
  IF TG_TABLE_NAME = 'document_attachments' AND v_entry IS NULL THEN
    SELECT journal_entry_id INTO v_entry FROM public.journal_entry_lines WHERE id = (to_jsonb(NEW)->>'journal_entry_line_id')::uuid;
  END IF;
  v_repair:=public.sie_active_repair_for_entry(v_entry);
  IF TG_OP='UPDATE' THEN v_repair:=coalesce(v_repair,public.sie_active_repair_for_entry(OLD.journal_entry_id)); END IF;
  IF v_repair IS NOT NULL THEN
    IF current_user NOT IN ('anon','authenticated','service_role') AND
      current_setting('app.sie_repair_job',true)=v_repair::text AND TG_TABLE_NAME<>'document_attachments' THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'SIE_IMPORT_HOLD: granskad dubbletträttelse pågår' USING ERRCODE='55000';
  END IF;
  IF v_entry IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id
    AND (to_jsonb(NEW)->>'journal_entry_line_id') IS NOT DISTINCT FROM (to_jsonb(OLD)->>'journal_entry_line_id') THEN RETURN NEW; END IF;
  SELECT fiscal_period_id,import_batch_id INTO v_period,v_batch FROM public.journal_entries WHERE id = v_entry;
  IF v_batch IS NULL THEN RETURN NEW; END IF;
  SELECT import_hold INTO v_hold FROM public.fiscal_periods WHERE id = v_period FOR UPDATE NOWAIT;
  IF v_batch IS NOT NULL AND v_hold = v_batch THEN
    RAISE EXCEPTION 'SIE_IMPORT_HOLD: vänta med underlag och bankmatchning tills importen är slutförd' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.undo_sie_import_chunk(p_company_id uuid,p_import_id uuid,p_worker_id uuid,p_attempt integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET statement_timeout = '30s' AS $$
DECLARE v_job public.sie_imports; v_actor uuid; v_ids uuid[]; v_receipt jsonb;
  v_first integer; v_links uuid[]; v_renames public.sie_import_chunks;
BEGIN
  v_job := public.lock_sie_execution(p_company_id,p_import_id,p_worker_id,p_attempt);
  IF v_job.job_phase <> 'undo' OR v_job.job_kind <> 'import' THEN RAISE EXCEPTION 'SIE job is not undoing'; END IF;
  v_actor := coalesce(v_job.execution_actor_id,v_job.user_id);
  IF NOT pg_try_advisory_xact_lock(hashtextextended('sie-writer-slot:0',0)) AND
     NOT pg_try_advisory_xact_lock(hashtextextended('sie-writer-slot:1',0)) THEN
    RAISE EXCEPTION 'SIE platform write capacity is busy' USING ERRCODE = '55P03';
  END IF;
  -- Bound both header and line work. A voucher is never split.
  WITH candidates AS (
    SELECT j.id,j.source_ordinal,(SELECT count(*) FROM public.journal_entry_lines l WHERE l.journal_entry_id = j.id) n
    FROM public.journal_entries j WHERE j.import_batch_id = p_import_id AND j.company_id = p_company_id
      AND j.status = 'posted' ORDER BY j.source_ordinal LIMIT 500
  ), sized AS (SELECT *,sum(n) OVER (ORDER BY source_ordinal) total FROM candidates)
  SELECT array_agg(id ORDER BY source_ordinal),min(source_ordinal) INTO v_ids,v_first FROM sized WHERE total <= 2000;
  IF coalesce(cardinality(v_ids),0) = 0 THEN
    IF EXISTS (SELECT 1 FROM public.journal_entries WHERE import_batch_id = p_import_id AND status = 'posted') THEN
      RAISE EXCEPTION 'SIE undo voucher exceeds 2000 lines';
    END IF;
    -- Restore names only while they still equal this import's write; preserve
    -- subsequent user edits. Each batch of at most 100 names has a receipt.
    SELECT c.* INTO v_renames FROM public.sie_import_chunks c WHERE c.import_id = p_import_id
      AND c.phase = 'prepare' AND ((c.chunk_no >= 50000 AND c.chunk_no < 60000) OR (c.chunk_no >= 70000 AND c.chunk_no < 80000))
      AND NOT EXISTS (SELECT 1 FROM public.sie_import_chunks u WHERE u.import_id = p_import_id
        AND u.phase = 'undo' AND u.chunk_no = 100000+c.chunk_no)
      ORDER BY c.chunk_no LIMIT 1;
    IF FOUND THEN
      UPDATE public.chart_of_accounts a SET account_name = r->>'from'
        FROM jsonb_array_elements(coalesce(v_renames.result->'renamed','[]'::jsonb)) r
        WHERE a.company_id = p_company_id AND a.account_number = r->>'accountNumber' AND a.account_name = r->>'to';
      UPDATE public.chart_of_accounts a SET default_vat_treatment = r->>'fromTreatment',default_vat_rate = (r->>'fromRate')::numeric
        FROM jsonb_array_elements(coalesce(v_renames.result->'vatDefaults','[]'::jsonb)) r
        WHERE a.company_id = p_company_id AND a.account_number = r->>'accountNumber'
          AND a.default_vat_treatment IS NOT DISTINCT FROM r->>'toTreatment'
          AND a.default_vat_rate IS NOT DISTINCT FROM (r->>'toRate')::numeric;
      INSERT INTO public.sie_import_chunks(import_id,company_id,user_id,phase,chunk_no,payload_hash,state,result,completed_at)
        VALUES(p_import_id,p_company_id,v_actor,'undo',100000+v_renames.chunk_no,v_renames.payload_hash,
          'completed',jsonb_build_object('accountNamesRestored',true),clock_timestamp());
      RETURN jsonb_build_object('reversed',0,'done',false);
    END IF;
    UPDATE public.sie_imports SET job_state = 'undone',status = 'replaced',worker_id = NULL,lease_until = NULL,
      error_message = NULL WHERE id = p_import_id;
    UPDATE public.fiscal_periods SET import_hold = NULL WHERE id = v_job.fiscal_period_id AND import_hold = p_import_id;
    RETURN jsonb_build_object('reversed',0,'done',true);
  END IF;
  PERFORM 1 FROM public.journal_entries WHERE id = ANY(v_ids) ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.journal_entries WHERE id = ANY(v_ids) AND
      (source_type NOT IN ('import','opening_balance') OR status <> 'posted')) THEN
    RAISE EXCEPTION 'SIE batch contains a changed or unsupported entry';
  END IF;
  WITH counts AS (
    SELECT voucher_series,count(*)::integer n FROM public.journal_entries WHERE id = ANY(v_ids) GROUP BY voucher_series
  ), reserved AS (
    INSERT INTO public.voucher_sequences(company_id,user_id,fiscal_period_id,voucher_series,last_number)
      SELECT p_company_id,v_actor,v_job.fiscal_period_id,voucher_series,n FROM counts ORDER BY voucher_series
      ON CONFLICT (company_id,fiscal_period_id,voucher_series) DO UPDATE
        SET last_number = voucher_sequences.last_number+EXCLUDED.last_number,updated_at = now()
      RETURNING voucher_series,last_number
  ), originals AS (
    SELECT j.*,r.last_number-c.n+row_number() OVER (PARTITION BY j.voucher_series ORDER BY j.source_ordinal) number
      FROM public.journal_entries j JOIN counts c USING (voucher_series) JOIN reserved r USING (voucher_series)
      WHERE j.id = ANY(v_ids)
  ), headers AS (
    INSERT INTO public.journal_entries(company_id,user_id,fiscal_period_id,voucher_series,voucher_number,entry_date,
      description,source_type,source_id,reverses_id,status)
      SELECT p_company_id,v_actor,v_job.fiscal_period_id,voucher_series,number::integer,entry_date,
        'Makulering: ' || description,'storno',source_id,id,'draft' FROM originals
      RETURNING id,reverses_id,voucher_number,voucher_series
  ), lines AS (
    INSERT INTO public.journal_entry_lines(journal_entry_id,account_number,account_id,debit_amount,credit_amount,
      line_description,currency,amount_in_currency,exchange_rate,tax_code,dimensions,sort_order)
      SELECT h.id,l.account_number,l.account_id,greatest(l.credit_amount-l.debit_amount,0),
        greatest(l.debit_amount-l.credit_amount,0),'Reversal: ' || coalesce(l.line_description,''),l.currency,
        -l.amount_in_currency,l.exchange_rate,l.tax_code,l.dimensions,l.sort_order
      FROM headers h JOIN public.journal_entry_lines l ON l.journal_entry_id = h.reverses_id
      RETURNING journal_entry_id
  )
  SELECT jsonb_agg(jsonb_build_object('id',id,'reverses',reverses_id,'number',voucher_number,'series',voucher_series))
    INTO v_receipt FROM headers;
  UPDATE public.journal_entries SET status = 'posted'
    WHERE id IN (SELECT (r->>'id')::uuid FROM jsonb_array_elements(v_receipt) r);
  UPDATE public.journal_entries j SET status = 'reversed',reversed_by_id = (r->>'id')::uuid
    FROM jsonb_array_elements(v_receipt) r WHERE j.id = (r->>'reverses')::uuid AND j.status = 'posted';

  -- Preserve documents and audit records. Release bank anchors atomically.
  PERFORM 1 FROM public.transactions t WHERE t.company_id = p_company_id AND
    (t.journal_entry_id = ANY(v_ids) OR EXISTS (SELECT 1 FROM public.transaction_voucher_links l
      WHERE l.transaction_id = t.id AND l.company_id = p_company_id AND l.journal_entry_id = ANY(v_ids)))
    ORDER BY t.id FOR UPDATE;
  SELECT array_agg(DISTINCT transaction_id) INTO v_links FROM public.transaction_voucher_links
    WHERE company_id = p_company_id AND journal_entry_id = ANY(v_ids);
  DELETE FROM public.transaction_voucher_links WHERE company_id = p_company_id AND transaction_id IN (
    SELECT id FROM public.transactions WHERE company_id = p_company_id AND journal_entry_id = ANY(v_ids));
  UPDATE public.transactions SET journal_entry_id = NULL,is_business = NULL,category = NULL,reconciliation_method = NULL
    WHERE company_id = p_company_id AND journal_entry_id = ANY(v_ids);
  DELETE FROM public.transaction_voucher_links WHERE company_id = p_company_id AND journal_entry_id = ANY(v_ids);
  -- A partly reversed split no longer explains the transaction: release its
  -- remaining bank-line slices, as reverseEntry does for an individual storno.
  DELETE FROM public.transaction_voucher_links WHERE company_id = p_company_id AND transaction_id IN (
    SELECT t.id FROM public.transactions t JOIN public.transaction_voucher_links l ON l.transaction_id = t.id
      AND l.company_id = p_company_id WHERE t.company_id = p_company_id AND t.id = ANY(v_links) AND t.journal_entry_id IS NULL
    GROUP BY t.id,t.amount HAVING bool_and(l.role = 'bank_line') AND abs(round(sum(l.allocated_amount)-t.amount,2)) > 0.005);
  UPDATE public.transactions t SET is_business = NULL,category = NULL,reconciliation_method = NULL
    WHERE t.company_id = p_company_id AND t.id = ANY(v_links) AND t.journal_entry_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.transaction_voucher_links l WHERE l.company_id = p_company_id AND l.transaction_id = t.id);
  UPDATE public.fiscal_periods SET opening_balances_set = false
    WHERE company_id = p_company_id AND opening_balance_entry_id = ANY(v_ids);
  UPDATE public.fiscal_periods SET opening_balance_entry_id = NULL
    WHERE company_id = p_company_id AND opening_balance_entry_id = ANY(v_ids);
  INSERT INTO public.sie_import_chunks(import_id,company_id,user_id,phase,chunk_no,payload_hash,state,result,completed_at)
    VALUES(p_import_id,p_company_id,v_actor,'undo',v_first,encode(extensions.digest(v_receipt::text,'sha256'),'hex'),
      'completed',jsonb_build_object('entries',v_receipt),clock_timestamp());
  RETURN jsonb_build_object('reversed',cardinality(v_ids),'done',false);
END;
$$;

NOTIFY pgrst,'reload schema';

