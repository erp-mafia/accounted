-- Run inside a transaction and roll back. All identities are synthetic.
-- 20261028042247: an invoice that makes no progress gives up after its 7th
-- try (24th when failed); enqueue marks a company with no candidate idle,
-- the claim then looks only at invoices created since, and the queue order
-- (next_attempt_at) is never changed by the mark.
DO $$
DECLARE
  u uuid:=gen_random_uuid(); co uuid:=gen_random_uuid(); co2 uuid:=gen_random_uuid();
  consent uuid:=gen_random_uuid(); consent2 uuid:=gen_random_uuid(); customer uuid:=gen_random_uuid();
  customer2 uuid:=gen_random_uuid(); a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); busy uuid:=gen_random_uuid();
  late uuid:=gen_random_uuid(); worker uuid; worker2 uuid:=gen_random_uuid();
  w public.invoice_completion_work; r jsonb; excluded uuid[]; n integer; queued_at timestamptz;
BEGIN
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,'completion-end-'||u||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES
    (co,'Synthetic completion end A','aktiebolag',u),(co2,'Synthetic completion end B','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(co,u,'owner'),(co2,u,'owner');
  INSERT INTO customers(id,user_id,company_id,name,customer_type) VALUES
    (customer,u,co,'Synthetic customer','swedish_business'),(customer2,u,co2,'Synthetic customer','swedish_business');
  INSERT INTO provider_consents(id,company_id,name,status,provider,org_number) VALUES
    (consent,co,'Synthetic consent',1,'fortnox','synthetic-end-a'),(consent2,co2,'Synthetic consent',1,'fortnox','synthetic-end-b');
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES
    (consent,'fortnox','synthetic-token'),(consent2,'fortnox','synthetic-token');
  INSERT INTO invoices(id,user_id,company_id,customer_id,invoice_number,document_type,invoice_date,due_date,
    currency,subtotal,vat_amount,total,vat_treatment,vat_rate,status)
  VALUES(a,u,co,customer,'end-a','invoice','2026-09-01','2026-10-01','SEK',1250,0,1250,'standard_25',25,'sent'),
    (b,u,co,customer,'end-b','invoice','2026-09-01','2026-10-01','SEK',1250,0,1250,'standard_25',25,'sent'),
    (busy,u,co2,customer2,'end-busy','invoice','2026-09-01','2026-10-01','SEK',1250,0,1250,'standard_25',25,'sent');

  SET LOCAL ROLE service_role;
  PERFORM enqueue_invoice_completion_work();
  SELECT COALESCE(array_agg(company_id),'{}') INTO excluded FROM invoice_completion_work WHERE company_id NOT IN (co,co2);

  -- Seven tries that are not progress: the seventh parks the invoice for good.
  FOR n IN 1..7 LOOP
    worker:=gen_random_uuid();
    w:=claim_invoice_completion_work(worker,excluded||co2);
    ASSERT w.company_id=co,'company with a due invoice is claimed (try '||n||')';
    r:=finish_invoice_completion(co,worker,a,'provider_empty');
    ASSERT (SELECT attempts=n FROM invoice_completion_entries WHERE company_id=co AND invoice_id=a),'each try counts';
    IF n<7 THEN
      ASSERT r->'gaveUp' IS NULL,'no give-up before the seventh try';
      ASSERT (SELECT next_attempt_at BETWEEN now()+interval '23 hours' AND now()+interval '25 hours'
        FROM invoice_completion_entries WHERE company_id=co AND invoice_id=a),'daily retry before the cap';
      UPDATE invoice_completion_entries SET next_attempt_at=now()-interval '1 second' WHERE company_id=co AND invoice_id=a;
    ELSE
      ASSERT (r->>'gaveUp')::boolean AND (r->>'attempts')::integer=7,'the receipt says it gave up, and after how many tries';
      ASSERT (SELECT next_attempt_at='infinity'::timestamptz AND outcome='provider_empty'
        FROM invoice_completion_entries WHERE company_id=co AND invoice_id=a),'parked for good with its outcome as the reason';
    END IF;
    -- b is answered failed every time: hourly, and far from its cap of 24.
    r:=finish_invoice_completion(co,worker,b,'failed');
    UPDATE invoice_completion_entries SET next_attempt_at=now()-interval '1 second' WHERE company_id=co AND invoice_id=b AND n<7;
    PERFORM release_invoice_completion_work(co,worker);
  END LOOP;
  ASSERT (SELECT attempts=7 AND next_attempt_at<now()+interval '2 hours' AND next_attempt_at<>'infinity'::timestamptz
    FROM invoice_completion_entries WHERE company_id=co AND invoice_id=b),'a failed try keeps the hourly retry below 24';

  -- Give b up too: the company has nothing left to do and is never claimed.
  UPDATE invoice_completion_entries SET attempts=23,next_attempt_at=now()-interval '1 second' WHERE company_id=co AND invoice_id=b;
  worker:=gen_random_uuid();
  w:=claim_invoice_completion_work(worker,excluded||co2);
  ASSERT w.company_id=co,'last try of b';
  r:=finish_invoice_completion(co,worker,b,'failed');
  ASSERT (r->>'gaveUp')::boolean,'24th failed try gives up';
  PERFORM release_invoice_completion_work(co,worker);
  ASSERT claim_invoice_completion_work(gen_random_uuid(),excluded||co2) IS NULL,'a company whose invoices all gave up is not claimed';

  -- enqueue marks the idle company and leaves the busy one alone; the mark
  -- never moves the company in the queue.
  SELECT next_attempt_at INTO queued_at FROM invoice_completion_work WHERE company_id=co;
  PERFORM enqueue_invoice_completion_work();
  ASSERT (SELECT idle_until BETWEEN now()+interval '23 hours' AND now()+interval '25 hours' AND idle_since<=now()
    FROM invoice_completion_work WHERE company_id=co),'a company with no candidate is idle for at most 24 hours';
  ASSERT (SELECT next_attempt_at=queued_at FROM invoice_completion_work WHERE company_id=co),'the idle mark keeps the queue order';
  ASSERT (SELECT idle_until IS NULL AND next_attempt_at<=clock_timestamp() FROM invoice_completion_work WHERE company_id=co2),
    'a company with a candidate is not marked idle';
  w:=claim_invoice_completion_work(worker2,excluded);
  ASSERT w.company_id=co2,'the claim finds the busy company';
  PERFORM release_invoice_completion_work(co2,worker2);

  -- An idle company with an entry due sooner is marked only until then.
  UPDATE invoice_completion_work SET idle_until=NULL,idle_since=NULL WHERE company_id=co;
  UPDATE invoice_completion_entries SET next_attempt_at=clock_timestamp()+interval '2 hours',attempts=1 WHERE company_id=co AND invoice_id=a;
  PERFORM enqueue_invoice_completion_work();
  ASSERT (SELECT idle_until BETWEEN clock_timestamp()+interval '1 hour' AND clock_timestamp()+interval '3 hours'
    FROM invoice_completion_work WHERE company_id=co),'idle only until its earliest entry falls due';
  ASSERT claim_invoice_completion_work(gen_random_uuid(),excluded||co2) IS NULL,'an idle company with nothing new is not claimed';

  -- New work is never held back: an invoice created in an idle company is
  -- claimable at once, in the company's old place ahead of work released
  -- later (co2 was released after co).
  INSERT INTO invoices(id,user_id,company_id,customer_id,invoice_number,document_type,invoice_date,due_date,
    currency,subtotal,vat_amount,total,vat_treatment,vat_rate,status)
  VALUES(late,u,co,customer,'end-late','invoice','2026-09-01','2026-10-01','SEK',1250,0,1250,'standard_25',25,'sent');
  w:=claim_invoice_completion_work(gen_random_uuid(),excluded);
  ASSERT w.company_id=co,'a new invoice wakes the idle company at once, before later released work';
  ASSERT w.idle_until IS NULL AND w.idle_since IS NULL,'the claim clears the idle mark';
END $$;
