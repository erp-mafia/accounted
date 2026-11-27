-- A Fortnox supplier invoice an earlier import holds on another supplier card
-- is that invoice, not a new one.
--
-- An import from before fortnox_number (the older /migrate path) holds
-- Fortnox's löpnummer as the invoice's supplier number, on the card that path
-- chose: the one with the org number the invoice gives, else the one with the
-- name it gives (a card it made when none had it). It folded the Fortnox
-- suppliers of one org number into one card. The background import keeps each
-- Fortnox supplier on a card of its own and looked for such an invoice only on
-- the card it resolved for the record's Fortnox supplier. Where the two
-- disagreed, the invoice was inserted a second time: one invoice, two open
-- payables in the supplier ledger.
--
-- commit_provider_migration_records now asks, after every lookup on the
-- resolved card has found nothing and before it stores a new row, for the
-- invoice in the company with no fortnox_number that holds the löpnummer as
-- its supplier number with the record's date, currency, total and kind (the
-- reading repair_fortnox_supplier_invoice_numbers, 20261013133930, makes of
-- these rows). It is adopted when no verifikat and no payment is tied to it,
-- as that path booked none, and its card names the record's supplier: by org
-- number (the one the invoice gives, else the one the resolved card has from
-- Fortnox's register), or by the name the invoice gives with no other org
-- number. An adopted invoice keeps its card and its header and gets the
-- löpnummer and the record's source map, as on the resolved card. Any other
-- such invoice, which may be another one (another supplier's own, or one
-- booked or paid here), and two of them are refused as
-- MIGRATION_INVOICE_AMBIGUOUS for a person to decide. The candidate is read
-- FOR UPDATE.
--
-- Nothing else changes: the body is copied verbatim from 20261012161644
-- (identical to production) with that one block added; privileges are kept by
-- CREATE OR REPLACE. Applies from now on. Nothing stored changes.

CREATE OR REPLACE FUNCTION public.commit_provider_migration_records(p_job_id uuid,p_worker_id uuid,p_attempt integer,p_records jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE j public.migration_jobs; c public.migration_job_chunks; r jsonb; row_data jsonb; item jsonb;
  target uuid; party uuid; tbl text; ids uuid[]; row_result jsonb; was_new boolean; message text;
  legacy public.invoices; reused boolean; fortnox text;
BEGIN
  j:=lock_provider_migration_job(p_job_id,p_worker_id,p_attempt);
  IF j.phase<>'import' OR jsonb_array_length(p_records)>25 THEN RAISE EXCEPTION 'MIGRATION_PHASE_CONFLICT'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_records) LOOP
    SELECT * INTO STRICT c FROM migration_job_chunks WHERE id=(r->>'id')::uuid AND job_id=j.id FOR UPDATE;
    IF c.state<>'pending' THEN CONTINUE; END IF;
    BEGIN
      IF r ? 'skip' THEN
        UPDATE migration_job_chunks SET state='skipped',receipt=jsonb_build_object('reason',r->>'skip') WHERE id=c.id;
        CONTINUE;
      END IF;
      IF r ? 'error' THEN RAISE EXCEPTION '%',r->>'error'; END IF;
      IF c.resource IN ('customers','suppliers') THEN
        target:=resolve_provider_migration_party(j.id,c.resource,c.source_id,r->'row');
        UPDATE migration_job_chunks SET state='done',target_id=target,receipt='{"imported":true}' WHERE id=c.id;
        CONTINUE;
      END IF;
      tbl:=CASE c.resource WHEN 'salesInvoices' THEN 'invoices' ELSE 'supplier_invoices' END;
      SELECT target_id INTO target FROM migration_source_records WHERE company_id=j.company_id AND provider=j.provider
        AND account_key=j.account_key AND resource=c.resource AND source_id=c.source_id;
      was_new:=false;
      reused:=false;
      party:=NULL;
      -- A sales invoice number is unique per company: it is the record's own
      -- identity. Adopt on it, never on the customer the job derived for it.
      IF target IS NULL AND c.resource='salesInvoices' AND NULLIF(r->'row'->>'invoice_number','') IS NOT NULL THEN
        SELECT * INTO legacy FROM invoices WHERE company_id=j.company_id AND invoice_number=r->'row'->>'invoice_number'
          FOR UPDATE;
        IF FOUND THEN
          IF legacy.invoice_date IS DISTINCT FROM (r->'row'->>'invoice_date')::date
            OR legacy.currency IS DISTINCT FROM r->'row'->>'currency'
            OR legacy.total IS DISTINCT FROM (r->'row'->>'total')::numeric THEN
            RAISE EXCEPTION 'MIGRATION_INVOICE_NUMBER_TAKEN';
          END IF;
          IF EXISTS(SELECT 1 FROM migration_source_records WHERE company_id=j.company_id AND provider=j.provider
            AND account_key=j.account_key AND resource=c.resource AND target_id=legacy.id AND source_id<>c.source_id) THEN
            RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS'; END IF;
          IF legacy.customer_id IS NOT NULL THEN
            party:=adopt_provider_migration_invoice_party(j.id,r->>'party_source_id',legacy.customer_id);
          END IF;
          target:=legacy.id;
          INSERT INTO migration_source_records(company_id,user_id,provider,account_key,resource,source_id,target_id)
            VALUES(j.company_id,j.user_id,j.provider,j.account_key,c.resource,c.source_id,target);
        END IF;
      END IF;
      IF party IS NULL THEN
        party:=resolve_provider_migration_party(j.id,
          CASE c.resource WHEN 'salesInvoices' THEN 'customers' ELSE 'suppliers' END,r->>'party_source_id',r->'party');
      END IF;
      row_data:=r->'row'||jsonb_build_object('company_id',j.company_id,'user_id',j.user_id,
        CASE c.resource WHEN 'salesInvoices' THEN 'customer_id' ELSE 'supplier_id' END,party);
      -- Fortnox numbers its supplier invoices itself (löpnummer, the chunk's
      -- source id), apart from the number the supplier printed. The row keeps
      -- it in fortnox_number, and a Fortnox record is recognised by it before
      -- anything else (crm#1157).
      fortnox:=CASE WHEN j.provider='fortnox' AND c.resource='supplierInvoices'
        AND NULLIF(btrim(c.source_id),'') IS NOT NULL AND c.source_id NOT LIKE 'missing:%' THEN btrim(c.source_id) END;
      IF fortnox IS NOT NULL THEN
        row_data:=row_data||jsonb_build_object('fortnox_number',fortnox);
        IF target IS NULL THEN
          SELECT id INTO target FROM supplier_invoices WHERE company_id=j.company_id AND fortnox_number=fortnox;
        END IF;
        -- An import from before fortnox_number holds the löpnummer as its
        -- supplier number: the same supplier, number and header is that
        -- invoice. The same supplier and number on another header is refused,
        -- never guessed at: it may be that invoice edited here, or another one.
        IF target IS NULL THEN
          SELECT array_agg(id) INTO ids FROM (SELECT id FROM supplier_invoices WHERE company_id=j.company_id
            AND supplier_id=party AND fortnox_number IS NULL AND supplier_invoice_number=fortnox LIMIT 2) earlier;
          IF cardinality(ids)>1 THEN RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS'; END IF;
          IF ids[1] IS NOT NULL THEN
            IF NOT EXISTS(SELECT 1 FROM supplier_invoices WHERE id=ids[1]
              AND invoice_date=(row_data->>'invoice_date')::date AND currency=row_data->>'currency'
              AND total=(row_data->>'total')::numeric
              AND is_credit_note=COALESCE((row_data->>'is_credit_note')::boolean,false)) THEN
              RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS';
            END IF;
            target:=ids[1];
          END IF;
        END IF;
        IF target IS NOT NULL AND NOT EXISTS(SELECT 1 FROM migration_source_records WHERE company_id=j.company_id
          AND provider=j.provider AND account_key=j.account_key AND resource=c.resource AND source_id=c.source_id) THEN
          IF EXISTS(SELECT 1 FROM migration_source_records WHERE company_id=j.company_id AND provider=j.provider
            AND account_key=j.account_key AND resource=c.resource AND target_id=target AND source_id<>c.source_id) THEN
            RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS'; END IF;
          INSERT INTO migration_source_records(company_id,user_id,provider,account_key,resource,source_id,target_id)
            VALUES(j.company_id,j.user_id,j.provider,j.account_key,c.resource,c.source_id,target);
        END IF;
      END IF;
      IF target IS NULL THEN
        -- Supplier invoice numbers are unique per supplier only: adopt on
        -- supplier AND number AND date/currency/total/kind. Number-less records
        -- are identified exclusively by their source map.
        EXECUTE format('SELECT array_agg(id) FROM (SELECT id FROM public.%I WHERE company_id=$1
          AND %I=$2->>%L AND %I=($2->>%L)::uuid AND invoice_date=($2->>''invoice_date'')::date
          AND currency=$2->>''currency'' AND total=($2->>''total'')::numeric %s LIMIT 2) matches',
          tbl,CASE c.resource WHEN 'salesInvoices' THEN 'invoice_number' ELSE 'supplier_invoice_number' END,
          CASE c.resource WHEN 'salesInvoices' THEN 'invoice_number' ELSE 'supplier_invoice_number' END,
          CASE c.resource WHEN 'salesInvoices' THEN 'customer_id' ELSE 'supplier_id' END,
          CASE c.resource WHEN 'salesInvoices' THEN 'customer_id' ELSE 'supplier_id' END,
          CASE WHEN c.resource='supplierInvoices' THEN 'AND is_credit_note=COALESCE(($2->>''is_credit_note'')::boolean,false)' ELSE '' END)
          INTO ids USING j.company_id,row_data;
        IF cardinality(ids)>1 THEN RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS'; END IF;
        target:=ids[1];
        -- An invoice stored by the reused-number rule below has no number and
        -- the source number as payment_reference: the same header is the same
        -- invoice on a run that has lost its source map.
        IF target IS NULL AND c.resource='supplierInvoices'
          AND NULLIF(row_data->>'supplier_invoice_number','') IS NOT NULL THEN
          SELECT array_agg(id) INTO ids FROM (SELECT id FROM supplier_invoices WHERE company_id=j.company_id
            AND supplier_id=party AND supplier_invoice_number IS NULL
            AND payment_reference=row_data->>'supplier_invoice_number'
            AND invoice_date=(row_data->>'invoice_date')::date AND currency=row_data->>'currency'
            AND total=(row_data->>'total')::numeric
            AND is_credit_note=COALESCE((row_data->>'is_credit_note')::boolean,false) LIMIT 2) moved;
          IF cardinality(ids)>1 THEN RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS'; END IF;
          target:=ids[1];
        END IF;
        -- No invoice on the resolved card is this Fortnox record. An import
        -- from before fortnox_number may hold it on another card: that import
        -- put an invoice on the card with the org number the invoice gives,
        -- else on the card with the name it gives (one it made when none had
        -- it), never by Fortnox's supplier number, and it kept the löpnummer
        -- as the supplier number. The löpnummer is the company's own series at
        -- Fortnox, and only the same header makes an invoice holding it this
        -- record, as repair_fortnox_supplier_invoice_numbers reads it. Such an
        -- invoice is adopted only when no verifikat and no payment is tied to
        -- it (that import booked none; one registered here is booked when it
        -- is registered, or when it is paid) and it sits on a card that names
        -- the record's supplier: its org number (the one the invoice gives,
        -- else the one the resolved card has from Fortnox's register), or the
        -- name the invoice gives with no other org number. Any other may be
        -- another invoice, and two cannot be told apart: both are refused for
        -- a person, never guessed at and never stored twice.
        IF target IS NULL AND fortnox IS NOT NULL THEN
          SELECT array_agg(id) INTO ids FROM (SELECT id FROM supplier_invoices WHERE company_id=j.company_id
            AND fortnox_number IS NULL AND supplier_invoice_number=fortnox
            AND invoice_date=(row_data->>'invoice_date')::date AND currency=row_data->>'currency'
            AND total=(row_data->>'total')::numeric
            AND is_credit_note=COALESCE((row_data->>'is_credit_note')::boolean,false) LIMIT 2 FOR UPDATE) elsewhere;
          IF cardinality(ids)>1 THEN RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS'; END IF;
          IF ids[1] IS NOT NULL AND NOT EXISTS(SELECT 1 FROM supplier_invoices si JOIN suppliers s ON s.id=si.supplier_id
            CROSS JOIN LATERAL (SELECT COALESCE(public.party_org_key(r->'party'->>'org_number'),
              (SELECT public.party_org_key(p.org_number) FROM suppliers p WHERE p.id=party)) AS org_key) named
            WHERE si.id=ids[1] AND si.registration_journal_entry_id IS NULL AND si.payment_journal_entry_id IS NULL
              AND NOT EXISTS(SELECT 1 FROM supplier_invoice_payments pay WHERE pay.supplier_invoice_id=si.id)
              AND (public.party_org_key(s.org_number)=named.org_key
                OR (NULLIF(lower(btrim(regexp_replace(s.name,'\s+',' ','g'))),'')=lower(btrim(regexp_replace(r->'party'->>'name','\s+',' ','g')))
                  AND (public.party_org_key(s.org_number) IS NULL OR named.org_key IS NULL)))) THEN
            RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS';
          END IF;
          target:=ids[1];
        END IF;
        IF target IS NOT NULL AND EXISTS(SELECT 1 FROM migration_source_records
          WHERE company_id=j.company_id AND provider=j.provider AND account_key=j.account_key
            AND resource=c.resource AND target_id=target AND source_id<>c.source_id) THEN
          RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS'; END IF;
        IF target IS NULL THEN
          IF c.resource='supplierInvoices' THEN
            -- Mirror idx_supplier_invoices_company_supplier_number: a live
            -- same-supplier number that did not match is a named conflict.
            IF NULLIF(row_data->>'supplier_invoice_number','') IS NOT NULL
              AND COALESCE(row_data->>'status','') NOT IN ('credited','reversed')
              AND EXISTS(SELECT 1 FROM supplier_invoices WHERE company_id=j.company_id AND supplier_id=party
                AND supplier_invoice_number=row_data->>'supplier_invoice_number'
                AND status NOT IN ('credited','reversed')) THEN
              -- A number the supplier puts on every invoice (an autogiro or
              -- contract reference, crm#1039): another invoice date makes it
              -- another invoice. It is stored without a number, the reference
              -- kept as its payment_reference. The same number and date (also
              -- against an invoice stored this way), or another payment
              -- reference already on the record, stays a refusal.
              IF EXISTS(SELECT 1 FROM supplier_invoices WHERE company_id=j.company_id AND supplier_id=party
                  AND status NOT IN ('credited','reversed') AND invoice_date=(row_data->>'invoice_date')::date
                  AND (supplier_invoice_number=row_data->>'supplier_invoice_number'
                    OR (supplier_invoice_number IS NULL AND payment_reference=row_data->>'supplier_invoice_number')))
                OR (NULLIF(row_data->>'payment_reference','') IS NOT NULL
                  AND row_data->>'payment_reference'<>row_data->>'supplier_invoice_number') THEN
                RAISE EXCEPTION 'MIGRATION_INVOICE_NUMBER_TAKEN';
              END IF;
              row_data:=row_data||jsonb_build_object('supplier_invoice_number',NULL,
                'payment_reference',row_data->>'supplier_invoice_number');
              reused:=true;
            END IF;
            row_data:=row_data||jsonb_build_object('arrival_number',get_next_arrival_number(j.company_id));
          END IF;
          target:=insert_provider_migration_row(tbl,row_data);
          was_new:=true;
        END IF;
        INSERT INTO migration_source_records(company_id,user_id,provider,account_key,resource,source_id,target_id)
          VALUES(j.company_id,j.user_id,j.provider,j.account_key,c.resource,c.source_id,target);
      END IF;
      -- A stored invoice taken for a Fortnox record carries its löpnummer from
      -- now on; one that carries another löpnummer is not this record.
      IF fortnox IS NOT NULL AND NOT was_new THEN
        IF EXISTS(SELECT 1 FROM supplier_invoices WHERE id=target AND fortnox_number<>fortnox) THEN
          RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS'; END IF;
        UPDATE supplier_invoices SET fortnox_number=fortnox
          WHERE id=target AND company_id=j.company_id AND fortnox_number IS NULL;
      END IF;
      -- Never fill a native/adopted document with rows for a different amount.
      EXECUTE format('SELECT array_agg(id) FROM public.%I WHERE id=$1 AND company_id=$2
        AND total=($3->>''total'')::numeric AND currency=$3->>''currency''',tbl) INTO ids USING target,j.company_id,row_data;
      IF ids IS NULL THEN RAISE EXCEPTION 'MIGRATION_INVOICE_CHANGED'; END IF;
      IF jsonb_array_length(r->'items')>0 THEN
        IF c.resource='salesInvoices' THEN
          row_result:=complete_invoice_rows(j.company_id,target,r->'items',
            CASE WHEN COALESCE((r->'warnings'->>'vatUnresolved')::boolean,false) THEN NULL ELSE
              jsonb_build_object('subtotal',row_data->'subtotal','subtotal_sek',row_data->'subtotal_sek',
                'vat_amount',row_data->'vat_amount','vat_amount_sek',row_data->'vat_amount_sek',
                'vat_rate',row_data->'vat_rate','vat_treatment',row_data->'vat_treatment') END);
          IF NOT COALESCE((row_result->>'ok')::boolean,false) THEN RAISE EXCEPTION '%',row_result->>'code'; END IF;
          IF (row_result->>'wrote')::boolean THEN
            INSERT INTO processing_history(company_id,correlation_id,aggregate_type,aggregate_id,event_type,payload,actor,occurred_at)
            VALUES(j.company_id,j.id,'Invoice',target,'InvoiceRowsCompleted',
              jsonb_build_object('source','provider-migration-worker','provider',j.provider,'consent_id',j.consent_id,
                'rows',jsonb_array_length(r->'items'),'header_updated',row_result->'header_updated'),
              jsonb_build_object('type','user','id',j.user_id),clock_timestamp());
          END IF;
        ELSE
          PERFORM 1 FROM supplier_invoices WHERE id=target AND company_id=j.company_id FOR UPDATE;
          IF NOT EXISTS(SELECT 1 FROM supplier_invoice_items WHERE supplier_invoice_id=target) THEN
            IF was_new AND NOT COALESCE((r->'warnings'->>'vatUnresolved')::boolean,false) THEN
              UPDATE supplier_invoices SET subtotal=(row_data->>'subtotal')::numeric,
                subtotal_sek=(row_data->>'subtotal_sek')::numeric,vat_amount=(row_data->>'vat_amount')::numeric,
                vat_amount_sek=(row_data->>'vat_amount_sek')::numeric,vat_treatment=row_data->>'vat_treatment'
                WHERE id=target AND company_id=j.company_id;
            END IF;
            FOR item IN SELECT value FROM jsonb_array_elements(r->'items') LOOP
              PERFORM insert_provider_migration_row('supplier_invoice_items',item||jsonb_build_object('supplier_invoice_id',target));
            END LOOP;
          END IF;
        END IF;
      END IF;
      UPDATE migration_job_chunks SET target_id=target,state='imported',
        receipt=jsonb_build_object('imported',was_new,'link',r->'link','warnings',CASE WHEN reused
          THEN CASE WHEN jsonb_typeof(r->'warnings')='object' THEN r->'warnings' ELSE '{}'::jsonb END
            ||'{"numberAsPaymentReference":true}'::jsonb
          ELSE r->'warnings' END) WHERE id=c.id;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
      -- Codes only: Postgres constraint errors can contain source personal data.
      UPDATE migration_job_chunks SET state='needs_attention',error_phase='import',
        error_code=CASE WHEN message LIKE 'MIGRATION_%' THEN split_part(message,E'\n',1) ELSE SQLSTATE END WHERE id=c.id;
    END;
  END LOOP;
  UPDATE migration_jobs SET failures=0,error_code=NULL WHERE id=j.id;
END $$;

NOTIFY pgrst, 'reload schema';
