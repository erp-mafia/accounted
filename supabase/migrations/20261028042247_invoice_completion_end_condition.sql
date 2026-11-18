-- Invoice row completion gets an end condition, and the hourly claim stops
-- re-testing every company that has nothing to do.
--
-- What happened. The hourly pass (/api/extensions/arcim-migration/
-- complete-invoice-lines/cron, 20260921073428 and later) fetches the rows of
-- migrated invoices that arrived without any. Two things never ended:
--
-- 1. An invoice whose rows cannot be had (the provider's detail holds none,
--    its total or rows disagree, no source matches) got its outcome and a
--    retry one day later, forever: every such invoice was asked of the
--    provider once a day (outcomes provider_empty, total_mismatch, unmatched
--    and rows_mismatch).
-- 2. A company is released with no delay after its run, so its queue row is
--    always due, and claim_invoice_completion_work tests every due company
--    for an invoice without rows: an anti-join over all of the company's
--    invoices against invoice_items, on every claim, several claims per run.
--    Nearly every company tested has no work, so the cost of a claim follows
--    the number of companies, not the work there is.
--
-- What changes.
--
-- 1. invoice_completion_entries.attempts counts the tries in a row that were
--    not progress. finish_invoice_completion parks an invoice for good
--    (next_attempt_at 'infinity') at its 7th such try, 24th for a 'failed'
--    one (those are hourly), keeps the outcome as the reason, and says
--    gaveUp in the receipt. Progress ('written', 'already_filled') resets the
--    count. A change of provider or account, which already re-arms every
--    entry in claim_invoice_completion_work, now also resets it. Existing
--    entries get the tries their age stands for (one a day since the entry
--    was made, at most 7): the old ones end now, younger ones go on.
-- 2. A company with no candidate at all (no invoice without rows that has no
--    entry or a due one: the claim's own predicate, word for word) is marked
--    idle by enqueue_invoice_completion_work, which every run calls once
--    before it claims: idle_until (its earliest entry falling due, at most
--    24 hours out) and idle_since (15 minutes before the mark, so an import
--    transaction that was open while the mark was made still counts as new).
--    While a company is idle the claim does not run the anti-join over all
--    its invoices; it looks only at invoices created since idle_since, so an
--    import into an idle company is claimable at once, exactly as before.
--    next_attempt_at is never touched by the mark: the order of the queue,
--    and so its fairness (work released now goes behind an older company),
--    is what it was. The claim clears the mark when it takes the company.
--
-- What does not stop: an invoice that makes progress, an invoice not tried
-- yet, a 'failed' invoice before its 24th try, every company with a
-- candidate, and every invoice created in an idle company. What waits until
-- the mark expires (at most 24 hours): an entry re-armed by hand, and an
-- older invoice whose rows were deleted. Nothing is deleted; an entry that
-- gave up is re-armed by a change of provider or account, or by setting its
-- next_attempt_at.
--
-- Bodies restated from the latest definitions: claim_invoice_completion_work
-- from 20261015233500, finish_invoice_completion from 20260921120903,
-- enqueue_invoice_completion_work from 20260921073428 (all three the
-- installed definitions). Only the lines named above change. Grants stay
-- (CREATE OR REPLACE keeps them).
--
-- pg-test: tests/pg/invoice-completion-end.pg.test.ts

ALTER TABLE public.invoice_completion_entries ADD COLUMN attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.invoice_completion_entries.attempts IS
  'Tries in a row that were not progress. At 7 (24 for failed) the entry is parked with next_attempt_at infinity and its outcome as the reason.';

ALTER TABLE public.invoice_completion_work ADD COLUMN idle_until timestamptz, ADD COLUMN idle_since timestamptz;

COMMENT ON COLUMN public.invoice_completion_work.idle_until IS
  'Set by enqueue_invoice_completion_work when the company has no candidate: until then the claim only looks at invoices created since idle_since. Cleared by the claim. Never changes the queue order (next_attempt_at).';
COMMENT ON COLUMN public.invoice_completion_work.idle_since IS
  'Invoices created at or after this time wake an idle company at once (15 minutes before the idle mark, for imports still open when it was made).';

UPDATE public.invoice_completion_entries
  SET attempts=LEAST(7,floor(extract(epoch FROM (now()-created_at))/86400)::integer+1),
      next_attempt_at=CASE WHEN floor(extract(epoch FROM (now()-created_at))/86400)::integer+1>=7
        THEN 'infinity'::timestamptz ELSE next_attempt_at END
  WHERE outcome IN ('unmatched','ambiguous','provider_empty','total_mismatch','rows_mismatch');

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
    -- An idle company (enqueue found no candidate) is asked only about the
    -- invoices created since it went idle: the same predicate over a few rows
    -- instead of all of them. CASE fixes the order: the full anti-join never
    -- runs for an idle company.
    AND CASE WHEN q.idle_until>clock_timestamp() THEN EXISTS (SELECT 1 FROM invoices i LEFT JOIN invoice_completion_entries e
      ON e.company_id=i.company_id AND e.invoice_id=i.id
      WHERE i.company_id=q.company_id AND i.created_at>=q.idle_since
        AND i.document_type='invoice' AND (i.status<>'draft' OR i.total<>0)
        AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id=i.id)
        AND (e.next_attempt_at IS NULL OR e.next_attempt_at<=clock_timestamp()))
    ELSE EXISTS (SELECT 1 FROM invoices i LEFT JOIN invoice_completion_entries e
      ON e.company_id=i.company_id AND e.invoice_id=i.id
      WHERE i.company_id=q.company_id AND i.document_type='invoice' AND (i.status<>'draft' OR i.total<>0)
        AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id=i.id)
        AND (e.next_attempt_at IS NULL OR e.next_attempt_at<=clock_timestamp())) END
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
    UPDATE invoice_completion_entries SET next_attempt_at=now(),attempts=0 WHERE company_id=w.company_id;
  END IF;
  UPDATE invoice_completion_work SET consent_id=consent.id,user_id=consent.user_id,provider=consent.provider,account_key=consent.account_key,
    scan_id=w.scan_id,next_page=w.next_page,part=w.part,scanned_at=w.scanned_at,
    block_reason=NULL,blocked_revision=NULL,blocked_at=NULL,block_id=NULL,idle_until=NULL,idle_since=NULL,
    worker_id=p_worker_id,lease_until=clock_timestamp()+interval '3 minutes'
    WHERE company_id=w.company_id RETURNING * INTO w;
  RETURN w;
END $$;

CREATE OR REPLACE FUNCTION public.finish_invoice_completion(p_company_id uuid,p_worker_id uuid,p_invoice_id uuid,
  p_outcome text,p_rows jsonb DEFAULT NULL,p_header jsonb DEFAULT NULL,p_event jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path=public SET statement_timeout='8s' SET lock_timeout='1s' AS $$
DECLARE w invoice_completion_work; prior invoice_completion_entries; r jsonb; event_uuid uuid;
  tries integer; gave_up boolean;
BEGIN
  w:=lock_invoice_completion_work(p_company_id,p_worker_id);
  IF NOT EXISTS(SELECT 1 FROM invoices WHERE id=p_invoice_id AND company_id=p_company_id) THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND';
  END IF;
  SELECT * INTO prior FROM invoice_completion_entries WHERE company_id=p_company_id AND invoice_id=p_invoice_id;
  IF prior.run_id=p_worker_id AND prior.receipt IS NOT NULL THEN RETURN prior.receipt; END IF;
  IF p_rows IS NOT NULL THEN
    IF p_event->>'correlation_id' IS DISTINCT FROM p_worker_id::text THEN
      RAISE EXCEPTION 'INVOICE_COMPLETION_EVENT_INVALID';
    END IF;
    r:=complete_invoice_rows_with_history(p_company_id,p_invoice_id,p_rows,p_header,p_event);
    IF NOT COALESCE((r->>'ok')::boolean,false) THEN RAISE EXCEPTION 'INVOICE_COMPLETION_WRITE_FAILED: %',r->>'code'; END IF;
    p_outcome:=CASE WHEN (r->>'wrote')::boolean THEN 'written' ELSE 'already_filled' END;
    event_uuid:=(r->>'event_id')::uuid;
  ELSIF p_outcome NOT IN ('unmatched','ambiguous','provider_empty','total_mismatch','rows_mismatch','failed') THEN
    RAISE EXCEPTION 'INVOICE_COMPLETION_OUTCOME_INVALID';
  END IF;
  -- The end condition: an outcome that is not progress counts as one try,
  -- and the last allowed try parks the invoice for good (next_attempt_at
  -- 'infinity'), its outcome kept as the reason.
  tries:=CASE WHEN p_outcome IN ('written','already_filled') THEN 0 ELSE COALESCE(prior.attempts,0)+1 END;
  gave_up:=tries>=CASE WHEN p_outcome='failed' THEN 24 ELSE 7 END;
  r:=jsonb_build_object('status',p_outcome,'rows',COALESCE((r->>'rows')::integer,0),
    'headerUpdated',COALESCE((r->>'header_updated')::boolean,false),'eventId',event_uuid);
  IF gave_up THEN r:=r||jsonb_build_object('gaveUp',true,'attempts',tries); END IF;
  INSERT INTO invoice_completion_entries(company_id,invoice_id,next_attempt_at,outcome,run_id,receipt,attempts)
    VALUES(p_company_id,p_invoice_id,CASE WHEN gave_up THEN 'infinity'::timestamptz
        ELSE clock_timestamp()+CASE WHEN p_outcome='failed' THEN interval '1 hour' ELSE interval '1 day' END END,
      p_outcome,p_worker_id,r,tries)
    ON CONFLICT(company_id,invoice_id) DO UPDATE SET next_attempt_at=EXCLUDED.next_attempt_at,
      outcome=EXCLUDED.outcome,run_id=EXCLUDED.run_id,receipt=EXCLUDED.receipt,attempts=EXCLUDED.attempts;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.enqueue_invoice_completion_work() RETURNS integer
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
  -- Mark idle the due companies with no candidate at all: no invoice without
  -- rows that has no entry or a due one (the claim's own predicate, word for
  -- word). Until the earliest entry of theirs falls due, at most 24 hours.
  -- An invoice created in the meantime wakes the company in the claim at
  -- once. next_attempt_at stays as it is, so the queue order does too. Rows
  -- held by a live worker, or locked by a claim, are left alone.
  UPDATE invoice_completion_work w
    SET idle_until=LEAST(clock_timestamp()+interval '24 hours',COALESCE(idle.next_due,'infinity'::timestamptz)),
      idle_since=now()-interval '15 minutes'
    FROM (
      SELECT q.company_id,
        -- Any entry of the company that falls due later: a superset of the
        -- invoices that can, so the mark never outlasts its first due one.
        (SELECT min(e.next_attempt_at) FROM invoice_completion_entries e
          WHERE e.company_id=q.company_id AND e.next_attempt_at>clock_timestamp()) AS next_due
      FROM invoice_completion_work q
      WHERE q.next_attempt_at<=clock_timestamp()
        AND (q.idle_until IS NULL OR q.idle_until<=clock_timestamp())
        AND (q.lease_until IS NULL OR q.lease_until<clock_timestamp())
        AND NOT EXISTS (SELECT 1 FROM invoices i LEFT JOIN invoice_completion_entries e
          ON e.company_id=i.company_id AND e.invoice_id=i.id
          WHERE i.company_id=q.company_id AND i.document_type='invoice' AND (i.status<>'draft' OR i.total<>0)
            AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id=i.id)
            AND (e.next_attempt_at IS NULL OR e.next_attempt_at<=clock_timestamp()))
      FOR UPDATE OF q SKIP LOCKED
    ) idle
    WHERE w.company_id=idle.company_id;
  RETURN n;
END $$;

NOTIFY pgrst,'reload schema';
