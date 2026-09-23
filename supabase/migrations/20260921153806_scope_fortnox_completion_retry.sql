-- pg-test: covered-by tests/pg/invoice-completion-recovery.pg.test.ts
-- A definitive failure blocks company work without changing invoice outcomes.
-- Retry only that block; independent invoice failure timers remain intact.
CREATE OR REPLACE FUNCTION public.retry_invoice_completion_work(p_company_id uuid,p_consent_id uuid,p_block_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public SET statement_timeout='8s' SET lock_timeout='1s' AS $$
DECLARE expiry timestamptz; n integer;
BEGIN
  SELECT t.token_expires_at INTO expiry FROM provider_consent_tokens t JOIN provider_consents c ON c.id=t.consent_id
    WHERE c.id=p_consent_id AND c.company_id=p_company_id AND c.status=1 AND c.provider='fortnox' FOR UPDATE OF t;
  IF NOT FOUND THEN RETURN false; END IF;
  -- Do not clear a licence block into work the age gate can never claim.
  IF expiry<now()-interval '45 days' THEN RAISE EXCEPTION 'PROVIDER_AUTH_EXPIRED'; END IF;
  UPDATE invoice_completion_work SET block_reason=NULL,blocked_revision=NULL,blocked_at=NULL,block_id=NULL,
    worker_id=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()
    WHERE company_id=p_company_id AND consent_id=p_consent_id AND block_id=p_block_id
      AND block_reason IN ('PROVIDER_LICENSE_MISSING','PROVIDER_RESOURCE_FORBIDDEN');
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n=1;
END $$;

NOTIFY pgrst,'reload schema';
