-- A credential revision is a non-secret identity, never a token fingerprint.
ALTER TABLE public.provider_consent_tokens ADD COLUMN credential_revision uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.invoice_completion_work
  ADD COLUMN block_reason text CHECK (block_reason IN ('PROVIDER_AUTH_EXPIRED','PROVIDER_LICENSE_MISSING','PROVIDER_RESOURCE_FORBIDDEN')),
  ADD COLUMN blocked_revision uuid,
  ADD COLUMN blocked_at timestamptz,
  ADD COLUMN block_id uuid,
  ADD CONSTRAINT invoice_completion_block_complete CHECK (
    (block_reason IS NULL AND blocked_revision IS NULL AND blocked_at IS NULL AND block_id IS NULL)
    OR (block_reason IS NOT NULL AND blocked_revision IS NOT NULL AND blocked_at IS NOT NULL AND block_id IS NOT NULL));

CREATE FUNCTION public.revise_provider_credentials() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  IF (NEW.access_token,NEW.refresh_token,NEW.token_expires_at,NEW.provider_company_id,NEW.scopes)
    IS DISTINCT FROM (OLD.access_token,OLD.refresh_token,OLD.token_expires_at,OLD.provider_company_id,OLD.scopes) THEN
    NEW.credential_revision:=gen_random_uuid();
  ELSE
    NEW.credential_revision:=OLD.credential_revision;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_credentials_revision BEFORE UPDATE ON public.provider_consent_tokens
  FOR EACH ROW EXECUTE FUNCTION public.revise_provider_credentials();

-- All recovery mutations lock the token row before the work row. A late
-- refresh winner clears an earlier auth block; rotation alone proves nothing
-- about a missing licence, so licence/resource blocks require explicit retry.
CREATE FUNCTION public.resume_invoice_completion_credentials() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  IF NEW.provider='fortnox' AND NEW.credential_revision IS DISTINCT FROM OLD.credential_revision THEN
    UPDATE invoice_completion_work SET block_reason=NULL,blocked_revision=NULL,blocked_at=NULL,block_id=NULL,
      worker_id=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()
    WHERE consent_id=NEW.consent_id AND block_reason='PROVIDER_AUTH_EXPIRED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_completion_credentials_recovered AFTER UPDATE ON public.provider_consent_tokens
  FOR EACH ROW EXECUTE FUNCTION public.resume_invoice_completion_credentials();

CREATE FUNCTION public.block_invoice_completion_work(p_company_id uuid,p_worker_id uuid,p_consent_id uuid,
  p_credential_revision uuid,p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public SET statement_timeout='8s' SET lock_timeout='1s' AS $$
DECLARE revision uuid; n integer;
BEGIN
  IF p_reason NOT IN ('PROVIDER_AUTH_EXPIRED','PROVIDER_LICENSE_MISSING','PROVIDER_RESOURCE_FORBIDDEN') OR p_reason IS NULL THEN
    RAISE EXCEPTION 'INVOICE_COMPLETION_BLOCK_INVALID';
  END IF;
  SELECT t.credential_revision INTO revision FROM provider_consent_tokens t
    JOIN provider_consents c ON c.id=t.consent_id
    WHERE t.consent_id=p_consent_id AND c.company_id=p_company_id AND c.status=1 AND c.provider='fortnox'
    FOR UPDATE OF t;
  IF NOT FOUND OR revision IS DISTINCT FROM p_credential_revision THEN RETURN false; END IF;
  UPDATE invoice_completion_work SET block_reason=p_reason,blocked_revision=revision,
    blocked_at=clock_timestamp(),block_id=gen_random_uuid(),worker_id=NULL,lease_until=NULL
    WHERE company_id=p_company_id AND consent_id=p_consent_id AND worker_id=p_worker_id
      AND lease_until>clock_timestamp();
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n=1;
END $$;

CREATE FUNCTION public.retry_invoice_completion_work(p_company_id uuid,p_consent_id uuid,p_block_id uuid)
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
  -- Previous per-invoice failures from the same connection may also be delayed.
  IF n=1 THEN
    UPDATE invoice_completion_entries SET next_attempt_at=clock_timestamp()
      WHERE company_id=p_company_id AND outcome='failed';
  END IF;
  RETURN n=1;
END $$;

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
    block_reason=NULL,blocked_revision=NULL,blocked_at=NULL,block_id=NULL,
    worker_id=p_worker_id,lease_until=clock_timestamp()+interval '3 minutes'
    WHERE company_id=w.company_id RETURNING * INTO w;
  RETURN w;
END $$;


CREATE FUNCTION public.invoice_completion_block_status(p_company_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public SET statement_timeout='8s' AS $$
  SELECT jsonb_build_object('consentId',w.consent_id,'reason',w.block_reason,'blockId',w.block_id,'blockedAt',w.blocked_at)
  FROM invoice_completion_work w
  WHERE w.company_id=p_company_id AND w.block_reason IS NOT NULL
    AND w.consent_id=(SELECT c.id FROM provider_consents c JOIN provider_consent_tokens t ON t.consent_id=c.id
      WHERE c.company_id=w.company_id AND c.status=1 AND c.provider IS NOT NULL ORDER BY c.created_at DESC,c.id LIMIT 1)
    AND EXISTS(SELECT 1 FROM invoices i WHERE i.company_id=w.company_id AND i.document_type='invoice' AND i.status<>'draft'
      AND NOT EXISTS(SELECT 1 FROM invoice_items ii WHERE ii.invoice_id=i.id));
$$;

REVOKE ALL ON FUNCTION public.revise_provider_credentials(),public.resume_invoice_completion_credentials(),
  public.block_invoice_completion_work(uuid,uuid,uuid,uuid,text),public.retry_invoice_completion_work(uuid,uuid,uuid),
  public.invoice_completion_block_status(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.revise_provider_credentials(),public.resume_invoice_completion_credentials(),
  public.block_invoice_completion_work(uuid,uuid,uuid,uuid,text),public.retry_invoice_completion_work(uuid,uuid,uuid),
  public.invoice_completion_block_status(uuid) TO service_role;
NOTIFY pgrst,'reload schema';
