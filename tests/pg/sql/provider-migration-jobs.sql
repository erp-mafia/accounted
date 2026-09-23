-- Every fixture and mutation is rolled back. Run only against an already
-- migrated test/staging database; this script does not create a local database.
BEGIN;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid();
  worker uuid:=gen_random_uuid(); other_worker uuid:=gen_random_uuid(); j public.migration_jobs; second public.migration_jobs;
  a uuid; b uuid; bad uuid; target uuid; customer uuid; same_customer uuid; n bigint; rec jsonb; payload jsonb;
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000'),
    (outsider,outsider||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Migration test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner');
  INSERT INTO provider_consents(id,company_id,name,provider,org_number) VALUES(consent,company,'Migration test','visma','556000-0000');
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES(consent,'visma','not-a-real-token');
  INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status)
    VALUES(company,u,'test.se',md5(company::text),4,'completed');
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;

  BEGIN
    PERFORM create_provider_migration_job(company,outsider,consent,ARRAY['customers'],NULL);
    RAISE EXCEPTION 'TEST: nonmember admission succeeded';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'MIGRATION_WRITE_FORBIDDEN' THEN RAISE; END IF; END;
  j:=create_provider_migration_job(company,u,consent,ARRAY['customers'],NULL);
  second:=create_provider_migration_job(company,u,consent,ARRAY['customers'],NULL);
  ASSERT second.id=j.id,'admission retry created another job';
  j:=claim_provider_migration_job(worker,j.id);
  second:=claim_provider_migration_job(other_worker,j.id);
  ASSERT second.id IS NULL,'active lease claimed twice';
  payload:='[{"source_id":"c1","payload":"cipher","payload_hash":"hash"},{"source_id":"c2","payload":"cipher","payload_hash":"hash"}]';
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'customers',1,payload,0);
  -- A lost segment acknowledgement repeats the page safely.
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'customers',1,payload,2);
  SELECT count(*) INTO n FROM migration_job_chunks WHERE job_id=j.id;
  ASSERT n=2,'repeated source IDs duplicated receipts';
  SELECT next_page INTO n FROM migration_jobs WHERE id=j.id;
  ASSERT n=2,'cursor not persisted';
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'customers',2,
    '[{"source_id":"bad","payload":"cipher","payload_hash":"hash"}]',NULL);
  SELECT id INTO a FROM migration_job_chunks WHERE job_id=j.id AND source_id='c1';
  SELECT id INTO b FROM migration_job_chunks WHERE job_id=j.id AND source_id='c2';
  SELECT id INTO bad FROM migration_job_chunks WHERE job_id=j.id AND source_id='bad';
  rec:=jsonb_build_array(jsonb_build_object('id',a,'row',jsonb_build_object('name','First','customer_type','swedish_business')),
    jsonb_build_object('id',bad,'row',jsonb_build_object('name',NULL)),
    jsonb_build_object('id',b,'row',jsonb_build_object('name','Second','customer_type','swedish_business')));
  -- Reclaim an abandoned lease. The stale attempt must not write anything.
  UPDATE migration_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=j.id;
  second:=claim_provider_migration_job(other_worker,j.id);
  BEGIN
    PERFORM commit_provider_migration_records(j.id,worker,j.attempt,rec);
    RAISE EXCEPTION 'TEST: stale attempt wrote';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'MIGRATION_LEASE_LOST' THEN RAISE; END IF; END;
  j:=second; worker:=other_worker;
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,rec);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,rec);
  SELECT count(*) INTO n FROM customers WHERE company_id=company;
  ASSERT n=2,'healthy rows dropped, duplicated, or failed row left a partial write';
  SELECT count(*) INTO n FROM migration_job_chunks WHERE job_id=j.id AND state='needs_attention';
  ASSERT n=1,'bad row did not get an explicit outcome';
  -- A display name is not identity, even when it matches only one party.
  SELECT target_id INTO customer FROM migration_source_records WHERE company_id=company AND source_id='c1';
  same_customer:=resolve_provider_migration_party(j.id,'customers','invoice-party:fallback','{"name":"First","customer_type":"swedish_business"}');
  ASSERT customer<>same_customer,'same-named unidentified party was silently merged';
  ASSERT same_customer=resolve_provider_migration_party(j.id,'customers','invoice-party:fallback','{"name":"First","customer_type":"swedish_business"}'),
    'retry changed the source party identity';
  customer:=resolve_provider_migration_party(j.id,'suppliers','supplier-name-a','{"name":"Same supplier"}');
  same_customer:=resolve_provider_migration_party(j.id,'suppliers','supplier-name-b','{"name":"Same supplier"}');
  ASSERT customer<>same_customer,'distinct supplier IDs merged by name';
  customer:=resolve_provider_migration_party(j.id,'customers','org-party','{"name":"Verified party","org_number":"556000-0000","customer_type":"swedish_business"}');
  same_customer:=resolve_provider_migration_party(j.id,'customers','invoice-party:verified','{"name":"Different display name","org_number":"5560000000","customer_type":"swedish_business"}');
  ASSERT customer=same_customer,'normalized organization identity did not reuse the party';
  FOR n IN 1..4 LOOP PERFORM advance_provider_migration_job(j.id,worker,j.attempt); END LOOP;
  ASSERT (SELECT state='needs_attention' FROM migration_jobs WHERE id=j.id),'failed records falsely marked completed';
  PERFORM retry_provider_migration_job(j.id,company,u);
  j:=claim_provider_migration_job(worker,j.id);
  rec:=jsonb_build_array(jsonb_build_object('id',bad,'row',jsonb_build_object('name','Repaired','customer_type','swedish_business')));
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,rec);
  FOR n IN 1..4 LOOP PERFORM advance_provider_migration_job(j.id,worker,j.attempt); END LOOP;
  ASSERT (SELECT state='completed' FROM migration_jobs WHERE id=j.id),'repaired run did not complete';

  -- Stable provider IDs deduplicate number-less invoices across separate jobs.
  j:=create_provider_migration_job(company,u,consent,ARRAY['salesInvoices'],NULL);
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'salesInvoices',1,
    '[{"source_id":"invoice-no-number","payload":"cipher","payload_hash":"hash"},{"source_id":"invalid-lines","payload":"cipher","payload_hash":"hash"}]',NULL);
  SELECT id INTO a FROM migration_job_chunks WHERE job_id=j.id AND source_id='invoice-no-number';
  SELECT id INTO bad FROM migration_job_chunks WHERE job_id=j.id AND source_id='invalid-lines';
  rec:=jsonb_build_object('id',a,'party_source_id','c1','party',jsonb_build_object('name','First'),
    'row',jsonb_build_object('invoice_number',NULL,'document_type','invoice','invoice_date','2026-01-05','due_date','2026-02-05',
      'currency','SEK','subtotal',100,'subtotal_sek',100,'vat_amount',25,'vat_amount_sek',25,'total',125,'total_sek',125,
      'vat_treatment','standard_25','vat_rate',25,'status','draft'),
    'items','[{"sort_order":1,"description":"Test","quantity":1,"unit_price":100,"line_total":100,"vat_rate":25,"vat_amount":25,"line_type":"product"}]'::jsonb,
    'link',jsonb_build_object('kind','customer','invoiceDate','2026-01-05','totalSek',125));
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec,
    rec||jsonb_build_object('id',bad,'items','[{"description":"invalid"}]'::jsonb)));
  SELECT target_id INTO target FROM migration_job_chunks WHERE id=a;
  ASSERT target IS NOT NULL,'invoice insert failed';
  ASSERT (SELECT state='needs_attention' FROM migration_job_chunks WHERE id=bad),'invalid rows accepted';
  SELECT count(*) INTO n FROM invoices WHERE company_id=company;
  ASSERT n=1,'failed invoice left a header behind';
  SELECT count(*) INTO n FROM processing_history WHERE aggregate_id=target AND event_type='InvoiceRowsCompleted';
  ASSERT n=1,'atomic row completion event missing';
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  SELECT count(*) INTO n FROM invoice_items WHERE invoice_id=target;
  ASSERT n=1,'lost acknowledgement duplicated invoice lines';
  -- Finish the fixture job to model a second import/reconnect of the same ID.
  UPDATE migration_jobs SET state='completed',worker_id=NULL,lease_until=NULL WHERE id=j.id;
  j:=create_provider_migration_job(company,u,consent,ARRAY['salesInvoices'],NULL);
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'salesInvoices',1,
    '[{"source_id":"invoice-no-number","payload":"cipher","payload_hash":"hash"}]',NULL);
  SELECT id INTO a FROM migration_job_chunks WHERE job_id=j.id;
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec||jsonb_build_object('id',a)));
  ASSERT (SELECT target_id=target FROM migration_job_chunks WHERE id=a),'stable source identity changed across jobs';
  SELECT count(*) INTO n FROM invoices WHERE company_id=company;
  ASSERT n=1,'repeat import duplicated number-less invoice';
  SELECT count(*) INTO n FROM processing_history WHERE aggregate_id=target AND event_type='InvoiceRowsCompleted';
  ASSERT n=1,'repeat import duplicated accounting history';

  -- Record pause on consent loss without losing any receipt.
  UPDATE provider_consents SET status=2 WHERE id=consent;
  BEGIN
    PERFORM advance_provider_migration_job(j.id,worker,j.attempt);
    RAISE EXCEPTION 'TEST: revoked connection used';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'PROVIDER_AUTH_EXPIRED' THEN RAISE; END IF; END;
  PERFORM release_provider_migration_job(j.id,worker,j.attempt,'PROVIDER_AUTH_EXPIRED',-1);
  ASSERT (SELECT state='needs_attention' FROM migration_jobs WHERE id=j.id),'auth pause not persisted';
  -- Supplier invoices and credit notes may share a display number; their
  -- provider IDs and credit-note kind must remain distinct.
  UPDATE migration_jobs SET state='completed' WHERE id=j.id;
  UPDATE provider_consents SET status=1 WHERE id=consent;
  j:=create_provider_migration_job(company,u,consent,ARRAY['supplierInvoices'],NULL);
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'supplierInvoices',1,
    '[{"source_id":"supplier-invoice","payload":"cipher","payload_hash":"hash"},{"source_id":"supplier-credit","payload":"cipher","payload_hash":"hash"},{"source_id":"supplier-adopted","payload":"cipher","payload_hash":"hash"}]',NULL);
  SELECT id INTO a FROM migration_job_chunks WHERE job_id=j.id AND source_id='supplier-invoice';
  SELECT id INTO b FROM migration_job_chunks WHERE job_id=j.id AND source_id='supplier-credit';
  rec:=jsonb_build_object('id',a,'party_source_id','supplier-1','party',jsonb_build_object('name','Supplier'),
    'row',jsonb_build_object('supplier_invoice_number','same-number','invoice_date','2026-01-05','due_date','2026-02-05',
      'currency','SEK','subtotal',100,'subtotal_sek',100,'vat_amount',25,'vat_amount_sek',25,'total',125,'total_sek',125,
      'vat_treatment','standard_25','status','registered','remaining_amount',125,'is_credit_note',false),
    'items','[{"sort_order":1,"description":"Test","quantity":1,"unit_price":100,"line_total":100,"account_number":"4000","vat_rate":0.25,"vat_amount":25}]'::jsonb,
    'link',jsonb_build_object('kind','supplier','invoiceDate','2026-01-05','totalSek',125));
  payload:=rec||jsonb_build_object('id',b,'row',(rec->'row')||jsonb_build_object('is_credit_note',true,'status','credited','remaining_amount',0),
    'warnings',jsonb_build_object('creditNoteUnlinked',true));
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec,payload));
  SELECT count(*) INTO n FROM supplier_invoices WHERE company_id=company;
  ASSERT n=2,'credit note was merged with its same-number supplier invoice';
  SELECT count(DISTINCT target_id) INTO n FROM migration_job_chunks WHERE job_id=j.id;
  ASSERT n=2,'supplier source identities were merged';
  SELECT credit_notes_unlinked INTO n FROM provider_migration_counts(j.id);
  ASSERT n=1,'persisted credit-note warning was lost';
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec,payload));
  SELECT count(*) INTO n FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT target_id FROM migration_job_chunks WHERE job_id=j.id);
  ASSERT n=2,'supplier invoice retry duplicated lines';

  -- Adoption may fill missing rows, but must preserve the existing VAT header.
  SELECT supplier_id INTO customer FROM supplier_invoices WHERE id=(SELECT target_id FROM migration_job_chunks WHERE id=a);
  target:=insert_provider_migration_row('supplier_invoices',rec->'row'||jsonb_build_object(
    'company_id',company,'user_id',u,'supplier_id',customer,'arrival_number',get_next_arrival_number(company),
    'supplier_invoice_number','adopted-number','subtotal',125,'subtotal_sek',125,
    'vat_amount',0,'vat_amount_sek',0,'vat_treatment','exempt'));
  SELECT id INTO bad FROM migration_job_chunks WHERE job_id=j.id AND source_id='supplier-adopted';
  payload:=rec||jsonb_build_object('id',bad,'row',(rec->'row')||jsonb_build_object('supplier_invoice_number','adopted-number'));
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(payload));
  ASSERT (SELECT target_id=target AND state='imported' FROM migration_job_chunks WHERE id=bad),
    'matching header-only supplier invoice was not adopted';
  ASSERT (SELECT subtotal=125 AND subtotal_sek=125 AND vat_amount=0 AND vat_amount_sek=0 AND vat_treatment='exempt'
    FROM supplier_invoices WHERE id=target),'adoption overwrote existing supplier VAT fields';
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(payload));
  SELECT count(*) INTO n FROM supplier_invoice_items WHERE supplier_invoice_id=target;
  ASSERT n=1,'adopted supplier rows were missing or duplicated on retry';

  -- Payment matching is planned across ALL batches before any write. Two
  -- independently planned candidates for one voucher both require review.
  PERFORM advance_provider_migration_job(j.id,worker,j.attempt);
  PERFORM commit_provider_migration_followup(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object('id',a),jsonb_build_object('id',b),jsonb_build_object('id',bad)));
  PERFORM advance_provider_migration_job(j.id,worker,j.attempt);
  target:=gen_random_uuid();
  PERFORM commit_provider_migration_followup(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object('id',a,'payment',jsonb_build_object('journal_entry_id',target))));
  PERFORM commit_provider_migration_followup(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object('id',b,'payment',jsonb_build_object('journal_entry_id',target))));
  PERFORM commit_provider_migration_followup(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object('id',bad)));
  PERFORM advance_provider_migration_job(j.id,worker,j.attempt);
  PERFORM commit_provider_migration_followup(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object('id',a)));
  PERFORM commit_provider_migration_followup(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object('id',b)));
  PERFORM commit_provider_migration_followup(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object('id',bad)));
  SELECT count(*) INTO n FROM migration_job_chunks WHERE job_id=j.id AND error_code='MIGRATION_PAYMENT_AMBIGUOUS';
  ASSERT n=2,'cross-batch payment contention picked a winner';
  SELECT count(*) INTO n FROM supplier_invoice_payments WHERE company_id=company;
  ASSERT n=0,'ambiguous matching wrote a payment';
  ASSERT NOT EXISTS(SELECT 1 FROM journal_entries WHERE company_id=company),
    'register import created a journal entry';
  BEGIN
    PERFORM insert_provider_migration_row('journal_entries','{}');
    RAISE EXCEPTION 'TEST: register writer accepted journal_entries';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'MIGRATION_TABLE_FORBIDDEN' THEN RAISE; END IF; END;
  BEGIN
    PERFORM insert_provider_migration_row('journal_entry_lines','{}');
    RAISE EXCEPTION 'TEST: register writer accepted journal_entry_lines';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'MIGRATION_TABLE_FORBIDDEN' THEN RAISE; END IF; END;
  PERFORM advance_provider_migration_job(j.id,worker,j.attempt);
  DELETE FROM provider_consent_tokens WHERE consent_id=consent;
  DELETE FROM provider_consents WHERE id=consent;
  ASSERT (SELECT consent_id IS NULL FROM migration_jobs WHERE id=j.id),'disconnect did not preserve the durable job';
  ASSERT NOT has_function_privilege('authenticated','public.commit_provider_migration_records(uuid,uuid,integer,jsonb)','EXECUTE'), 'client can commit worker records';
  ASSERT NOT has_function_privilege('anon','public.claim_provider_migration_job(uuid,uuid)','EXECUTE'), 'anonymous worker claim allowed';
  RESET ROLE;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',outsider,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',outsider::text,true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM migration_jobs WHERE company_id=company;
  ASSERT n=0,'foreign company jobs visible';
  SELECT count(*) INTO n FROM migration_job_chunks WHERE company_id=company;
  ASSERT n=0,'foreign source payloads visible';
  SELECT count(*) INTO n FROM provider_migration_counts(j.id);
  ASSERT n=0,'foreign job counts visible';
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub',u::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM migration_jobs WHERE company_id=company;
  ASSERT n=4,'member cannot reopen persisted jobs';
  RESET ROLE;
END $$;
SELECT 'provider migration durability, atomicity and RLS assertions passed' AS result;
ROLLBACK;
