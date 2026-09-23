-- provider_migration_counts derives the credit-note link counts from the
-- invoice rows (migration 20260920190600, #2789). Every fixture and mutation
-- is rolled back. Run only against an already migrated test database.
BEGIN;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid();
  worker uuid:=gen_random_uuid(); j public.migration_jobs;
  original uuid; linked uuid; unresolved uuid; noref uuid; original_row uuid; linked_row uuid;
  base jsonb; credit jsonb; unlinked bigint; paired bigint; n bigint;
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000'),
    (outsider,outsider||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Credit note counts','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner');
  INSERT INTO provider_consents(id,company_id,name,provider,org_number) VALUES(consent,company,'Credit note counts','fortnox','556000-0000');
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES(consent,'fortnox','not-a-real-token');
  INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status)
    VALUES(company,u,'test.se',md5(company::text),4,'completed');
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;

  j:=create_provider_migration_job(company,u,consent,ARRAY['salesInvoices'],NULL);
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'salesInvoices',1,
    '[{"source_id":"1038","payload":"cipher","payload_hash":"hash"},{"source_id":"1043","payload":"cipher","payload_hash":"hash"},
      {"source_id":"1044","payload":"cipher","payload_hash":"hash"},{"source_id":"1045","payload":"cipher","payload_hash":"hash"}]',NULL);
  SELECT id INTO original FROM migration_job_chunks WHERE job_id=j.id AND source_id='1038';
  SELECT id INTO linked FROM migration_job_chunks WHERE job_id=j.id AND source_id='1043';
  SELECT id INTO unresolved FROM migration_job_chunks WHERE job_id=j.id AND source_id='1044';
  SELECT id INTO noref FROM migration_job_chunks WHERE job_id=j.id AND source_id='1045';

  base:=jsonb_build_object('id',original,'party_source_id','12','party',jsonb_build_object('name','Kund AB'),
    'row',jsonb_build_object('invoice_number','1038','document_type','invoice','invoice_date','2026-03-01','due_date','2026-03-31',
      'currency','SEK','subtotal',1000,'subtotal_sek',1000,'vat_amount',250,'vat_amount_sek',250,'total',1250,'total_sek',1250,
      'vat_treatment','standard_25','vat_rate',25,'status','paid','paid_amount',1250,'remaining_amount',0),
    'items','[{"sort_order":1,"description":"Konsulttimmar","quantity":2,"unit_price":500,"line_total":1000,"vat_rate":25,"vat_amount":250,"line_type":"product"}]'::jsonb,
    'link',jsonb_build_object('kind','customer','invoiceDate','2026-03-01','totalSek',1250,'invoiceNumber','1038','creditedInvoiceRef',NULL),
    'warnings',jsonb_build_object('fxUnresolved',false,'vatUnresolved',false,'creditNoteUnlinked',false));
  -- A kreditfaktura as the importer writes it: reversed amounts, terminal
  -- status, nothing collected. Each one credits half of the original, the
  -- partial credit ML 17 kap 22-23 SS permits.
  credit:=base||jsonb_build_object(
    'row',(base->'row')||jsonb_build_object('invoice_date','2026-03-10','due_date','2026-04-09','subtotal',-500,'subtotal_sek',-500,
      'vat_amount',-125,'vat_amount_sek',-125,'total',-625,'total_sek',-625,'status','credited','paid_amount',0),
    'items','[{"sort_order":1,"description":"Konsulttimmar","quantity":-1,"unit_price":500,"line_total":-500,"vat_rate":25,"vat_amount":-125,"line_type":"product"}]'::jsonb);

  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    base,
    -- names an invoice this job imports
    credit||jsonb_build_object('id',linked,'row',(credit->'row')||jsonb_build_object('invoice_number','1043'),
      'link',(base->'link')||jsonb_build_object('invoiceNumber','1043','totalSek',-625,
        'creditedInvoiceRef',jsonb_build_object('id','1038','invoiceNumber','1038'))),
    -- names an invoice that is not among the imported ones
    credit||jsonb_build_object('id',unresolved,'row',(credit->'row')||jsonb_build_object('invoice_number','1044'),
      'link',(base->'link')||jsonb_build_object('invoiceNumber','1044','totalSek',-625,
        'creditedInvoiceRef',jsonb_build_object('id','977','invoiceNumber','977'))),
    -- the provider sent no reference: flagged at import
    credit||jsonb_build_object('id',noref,'row',(credit->'row')||jsonb_build_object('invoice_number','1045'),
      'link',(base->'link')||jsonb_build_object('invoiceNumber','1045','totalSek',-625),
      'warnings',(base->'warnings')||jsonb_build_object('creditNoteUnlinked',true))));
  SELECT count(*) INTO n FROM migration_job_chunks WHERE job_id=j.id AND state='imported';
  ASSERT n=4,'fixture invoices were not imported: '||(SELECT string_agg(coalesce(error_code,'-'),',') FROM migration_job_chunks WHERE job_id=j.id);

  -- Before the link phase a referenced credit note is not unlinked, it is
  -- not yet paired: only the reference-less one counts.
  SELECT credit_notes_unlinked,credit_notes_linked INTO unlinked,paired FROM provider_migration_counts(j.id);
  ASSERT unlinked=1 AND paired=0,format('before link: unlinked=%s linked=%s',unlinked,paired);

  -- The link phase: the worker pairs what it can resolve
  -- (pairMigratedCreditNotes), then commits the follow-up.
  PERFORM advance_provider_migration_job(j.id,worker,j.attempt);
  SELECT target_id INTO original_row FROM migration_job_chunks WHERE id=original;
  SELECT target_id INTO linked_row FROM migration_job_chunks WHERE id=linked;
  UPDATE invoices SET credited_invoice_id=original_row WHERE id=linked_row AND company_id=company AND credited_invoice_id IS NULL;
  PERFORM commit_provider_migration_followup(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',original),jsonb_build_object('id',linked),
    jsonb_build_object('id',unresolved),jsonb_build_object('id',noref)));
  SELECT count(*) INTO n FROM migration_job_chunks WHERE job_id=j.id AND state='done';
  ASSERT n=4,'link phase did not complete the sales invoices';

  -- The referenced credit note whose original was never imported is now
  -- counted beside the reference-less one; the paired one is reported linked.
  SELECT credit_notes_unlinked,credit_notes_linked INTO unlinked,paired FROM provider_migration_counts(j.id);
  ASSERT unlinked=2,format('unresolved reference not counted: unlinked=%s',unlinked);
  ASSERT paired=1,format('paired credit note not reported: linked=%s',paired);

  -- The count follows the row. Pairing the second half by hand moves it across.
  UPDATE invoices SET credited_invoice_id=original_row
    WHERE id=(SELECT target_id FROM migration_job_chunks WHERE id=unresolved) AND company_id=company;
  SELECT credit_notes_unlinked,credit_notes_linked INTO unlinked,paired FROM provider_migration_counts(j.id);
  ASSERT unlinked=1 AND paired=2,format('count did not follow the row: unlinked=%s linked=%s',unlinked,paired);

  -- A third half would over-credit the original. The schema refuses the pair
  -- (enforce_credit_note_total_within_original), the worker leaves the row
  -- unpaired on that verdict, and the count keeps saying so.
  BEGIN
    UPDATE invoices SET credited_invoice_id=original_row
      WHERE id=(SELECT target_id FROM migration_job_chunks WHERE id=noref) AND company_id=company;
    RAISE EXCEPTION 'TEST: over-crediting pair accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  SELECT credit_notes_unlinked,credit_notes_linked INTO unlinked,paired FROM provider_migration_counts(j.id);
  ASSERT unlinked=1 AND paired=2,format('refused pair changed the counts: unlinked=%s linked=%s',unlinked,paired);

  -- SECURITY INVOKER: a member reads the same counts through RLS on both
  -- tables, an outsider reads nothing, and the grants are unchanged.
  ASSERT has_function_privilege('authenticated','public.provider_migration_counts(uuid)','EXECUTE'),'member lost the counts';
  ASSERT NOT has_function_privilege('anon','public.provider_migration_counts(uuid)','EXECUTE'),'anonymous counts allowed';
  RESET ROLE;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',u::text,true);
  SET LOCAL ROLE authenticated;
  SELECT credit_notes_unlinked,credit_notes_linked INTO unlinked,paired FROM provider_migration_counts(j.id);
  ASSERT unlinked=1 AND paired=2,format('member sees different counts: unlinked=%s linked=%s',unlinked,paired);
  RESET ROLE;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',outsider,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',outsider::text,true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM provider_migration_counts(j.id);
  ASSERT n=0,'foreign job counts visible';
  RESET ROLE;
END $$;
SELECT 'provider migration credit-note link counts passed' AS result;
ROLLBACK;
