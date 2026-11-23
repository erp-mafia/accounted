-- claim_document_jobs: each claim draws a company, so one company's bulk
-- import no longer holds every other company's documents behind it
-- (crm#2166, 2026-11-23).
--
-- pg-test: tests/pg/document-jobs-fair-claim.pg.test.ts
--
-- The worker (/api/documents/jobs/cron) claims one job at a time. The claim
-- took the job with the oldest run_after across all companies, so a company
-- that queued N jobs at once put every other company's next document behind
-- all N. A migration import queues one read job per imported document: in
-- production from 2026-11-20 to 11-23 three imports queued 21 000, 17 000 and
-- 3 000 read jobs, and the other companies' documents waited behind them, a
-- median of 35.6 h at the worst (2026-11-22).
--
-- Now a claim finds each company's longest-due job and takes one of them at
-- random. Every company with a due job has the same chance at each claim,
-- however many jobs it has queued: an import gets one company's share of the
-- worker while others wait, and all of it when nobody else does. Within a
-- company nothing changes: its jobs go longest-due first, as before. A batch
-- larger than one is filled in rounds of one job per company.
--
-- Random rather than in turn: taking companies in turn needs to remember
-- whose turn it was between two claims, and this function keeps nothing
-- between calls. With K companies with a due job, a company is reached
-- within K claims on average; the worker claims several a second.
--
-- Cost: one short range scan of idx_document_jobs_open_by_company
-- (20261123093000) per company with a due job, each stopping at that
-- company's first due job, however long its queue; jobs not due yet are
-- passed over in the index without reading the table. On a copy shaped like
-- production on 2026-11-23 (374 000 jobs, 22 000 open, 139 companies with a
-- due job, one with 17 000): 1.4 ms a claim against 0.35 ms for the old one,
-- and 300 claims reached 132 companies against 6.
--
-- When every company's next job is being claimed by another worker at that
-- moment, the claim takes the oldest due job of anyone, as the old one did,
-- instead of answering empty: the worker reads an empty answer as an empty
-- queue and ends its run.
--
-- Same signature, same grants, same columns back: the worker and the upload
-- screen's own claim (claim_document_job_for) are unchanged.

CREATE OR REPLACE FUNCTION public.claim_document_jobs(
  p_batch_size int,
  p_worker     text,
  p_now        timestamptz DEFAULT now()
)
RETURNS TABLE (
  id          uuid,
  company_id  uuid,
  document_id uuid,
  kind        text,
  attempts    int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed int := 0;
  v_round   int;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size <= 0 OR p_batch_size > 500 THEN
    RAISE EXCEPTION 'p_batch_size must be in (0, 500]; got %', p_batch_size
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Rounds: each takes at most one job of each company, the companies in a
  -- random order, until the batch is full or a round finds nothing.
  LOOP
    RETURN QUERY
    WITH RECURSIVE heads AS (
      -- Each company's longest-due job, company after company in id order:
      -- one short range scan of idx_document_jobs_open_by_company each, which
      -- stops at the company's first due job.
      (SELECT j.company_id, j.id
         FROM public.document_jobs j
        WHERE j.status <> 'done' AND j.attempts < j.max_attempts
          AND j.run_after <= p_now
          AND (
            j.status IN ('queued', 'failed')
            -- a worker that died mid-job: take it over after ten minutes
            OR (j.status = 'running' AND j.locked_at < p_now - interval '10 minutes')
          )
        ORDER BY j.company_id, j.run_after, j.created_at
        LIMIT 1)
      UNION ALL
      SELECT n.company_id, n.id
        FROM heads h
       CROSS JOIN LATERAL (
         SELECT j.company_id, j.id
           FROM public.document_jobs j
          WHERE j.status <> 'done' AND j.attempts < j.max_attempts
            AND j.company_id > h.company_id
            AND j.run_after <= p_now
            AND (
              j.status IN ('queued', 'failed')
              OR (j.status = 'running' AND j.locked_at < p_now - interval '10 minutes')
            )
          ORDER BY j.company_id, j.run_after, j.created_at
          LIMIT 1
       ) n
    ),
    due AS (
      -- The due test again on the locked row: a job another worker claimed
      -- and committed after this statement began is re-read under the lock
      -- and dropped, never claimed twice.
      SELECT j.id
        FROM heads h
        JOIN public.document_jobs j ON j.id = h.id
       WHERE j.attempts < j.max_attempts
         AND j.run_after <= p_now
         AND (
           j.status IN ('queued', 'failed')
           OR (j.status = 'running' AND j.locked_at < p_now - interval '10 minutes')
         )
       ORDER BY random()
       LIMIT p_batch_size - v_claimed
         FOR UPDATE OF j SKIP LOCKED
    )
    UPDATE public.document_jobs j
       SET status = 'running', locked_at = p_now, locked_by = p_worker, attempts = j.attempts + 1
      FROM due
     WHERE j.id = due.id
    RETURNING j.id, j.company_id, j.document_id, j.kind, j.attempts;

    GET DIAGNOSTICS v_round = ROW_COUNT;
    v_claimed := v_claimed + v_round;
    EXIT WHEN v_round = 0 OR v_claimed >= p_batch_size;
  END LOOP;

  -- Nothing claimed while jobs are due: every company's next job was being
  -- claimed by another worker at this moment. The oldest due job of anyone,
  -- as before, rather than an empty answer, which the worker reads as an
  -- empty queue and ends its run on.
  IF v_claimed = 0 THEN
    RETURN QUERY
    WITH due AS (
      SELECT j.id
        FROM public.document_jobs j
       WHERE j.attempts < j.max_attempts
         AND j.run_after <= p_now
         AND (
           j.status IN ('queued', 'failed')
           OR (j.status = 'running' AND j.locked_at < p_now - interval '10 minutes')
         )
       ORDER BY j.run_after ASC, j.created_at ASC
       LIMIT p_batch_size
         FOR UPDATE SKIP LOCKED
    )
    UPDATE public.document_jobs j
       SET status = 'running', locked_at = p_now, locked_by = p_worker, attempts = j.attempts + 1
      FROM due
     WHERE j.id = due.id
    RETURNING j.id, j.company_id, j.document_id, j.kind, j.attempts;
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.claim_document_jobs(integer, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_document_jobs(integer, text, timestamptz) TO service_role;
COMMENT ON FUNCTION public.claim_document_jobs(integer, text, timestamptz) IS
  'Arkiv: claims due document jobs for the worker cron (FOR UPDATE SKIP LOCKED), one company drawn at random per job and each company''s longest-due job first, so no company''s backlog holds the others. Service role only.';

NOTIFY pgrst, 'reload schema';
