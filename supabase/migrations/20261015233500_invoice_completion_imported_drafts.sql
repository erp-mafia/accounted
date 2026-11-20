-- Row completion also fills migrated DRAFT invoices that arrived without rows
-- (crm#1245).
--
-- The migration wizard maps sales invoices from the provider's list form and
-- fetches the detail form (rows, net, VAT split) inside a fixed time budget.
-- Whatever the budget misses lands as a header with no invoice_items, and the
-- hourly completion pass (complete-invoice-lines.ts, migrations
-- 20260921073428 and 20260921135834) fetches the rows later. That pass left
-- out every draft, on the premise that "a draft without rows is a draft
-- someone is still writing, not an import shortfall". The premise does not
-- hold: a row-less draft with a non-zero total is an untouched import (an
-- unsent invoice that came over without rows and with no VAT rate), and no
-- company without a provider connection holds one.
--
-- A draft written in Accounted has its rows, or a total of 0: the totals are
-- computed from the rows. So the four functions below take a row-less draft
-- when its total is not 0, and keep leaving the empty in-app draft alone
-- (a draft that is empty at the source too has total 0 and no rows). Nothing
-- else changes, byte for byte: the bodies are restated from 20260921135834
-- (claim_invoice_completion_work, invoice_completion_block_status) and
-- 20260921073428 (save_invoice_completion_page,
-- load_invoice_completion_candidates), with
--   i.status<>'draft'   ->   (i.status<>'draft' OR i.total<>0)
-- in each candidate predicate.
--
-- What a draft gets is what every other invoice already gets: the rows the
-- provider's detail form holds, written once by complete_invoice_rows, and
-- the header VAT split only when the stored one holds no evidence; the
-- detail total must equal the stored total to the öre, and the invoice
-- number and date must match. A draft the user has since edited (rows added,
-- or a different total at the source) is not touched. The status, the
-- customer and the total are never written, and a draft has no verifikat.
--
-- pg-test: tests/pg/invoice-completion-drafts.pg.test.ts

CREATE OR REPLACE FUNCTION public.claim_invoice_completion_work(p_worker_id uuid,p_exclude uuid[] DEFAULT '{}')
RETURNS public.invoice_completion_work LANGUAGE plpgsql SECURITY INVOKER
SET search_path=public SET statement_timeout='8s' SET lock_timeout='1s' AS $$
DECLARE w invoice_completion_work; consent record; changed boolean;
BEGIN
  SELECT q.* INTO w FROM invoice_completion_work q
  CROSS JOIN LATERAL (
    SELECT c.id,c.provider,t.credential_revision,
      COALESCE(NULLIF(regexp_replace(c.org_number,'[^[:alnum:]]','','g'),''),NULLIF(t.provider_company_id,''),c.id::text) account_key
    FROM provider_consents c JOIN provider_consent_tokens t ON t.consent_id=c.id
    WHERE c.company_id=q.company_id AND c.status=1 AND c.provider IS NOT NULL
      AND (t.token_expires_at IS NULL OR t.token_expires_at>now()-interval '45 days')
    ORDER BY c.created_at DESC,c.id LIMIT 1
  ) selected
  WHERE q.company_id<>ALL(p_exclude) AND q.next_attempt_at<=clock_timestamp()
    AND (q.block_reason IS NULL OR q.consent_id IS DISTINCT FROM selected.id
      OR q.provider<>selected.provider OR q.account_key<>selected.account_key
      OR (q.block_reason='PROVIDER_AUTH_EXPIRED' AND q.blocked_revision IS DISTINCT FROM selected.credential_revision))
    AND (q.lease_until IS NULL OR q.lease_until<clock_timestamp())
    AND EXISTS (SELECT 1 FROM provider_consents c JOIN provider_consent_tokens t ON t.consent_id=c.id
      WHERE c.company_id=q.company_id AND c.status=1 AND c.provider IS NOT NULL
        AND (t.token_expires_at IS NULL OR t.token_expires_at>now()-interval '45 days'))
    AND EXISTS (SELECT 1 FROM invoices i LEFT JOIN invoice_completion_entries e
      ON e.company_id=i.company_id AND e.invoice_id=i.id
      WHERE i.company_id=q.company_id AND i.document_type='invoice' AND (i.status<>'draft' OR i.total<>0)
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
    block_reason=NULL,blocked_revision=NULL,blocked_at=NULL,block_id=NULL,
    worker_id=p_worker_id,lease_until=clock_timestamp()+interval '3 minutes'
    WHERE company_id=w.company_id RETURNING * INTO w;
  RETURN w;
END $$;

CREATE OR REPLACE FUNCTION public.invoice_completion_block_status(p_company_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public SET statement_timeout='8s' AS $$
  SELECT jsonb_build_object('consentId',w.consent_id,'reason',w.block_reason,'blockId',w.block_id,'blockedAt',w.blocked_at)
  FROM invoice_completion_work w
  WHERE w.company_id=p_company_id AND w.block_reason IS NOT NULL
    AND w.consent_id=(SELECT c.id FROM provider_consents c JOIN provider_consent_tokens t ON t.consent_id=c.id
      WHERE c.company_id=w.company_id AND c.status=1 AND c.provider IS NOT NULL ORDER BY c.created_at DESC,c.id LIMIT 1)
    AND EXISTS(SELECT 1 FROM invoices i WHERE i.company_id=w.company_id AND i.document_type='invoice' AND (i.status<>'draft' OR i.total<>0)
      AND NOT EXISTS(SELECT 1 FROM invoice_items ii WHERE ii.invoice_id=i.id));
$$;

CREATE OR REPLACE FUNCTION public.save_invoice_completion_page(p_company_id uuid,p_worker_id uuid,p_scan_id uuid,
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
      FROM invoices i WHERE i.company_id=w.company_id AND i.document_type='invoice' AND (i.status<>'draft' OR i.total<>0)
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

CREATE OR REPLACE FUNCTION public.load_invoice_completion_candidates(p_company_id uuid,p_worker_id uuid,p_mapped_only boolean DEFAULT false)
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
    WHERE i.company_id=w.company_id AND i.document_type='invoice' AND (i.status<>'draft' OR i.total<>0)
      AND NOT EXISTS(SELECT 1 FROM invoice_items ii WHERE ii.invoice_id=i.id)
      AND (e.next_attempt_at IS NULL OR e.next_attempt_at<=clock_timestamp())
      AND (NOT p_mapped_only OR mapping.ref IS NOT NULL)
    ORDER BY COALESCE(e.next_attempt_at,'-infinity'::timestamptz),i.id LIMIT 25
  ) c;
  RETURN result;
END $$;

NOTIFY pgrst,'reload schema';
