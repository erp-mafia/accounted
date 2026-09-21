-- Synthetic records only. The caller rolls this transaction back.
DO $$
DECLARE
  u uuid:=gen_random_uuid(); co uuid:=gen_random_uuid(); healthy uuid:=gen_random_uuid();
  consent uuid:=gen_random_uuid(); healthy_consent uuid:=gen_random_uuid(); renewed uuid:=gen_random_uuid();
  customer uuid:=gen_random_uuid(); healthy_customer uuid:=gen_random_uuid(); invoice uuid:=gen_random_uuid(); healthy_invoice uuid:=gen_random_uuid();
  worker uuid:=gen_random_uuid(); old_worker uuid; revision uuid; old_revision uuid; block uuid; scan uuid;
  w invoice_completion_work; excluded uuid[];
BEGIN
  ASSERT NOT has_function_privilege('authenticated','block_invoice_completion_work(uuid,uuid,uuid,uuid,text)','EXECUTE');
  ASSERT NOT has_function_privilege('authenticated','retry_invoice_completion_work(uuid,uuid,uuid)','EXECUTE');
  ASSERT NOT has_function_privilege('anon','invoice_completion_block_status(uuid)','EXECUTE');
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,'recovery-'||u||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(co,'Synthetic recovery','aktiebolag',u),(healthy,'Synthetic healthy','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(co,u,'owner'),(healthy,u,'owner');
  INSERT INTO customers(id,user_id,company_id,name,customer_type) VALUES(customer,u,co,'Synthetic customer','swedish_business'),(healthy_customer,u,healthy,'Synthetic healthy customer','swedish_business');
  INSERT INTO provider_consents(id,company_id,name,status,provider,org_number) VALUES
    (consent,co,'Synthetic consent',1,'fortnox','synthetic-account'),(healthy_consent,healthy,'Synthetic healthy',1,'fortnox','synthetic-healthy');
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token,refresh_token,token_expires_at) VALUES
    (consent,'fortnox','synthetic-old','synthetic-refresh',now()-interval '1 hour'),
    (healthy_consent,'fortnox','synthetic-healthy','synthetic-refresh',now()+interval '1 hour');
  INSERT INTO invoices(id,user_id,company_id,customer_id,invoice_number,document_type,invoice_date,due_date,
    currency,subtotal,vat_amount,total,vat_treatment,vat_rate,status)
  VALUES(invoice,u,co,customer,'recovery-source','invoice','2026-09-01','2026-10-01','SEK',100,25,125,'standard_25',25,'sent');
  -- This invoice only establishes eligibility; it never writes to the ledger.
  INSERT INTO invoices(id,user_id,company_id,customer_id,invoice_number,document_type,invoice_date,due_date,
    currency,subtotal,vat_amount,total,vat_treatment,vat_rate,status)
  VALUES(healthy_invoice,u,healthy,healthy_customer,'healthy-source','invoice','2026-09-01','2026-10-01','SEK',100,25,125,'standard_25',25,'sent');
  SET LOCAL ROLE service_role;
  PERFORM enqueue_invoice_completion_work();
  SELECT COALESCE(array_agg(company_id),'{}') INTO excluded FROM invoice_completion_work WHERE company_id<>co;
  w:=claim_invoice_completion_work(worker,excluded); scan:=w.scan_id;
  SELECT credential_revision INTO revision FROM provider_consent_tokens WHERE consent_id=consent;
  old_revision:=revision;
  ASSERT block_invoice_completion_work(co,worker,consent,revision,'PROVIDER_AUTH_EXPIRED'),'record definitive failure';
  ASSERT (invoice_completion_block_status(co)->>'reason')='PROVIDER_AUTH_EXPIRED','block is visible';
  w:=claim_invoice_completion_work(gen_random_uuid(),excluded);
  ASSERT w.company_id IS NULL,'later scheduled runs skip the blocked connection';
  PERFORM enqueue_invoice_completion_work();
  ASSERT (SELECT block_reason='PROVIDER_AUTH_EXPIRED' FROM invoice_completion_work WHERE company_id=co),'enqueue does not clear blocks';

  -- Failure first, successful refresh/reconnect second.
  UPDATE provider_consent_tokens SET access_token='synthetic-new',refresh_token='synthetic-new-refresh',token_expires_at=now()+interval '1 hour'
    WHERE consent_id=consent;
  SELECT credential_revision INTO revision FROM provider_consent_tokens WHERE consent_id=consent;
  ASSERT revision<>old_revision,'replacement credentials have a new revision';
  ASSERT invoice_completion_block_status(co) IS NULL,'success removes the obsolete authorization block';
  old_worker:=worker; worker:=gen_random_uuid();
  w:=claim_invoice_completion_work(worker,excluded);
  ASSERT w.company_id=co AND w.scan_id=scan,'resume the same saved discovery';
  ASSERT NOT block_invoice_completion_work(co,old_worker,consent,old_revision,'PROVIDER_AUTH_EXPIRED'),'late old failure cannot overwrite reconnect';
  ASSERT NOT block_invoice_completion_work(co,worker,consent,old_revision,'PROVIDER_AUTH_EXPIRED'),'revision mismatch cannot block even a current worker';

  ASSERT block_invoice_completion_work(co,worker,consent,revision,'PROVIDER_LICENSE_MISSING');
  SELECT block_id INTO block FROM invoice_completion_work WHERE company_id=co;
  UPDATE provider_consent_tokens SET access_token='synthetic-rotated' WHERE consent_id=consent;
  ASSERT (invoice_completion_block_status(co)->>'reason')='PROVIDER_LICENSE_MISSING','ordinary token rotation does not restore a licence';
  ASSERT NOT retry_invoice_completion_work(healthy,consent,block),'company boundary';
  ASSERT NOT retry_invoice_completion_work(co,consent,gen_random_uuid()),'stale screen cannot clear a newer block';
  ASSERT retry_invoice_completion_work(co,consent,block),'explicit retry clears licence block';
  ASSERT NOT retry_invoice_completion_work(co,consent,block),'retry is consumed once';
  old_worker:=worker; worker:=gen_random_uuid();
  w:=claim_invoice_completion_work(worker,excluded);
  ASSERT w.company_id=co AND w.scan_id=scan,'licence retry keeps progress';
  SELECT credential_revision INTO revision FROM provider_consent_tokens WHERE consent_id=consent;
  ASSERT NOT block_invoice_completion_work(co,old_worker,consent,revision,'PROVIDER_LICENSE_MISSING'),'old attempt cannot reblock a retry with unchanged credentials';

  PERFORM release_invoice_completion_work(co,worker,7200);
  w:=claim_invoice_completion_work(gen_random_uuid(),excluded);
  ASSERT w.company_id IS NULL,'temporary retry respects its delay';
  UPDATE invoice_completion_work SET next_attempt_at=now() WHERE company_id=co;
  worker:=gen_random_uuid(); w:=claim_invoice_completion_work(worker,excluded);
  ASSERT block_invoice_completion_work(co,worker,consent,revision,'PROVIDER_RESOURCE_FORBIDDEN');
  SELECT COALESCE(array_agg(company_id),'{}') INTO excluded FROM invoice_completion_work WHERE company_id NOT IN(co,healthy);
  w:=claim_invoice_completion_work(gen_random_uuid(),excluded);
  ASSERT w.company_id=healthy,'a blocked company does not prevent healthy work';

  INSERT INTO provider_consents(id,company_id,name,status,provider,org_number,created_at)
    VALUES(renewed,co,'Synthetic renewed',1,'fortnox','synthetic-account',clock_timestamp()+interval '1 second');
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES(renewed,'fortnox','synthetic-renewed');
  SELECT COALESCE(array_agg(company_id),'{}') INTO excluded FROM invoice_completion_work WHERE company_id<>co;
  w:=claim_invoice_completion_work(gen_random_uuid(),excluded);
  ASSERT w.company_id=co AND w.consent_id=renewed AND w.scan_id=scan,'a replacement consent for the same account resumes saved work';
  ASSERT w.block_reason IS NULL,'old consent block cannot exclude a new consent';
END $$;
