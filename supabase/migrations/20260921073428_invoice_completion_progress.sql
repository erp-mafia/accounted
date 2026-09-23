-- Invoice completion owns only recovery state. Accounting writes still go
-- through complete_invoice_rows; discovery never creates invoices or parties.
-- PostgREST hoists each RPC's statement_timeout to its transaction:
-- https://postgrest.org/en/latest/references/transactions.html#function-settings
CREATE TABLE public.invoice_completion_work (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL UNIQUE REFERENCES public.companies(id),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  consent_id uuid REFERENCES public.provider_consents(id) ON DELETE SET NULL,
  provider text NOT NULL,
  account_key text NOT NULL,
  scan_id uuid NOT NULL DEFAULT gen_random_uuid(),
  part text NOT NULL DEFAULT 'invoices' CHECK (part IN ('invoices','creditNotes')),
  next_page integer CHECK (next_page > 0),
  scanned_at timestamptz,
  worker_id uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_completion_work_due ON public.invoice_completion_work(next_attempt_at, updated_at);
CREATE INDEX invoice_completion_work_user ON public.invoice_completion_work(user_id);
CREATE INDEX invoice_completion_work_consent ON public.invoice_completion_work(consent_id);
CREATE TRIGGER invoice_completion_work_updated BEFORE UPDATE ON public.invoice_completion_work
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER invoice_completion_work_audit AFTER INSERT OR UPDATE OR DELETE ON public.invoice_completion_work
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- Store only source identifiers, never provider payloads. One entry per local
-- invoice holds matching evidence, its retry schedule, and the last receipt.
CREATE TABLE public.invoice_completion_entries (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.invoice_completion_work(company_id),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id),
  scan_id uuid,
  source_id text,
  source_ref jsonb,
  ambiguous boolean NOT NULL DEFAULT false,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  outcome text,
  run_id uuid,
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, invoice_id)
);
CREATE INDEX invoice_completion_entries_run ON public.invoice_completion_entries(run_id);
CREATE INDEX invoice_completion_entries_invoice ON public.invoice_completion_entries(invoice_id);
CREATE TRIGGER invoice_completion_entries_updated BEFORE UPDATE ON public.invoice_completion_entries
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER invoice_completion_entries_audit AFTER INSERT OR UPDATE OR DELETE ON public.invoice_completion_entries
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();
ALTER TABLE public.invoice_completion_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_completion_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_completion_work_read ON public.invoice_completion_work FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY invoice_completion_entries_read ON public.invoice_completion_entries FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));
REVOKE ALL ON public.invoice_completion_work, public.invoice_completion_entries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.invoice_completion_work, public.invoice_completion_entries TO authenticated;
GRANT ALL ON public.invoice_completion_work, public.invoice_completion_entries TO service_role;

CREATE FUNCTION public.enqueue_invoice_completion_work() RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public SET statement_timeout='8s' SET lock_timeout='1s' AS $$
DECLARE n integer;
BEGIN
  INSERT INTO invoice_completion_work(company_id,user_id,consent_id,provider,account_key,next_page)
  SELECT DISTINCT ON (c.company_id) c.company_id,co.created_by,c.id,c.provider,
    COALESCE(NULLIF(regexp_replace(c.org_number,'[^[:alnum:]]','','g'),''),NULLIF(t.provider_company_id,''),c.id::text),1
  FROM provider_consents c JOIN provider_consent_tokens t ON t.consent_id=c.id JOIN companies co ON co.id=c.company_id
  WHERE c.status=1 AND c.provider IS NOT NULL
    AND (t.token_expires_at IS NULL OR t.token_expires_at>now()-interval '45 days')
    AND NOT EXISTS (SELECT 1 FROM invoice_completion_work w WHERE w.company_id=c.company_id)
  ORDER BY c.company_id,c.created_at DESC,c.id LIMIT 500
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n;
END $$;

CREATE FUNCTION public.claim_invoice_completion_work(p_worker_id uuid,p_exclude uuid[] DEFAULT '{}')
RETURNS public.invoice_completion_work LANGUAGE plpgsql SECURITY INVOKER
SET search_path=public SET statement_timeout='8s' SET lock_timeout='1s' AS $$
DECLARE w invoice_completion_work; consent record; changed boolean;
BEGIN
  SELECT q.* INTO w FROM invoice_completion_work q
  WHERE q.company_id<>ALL(p_exclude) AND q.next_attempt_at<=clock_timestamp()
    AND (q.lease_until IS NULL OR q.lease_until<clock_timestamp())
    AND EXISTS (SELECT 1 FROM provider_consents c JOIN provider_consent_tokens t ON t.consent_id=c.id
      WHERE c.company_id=q.company_id AND c.status=1 AND c.provider IS NOT NULL
        AND (t.token_expires_at IS NULL OR t.token_expires_at>now()-interval '45 days'))
    AND EXISTS (SELECT 1 FROM invoices i LEFT JOIN invoice_completion_entries e
      ON e.company_id=i.company_id AND e.invoice_id=i.id
      WHERE i.company_id=q.company_id AND i.document_type='invoice' AND i.status<>'draft'
        AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id=i.id)
        AND (e.next_attempt_at IS NULL OR e.next_attempt_at<=clock_timestamp()))
  ORDER BY q.next_attempt_at,q.updated_at,q.company_id LIMIT 1 FOR UPDATE OF q SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT c.id,co.created_by AS user_id,c.provider,
    COALESCE(NULLIF(regexp_replace(c.org_number,'[^[:alnum:]]','','g'),''),NULLIF(t.provider_company_id,''),c.id::text) account_key
    INTO STRICT consent FROM provider_consents c JOIN provider_consent_tokens t ON t.consent_id=c.id JOIN companies co ON co.id=c.company_id
    WHERE c.company_id=w.company_id AND c.status=1 AND c.provider IS NOT NULL
      AND (t.token_expires_at IS NULL OR t.token_expires_at>now()-interval '45 days')
    ORDER BY c.created_at DESC,c.id LIMIT 1;
  changed:=w.provider<>consent.provider OR w.account_key<>consent.account_key;
  IF changed OR (w.next_page IS NULL AND w.scanned_at<now()-interval '1 day') THEN
    w.scan_id:=gen_random_uuid(); w.next_page:=1; w.part:='invoices'; w.scanned_at:=NULL;
  END IF;
  IF changed THEN
    UPDATE invoice_completion_entries SET next_attempt_at=now() WHERE company_id=w.company_id;
  END IF;
  UPDATE invoice_completion_work SET consent_id=consent.id,user_id=consent.user_id,provider=consent.provider,account_key=consent.account_key,
    scan_id=w.scan_id,next_page=w.next_page,part=w.part,scanned_at=w.scanned_at,
    worker_id=p_worker_id,lease_until=clock_timestamp()+interval '3 minutes'
    WHERE company_id=w.company_id RETURNING * INTO w;
  RETURN w;
END $$;

CREATE FUNCTION public.lock_invoice_completion_work(p_company_id uuid,p_worker_id uuid)
RETURNS public.invoice_completion_work LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE w invoice_completion_work;
BEGIN
  SELECT * INTO STRICT w FROM invoice_completion_work WHERE company_id=p_company_id FOR UPDATE;
  IF w.worker_id IS DISTINCT FROM p_worker_id OR w.lease_until<clock_timestamp() THEN
    RAISE EXCEPTION 'INVOICE_COMPLETION_LEASE_LOST';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM provider_consents WHERE id=w.consent_id AND company_id=w.company_id AND status=1) THEN
    RAISE EXCEPTION 'PROVIDER_AUTH_EXPIRED';
  END IF;
  RETURN w;
END $$;

CREATE FUNCTION public.save_invoice_completion_page(p_company_id uuid,p_worker_id uuid,p_scan_id uuid,
  p_part text,p_page integer,p_records jsonb,p_next_page integer,p_next_part text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER
SET search_path=public SET statement_timeout='8s' SET lock_timeout='1s' AS $$
DECLARE w invoice_completion_work; r jsonb;
BEGIN
  w:=lock_invoice_completion_work(p_company_id,p_worker_id);
  IF w.scan_id<>p_scan_id OR w.part<>p_part OR w.next_page IS DISTINCT FROM p_page THEN
    RAISE EXCEPTION 'INVOICE_COMPLETION_CURSOR_CONFLICT';
  END IF;
  IF jsonb_typeof(p_records)<>'array' OR jsonb_array_length(p_records)>1000 THEN
    RAISE EXCEPTION 'INVOICE_COMPLETION_PAGE_TOO_LARGE';
  END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_records) LOOP
    IF COALESCE(r->>'id','')='' OR COALESCE(r->>'invoiceNumber','')='' OR COALESCE(r->>'issueDate','')='' THEN CONTINUE; END IF;
    INSERT INTO invoice_completion_entries(company_id,invoice_id,scan_id,source_id,source_ref)
      SELECT i.company_id,i.id,w.scan_id,r->>'id',r
      FROM invoices i WHERE i.company_id=w.company_id AND i.document_type='invoice' AND i.status<>'draft'
        AND i.invoice_number=r->>'invoiceNumber' AND i.invoice_date=(r->>'issueDate')::date
        AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id=i.id)
    ON CONFLICT(company_id,invoice_id) DO UPDATE SET
      ambiguous=CASE WHEN invoice_completion_entries.scan_id=EXCLUDED.scan_id
        THEN invoice_completion_entries.ambiguous OR invoice_completion_entries.source_id<>EXCLUDED.source_id ELSE false END,
      source_ref=CASE WHEN invoice_completion_entries.scan_id=EXCLUDED.scan_id
        AND invoice_completion_entries.source_ref->>'creditNote'='true' THEN invoice_completion_entries.source_ref ELSE EXCLUDED.source_ref END,
      source_id=EXCLUDED.source_id,scan_id=EXCLUDED.scan_id;
  END LOOP;
  IF p_next_page IS NOT NULL AND NOT (
    (p_next_part=p_part AND p_next_page=p_page+1) OR
    (w.provider='bokio' AND p_part='invoices' AND p_next_part='creditNotes' AND p_next_page=1)
  ) THEN RAISE EXCEPTION 'INVOICE_COMPLETION_CURSOR_CONFLICT'; END IF;
  UPDATE invoice_completion_work SET next_page=p_next_page,part=COALESCE(p_next_part,part),
    scanned_at=CASE WHEN p_next_page IS NULL THEN clock_timestamp() ELSE NULL END
    WHERE company_id=w.company_id;
END $$;

CREATE FUNCTION public.load_invoice_completion_candidates(p_company_id uuid,p_worker_id uuid,p_mapped_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path=public SET statement_timeout='8s' SET lock_timeout='1s' AS $$
DECLARE w invoice_completion_work; result jsonb;
BEGIN
  w:=lock_invoice_completion_work(p_company_id,p_worker_id);
  SELECT COALESCE(jsonb_agg(to_jsonb(c)), '[]') INTO result FROM (
    SELECT i.id,i.user_id,i.customer_id,i.invoice_number,i.invoice_date,i.total,i.subtotal,i.vat_amount,
      i.vat_rate,i.vat_treatment,i.currency,i.exchange_rate,
      -- Local invoice numbers are unique per company in the existing index.
      -- Provider uniqueness still requires all pages from this scan.
      COALESCE(e.scan_id=w.scan_id AND e.ambiguous,false) AS ambiguous,
      COALESCE(mapping.ref,CASE WHEN w.next_page IS NULL AND e.scan_id=w.scan_id AND NOT e.ambiguous THEN e.source_ref END) AS source_ref
    FROM invoices i LEFT JOIN invoice_completion_entries e ON e.company_id=i.company_id AND e.invoice_id=i.id
    LEFT JOIN LATERAL (
      -- Only these adapters use their stable DTO id as the detail endpoint id.
      -- BL explicitly does not; its source id alone is insufficient evidence.
      SELECT jsonb_build_object('id',min(m.source_id),'detailId',min(m.source_id),
        'invoiceNumber',i.invoice_number,'issueDate',i.invoice_date,'creditNote',false) ref
      FROM migration_source_records m WHERE m.company_id=i.company_id AND m.target_id=i.id
        AND m.provider=w.provider AND m.account_key=w.account_key AND m.resource='salesInvoices'
        AND w.provider IN ('fortnox','visma') HAVING count(*)=1
    ) mapping ON true
    WHERE i.company_id=w.company_id AND i.document_type='invoice' AND i.status<>'draft'
      AND NOT EXISTS(SELECT 1 FROM invoice_items ii WHERE ii.invoice_id=i.id)
      AND (e.next_attempt_at IS NULL OR e.next_attempt_at<=clock_timestamp())
      AND (NOT p_mapped_only OR mapping.ref IS NOT NULL)
    ORDER BY COALESCE(e.next_attempt_at,'-infinity'::timestamptz),i.id LIMIT 25
  ) c;
  RETURN result;
END $$;

-- One transaction: the existing invoice RPC, history event, retry state and
-- receipt. A lost HTTP reply is reconciled by run_id, never counted as failure.
CREATE FUNCTION public.finish_invoice_completion(p_company_id uuid,p_worker_id uuid,p_invoice_id uuid,
  p_outcome text,p_rows jsonb DEFAULT NULL,p_header jsonb DEFAULT NULL,p_event jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path=public SET statement_timeout='8s' SET lock_timeout='1s' AS $$
DECLARE w invoice_completion_work; prior invoice_completion_entries; r jsonb; event_uuid uuid;
BEGIN
  w:=lock_invoice_completion_work(p_company_id,p_worker_id);
  IF NOT EXISTS(SELECT 1 FROM invoices WHERE id=p_invoice_id AND company_id=p_company_id) THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND';
  END IF;
  SELECT * INTO prior FROM invoice_completion_entries WHERE company_id=p_company_id AND invoice_id=p_invoice_id;
  IF prior.run_id=p_worker_id AND prior.receipt IS NOT NULL THEN RETURN prior.receipt; END IF;
  IF p_rows IS NOT NULL THEN
    r:=complete_invoice_rows(p_company_id,p_invoice_id,p_rows,p_header);
    IF NOT COALESCE((r->>'ok')::boolean,false) THEN RAISE EXCEPTION 'INVOICE_COMPLETION_WRITE_FAILED: %',r->>'code'; END IF;
    p_outcome:=CASE WHEN (r->>'wrote')::boolean THEN 'written' ELSE 'already_filled' END;
    IF (r->>'wrote')::boolean THEN
      IF p_event IS NULL OR p_event->>'company_id' IS DISTINCT FROM p_company_id::text OR p_event->>'aggregate_id' IS DISTINCT FROM p_invoice_id::text
        OR p_event->>'event_type' IS DISTINCT FROM 'InvoiceRowsCompleted' OR p_event->>'correlation_id' IS DISTINCT FROM p_worker_id::text THEN
        RAISE EXCEPTION 'INVOICE_COMPLETION_EVENT_INVALID';
      END IF;
      event_uuid:=(p_event->>'event_id')::uuid;
      INSERT INTO processing_history(event_id,company_id,correlation_id,aggregate_type,aggregate_id,event_type,
        payload,payload_schema_version,actor,occurred_at)
      VALUES(event_uuid,p_company_id,p_worker_id,'Invoice',p_invoice_id,'InvoiceRowsCompleted',
        p_event->'payload',1,p_event->'actor',(p_event->>'occurred_at')::timestamptz);
    END IF;
  ELSIF p_outcome NOT IN ('unmatched','ambiguous','provider_empty','total_mismatch','rows_mismatch','failed') THEN
    RAISE EXCEPTION 'INVOICE_COMPLETION_OUTCOME_INVALID';
  END IF;
  r:=jsonb_build_object('status',p_outcome,'rows',COALESCE((r->>'rows')::integer,0),
    'headerUpdated',COALESCE((r->>'header_updated')::boolean,false),'eventId',event_uuid);
  INSERT INTO invoice_completion_entries(company_id,invoice_id,next_attempt_at,outcome,run_id,receipt)
    VALUES(p_company_id,p_invoice_id,clock_timestamp()+CASE WHEN p_outcome='failed' THEN interval '1 hour' ELSE interval '1 day' END,
      p_outcome,p_worker_id,r)
    ON CONFLICT(company_id,invoice_id) DO UPDATE SET next_attempt_at=EXCLUDED.next_attempt_at,
      outcome=EXCLUDED.outcome,run_id=EXCLUDED.run_id,receipt=EXCLUDED.receipt;
  RETURN r;
END $$;

CREATE FUNCTION public.release_invoice_completion_work(p_company_id uuid,p_worker_id uuid,p_retry_seconds integer DEFAULT 0)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER
SET search_path=public SET statement_timeout='8s' SET lock_timeout='1s' AS $$
BEGIN
  -- Release still works after a disconnect; only the current owner may do it.
  UPDATE invoice_completion_work SET worker_id=NULL,lease_until=NULL,
    next_attempt_at=clock_timestamp()+make_interval(secs=>GREATEST(0,p_retry_seconds))
    WHERE company_id=p_company_id AND worker_id=p_worker_id;
END $$;

REVOKE ALL ON FUNCTION public.enqueue_invoice_completion_work() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_invoice_completion_work(uuid,uuid[]) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.lock_invoice_completion_work(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.save_invoice_completion_page(uuid,uuid,uuid,text,integer,jsonb,integer,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.load_invoice_completion_candidates(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_invoice_completion(uuid,uuid,uuid,text,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.release_invoice_completion_work(uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_invoice_completion_work(),public.claim_invoice_completion_work(uuid,uuid[]),
  public.lock_invoice_completion_work(uuid,uuid),public.save_invoice_completion_page(uuid,uuid,uuid,text,integer,jsonb,integer,text),
  public.load_invoice_completion_candidates(uuid,uuid,boolean),public.finish_invoice_completion(uuid,uuid,uuid,text,jsonb,jsonb,jsonb),
  public.release_invoice_completion_work(uuid,uuid,integer) TO service_role;
NOTIFY pgrst,'reload schema';
