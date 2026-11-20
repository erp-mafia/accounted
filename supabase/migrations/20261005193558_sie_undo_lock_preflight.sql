-- crm#1022: an SIE undo must never start into a locked range, and a run that a
-- lock stopped must be able to continue once the user unlocks.
--
-- request_sie_import_undo checked the import's own fiscal year (is_closed,
-- locked_at) but not the company lock date (company_settings.
-- bookkeeping_locked_through). The worker writes each storno on the date of
-- the voucher it reverses, and enforce_company_lock_date refuses every such
-- insert on or before the lock date. So an undo of a year behind the lock date
-- was admitted, its first chunk failed, and the job paused holding its fiscal
-- year. guard_sie_company_lock_date then refused every change of the lock date
-- while any year is held, including moving it back, which is the only change
-- that lets the undo finish. Resume failed on the lock, undo again failed on
-- the lock, unlocking failed on the hold: a dead end.
--
-- 1. sie_write_lock_refusal reads the state the write triggers enforce
--    (enforce_period_lock: closed or locked fiscal year; enforce_company_lock_date:
--    the company lock date) and answers with the Swedish sentence that names
--    the locked range and the way out. request_sie_import_undo, the resume of
--    an undo and replace_sie_import_job ask it before anything is queued.
-- 2. guard_sie_company_lock_date refuses only a lock date that locks more
--    (a first lock date, or a later one). Moving it back or removing it only
--    makes more dates writable, so it can never strand an import or an undo,
--    and it is how a held run that a lock stopped gets going again. The
--    fiscal-year guard (guard_sie_period_hold) already worked this way: it
--    refuses lock and close transitions of a held year, never unlock.
--
-- Refusals are raised as SQLSTATE 55000 with the message prefix
-- 'SIE_IMPORT_PERIOD_LOCKED: '; the application strips the prefix and shows
-- the sentence (src/lib/import/sie-jobs.ts, jobDatabaseError). Signatures,
-- SECURITY DEFINER, search_path and grants of the replaced functions are
-- unchanged.

-- The Swedish refusal for writing an SIE run's vouchers or stornos dated
-- p_from..p_to into fiscal year p_period_id, or NULL when nothing is locked.
-- p_action names the run: 'undo' (batch storno) or 'replace' (storno of the
-- previous import plus the new file in the same fiscal year). The closed and
-- locked fiscal-year states are refused whatever the dates, as before.
-- SECURITY INVOKER: a member reads only its own company's rows (RLS), and the
-- SECURITY DEFINER RPCs below call it with their own rights.
CREATE FUNCTION public.sie_write_lock_refusal(p_company_id uuid, p_period_id uuid,
  p_from date, p_to date, p_action text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE v_period public.fiscal_periods; v_lock date; v_label text; v_dates text;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('undo','replace') THEN
    RAISE EXCEPTION 'Unknown SIE write action %', p_action USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_period FROM public.fiscal_periods WHERE id = p_period_id AND company_id = p_company_id;
  IF FOUND THEN
    v_label := format('Räkenskapsåret %s (%s till %s)', v_period.name,
      to_char(v_period.period_start, 'YYYY-MM-DD'), to_char(v_period.period_end, 'YYYY-MM-DD'));
    IF v_period.is_closed THEN
      IF coalesce(v_period.closed_externally, false) AND v_period.closing_entry_id IS NULL THEN
        RETURN v_label || ' är markerat som avslutat i ett tidigare program. Öppna det igen under '
          || 'Inställningar > Bokföring > Räkenskapsår (knappen Öppna igen) först och försök igen.';
      END IF;
      RETURN v_label || ' är stängt och tar inte emot fler verifikationer, så importen kan inte '
        || CASE p_action WHEN 'undo' THEN 'ångras.' ELSE 'ersättas.' END;
    END IF;
    IF v_period.locked_at IS NOT NULL THEN
      RETURN v_label || ' är låst. Lås upp det under Inställningar > Bokföring > Räkenskapsår först och försök igen.';
    END IF;
  END IF;
  IF p_from IS NULL THEN RETURN NULL; END IF;
  SELECT bookkeeping_locked_through INTO v_lock FROM public.company_settings WHERE company_id = p_company_id;
  IF v_lock IS NULL OR v_lock < p_from THEN RETURN NULL; END IF;
  v_dates := to_char(p_from, 'YYYY-MM-DD');
  IF p_to IS NOT NULL AND p_to > p_from THEN v_dates := v_dates || ' till ' || to_char(p_to, 'YYYY-MM-DD'); END IF;
  RETURN format('Bokföringen är låst t.o.m. %s, och %s %s. Lås upp till och med %s först: sätt '
      || 'Bokföring låst t.o.m. till %s eller tidigare, eller töm fältet, under Inställningar > Bokföring och '
      || 'försök igen. Lås bokföringen igen när %s är klar.',
    to_char(v_lock, 'YYYY-MM-DD'),
    CASE p_action WHEN 'undo' THEN 'ångringen bokför storno med de importerade verifikationernas datum,'
      ELSE 'ersättningen bokför storno och de nya verifikationerna i räkenskapsåret,' END,
    v_dates, to_char(p_from, 'YYYY-MM-DD'), to_char(p_from - 1, 'YYYY-MM-DD'),
    CASE p_action WHEN 'undo' THEN 'ångringen' ELSE 'den nya importen' END);
END;
$$;
REVOKE ALL ON FUNCTION public.sie_write_lock_refusal(uuid, uuid, date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sie_write_lock_refusal(uuid, uuid, date, date, text) TO authenticated, service_role;

-- The refusal for undoing (or resuming the undo of) one import: its stornos
-- carry the dates of the entries it still has posted. Read-only, so the dry
-- run and the MCP stage-time check answer exactly what the undo will.
CREATE FUNCTION public.sie_undo_lock_refusal(p_company_id uuid, p_import_id uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT public.sie_write_lock_refusal(i.company_id, i.fiscal_period_id, r.first_date, r.last_date, 'undo')
    FROM public.sie_imports i
    CROSS JOIN LATERAL (SELECT min(j.entry_date) AS first_date, max(j.entry_date) AS last_date
      FROM public.journal_entries j
      WHERE j.company_id = i.company_id AND j.import_batch_id = i.id AND j.status = 'posted') r
   WHERE i.id = p_import_id AND i.company_id = p_company_id;
$$;
REVOKE ALL ON FUNCTION public.sie_undo_lock_refusal(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sie_undo_lock_refusal(uuid, uuid) TO authenticated, service_role;

-- Body from 20260911150200_sie_repair_action_boundaries.sql. Changed: the
-- closed/locked fiscal-year refusal is sie_undo_lock_refusal, which adds the
-- company lock date; another run's hold keeps its own refusal.
CREATE OR REPLACE FUNCTION public.request_sie_import_undo(p_company_id uuid,p_import_id uuid,p_actor uuid)
RETURNS public.sie_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_period public.fiscal_periods; v_refusal text;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id,p_actor);
  IF NOT EXISTS(SELECT 1 FROM public.company_members WHERE company_id=p_company_id AND user_id=p_actor AND role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'SIE reversal requires company owner or administrator' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text,0));
  SELECT * INTO v_job FROM public.sie_imports WHERE id = p_import_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_state IS NULL THEN RAISE EXCEPTION 'SIE execution not found' USING ERRCODE = 'P0002'; END IF;
  IF v_job.job_kind<>'import' THEN RAISE EXCEPTION 'Reviewed repair requires its reviewed stop action' USING ERRCODE='55000'; END IF;
  IF v_job.job_state IN ('undone','failed') THEN RETURN v_job; END IF;
  IF EXISTS (SELECT 1 FROM public.sie_imports other
      WHERE other.company_id = p_company_id AND other.id <> p_import_id
        AND other.job_state NOT IN ('completed','undone','failed')
        AND NOT (v_job.job_phase = 'undo' AND other.supersedes_import_id = p_import_id)) THEN
    RAISE EXCEPTION 'Another SIE execution must finish before undo' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_period FROM public.fiscal_periods WHERE id = v_job.fiscal_period_id AND company_id = p_company_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.journal_entries original JOIN public.journal_entries reversal
    ON reversal.reverses_id = original.id AND reversal.company_id = p_company_id
    WHERE original.company_id = p_company_id AND original.import_batch_id = p_import_id
      AND original.status = 'posted' AND reversal.status IN ('draft','posted')) THEN
    RAISE EXCEPTION 'SIE undo requires review: a voucher reversal is already in progress' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (WITH RECURSIVE descendants AS (
    SELECT id,status FROM public.journal_entries WHERE company_id = p_company_id AND import_batch_id = p_import_id
    UNION SELECT j.id,j.status FROM public.journal_entries j JOIN descendants d ON j.correction_of_id = d.id
      WHERE j.company_id = p_company_id
  ) SELECT 1 FROM descendants d JOIN public.journal_entries j ON j.id = d.id
    WHERE j.status IN ('draft','posted') AND j.import_batch_id IS DISTINCT FROM p_import_id) THEN
    RAISE EXCEPTION 'SIE undo requires review: an imported voucher has a live correction' USING ERRCODE = '55000';
  END IF;
  IF p_actor IS DISTINCT FROM coalesce(v_job.execution_actor_id,v_job.user_id) AND NOT EXISTS (
    SELECT 1 FROM public.company_members WHERE company_id = p_company_id AND user_id = p_actor AND role IN ('owner','admin')
  ) THEN RAISE EXCEPTION 'SIE undo requires company administrator' USING ERRCODE = '42501'; END IF;
  -- The fiscal year row is locked above, and guard_sie_company_lock_date takes
  -- the same row locks before a lock date can move forward: this answer holds
  -- until the hold below is committed.
  v_refusal := public.sie_undo_lock_refusal(p_company_id,p_import_id);
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SIE_IMPORT_PERIOD_LOCKED: ' || v_refusal;
  END IF;
  IF v_period.import_hold IS NOT NULL AND v_period.import_hold <> p_import_id THEN
    RAISE EXCEPTION 'SIE period is locked or has another execution' USING ERRCODE = '55000';
  END IF;
  UPDATE public.fiscal_periods SET import_hold = p_import_id WHERE id = v_period.id;
  UPDATE public.sie_imports SET job_state = 'undoing',job_phase = 'undo',job_attempt = job_attempt+1,
    execution_actor_id = p_actor,worker_id = NULL,lease_until = NULL,next_attempt_at = NULL,error_message = NULL
    WHERE id = p_import_id RETURNING * INTO v_job;
  RETURN v_job;
END;
$$;

-- Body from 20260911140525_sie_import_job_metadata_and_recovery.sql. Changed:
-- resuming an undo that a lock stops says so now, instead of re-queuing a
-- chunk that must fail again in the background.
CREATE OR REPLACE FUNCTION public.resume_sie_import_job(p_company_id uuid,p_import_id uuid,p_actor uuid)
RETURNS public.sie_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_refusal text;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id,p_actor);
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text,0));
  SELECT * INTO v_job FROM public.sie_imports WHERE id = p_import_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_state IS NULL THEN RAISE EXCEPTION 'SIE execution not found' USING ERRCODE = 'P0002'; END IF;
  IF v_job.job_state IN ('completed','undone','failed') THEN RETURN v_job; END IF;
  IF p_actor IS DISTINCT FROM coalesce(v_job.execution_actor_id,v_job.user_id) AND NOT EXISTS (
    SELECT 1 FROM public.company_members WHERE company_id = p_company_id AND user_id = p_actor AND role IN ('owner','admin')
  ) THEN RAISE EXCEPTION 'SIE recovery requires company administrator' USING ERRCODE = '42501'; END IF;
  IF v_job.job_kind = 'import' AND v_job.job_phase = 'undo' THEN
    v_refusal := public.sie_undo_lock_refusal(p_company_id,p_import_id);
    IF v_refusal IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SIE_IMPORT_PERIOD_LOCKED: ' || v_refusal;
    END IF;
  END IF;
  UPDATE public.sie_imports SET execution_actor_id = p_actor,next_attempt_at = NULL WHERE id = p_import_id;
  RETURN public.reconcile_sie_import(p_company_id,p_import_id,p_actor);
END;
$$;

-- Body from 20260911150200_sie_repair_action_boundaries.sql. Changed: a
-- replacement reverses the previous import and books the new file into the
-- same fiscal year, so it is refused before either starts when any date of
-- that year is locked. It can no longer stop half way, with the old import
-- reversed and the new one unable to post.
CREATE OR REPLACE FUNCTION public.replace_sie_import_job(p_company_id uuid,p_actor uuid,p_period_id uuid,
  p_filename text,p_file_hash text,p_manifest jsonb,p_supersedes_import_id uuid)
RETURNS public.sie_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_previous public.sie_imports; v_period public.fiscal_periods; v_refusal text;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id,p_actor);
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text,0));
  SELECT * INTO v_previous FROM public.sie_imports WHERE id = p_supersedes_import_id
    AND company_id = p_company_id AND fiscal_period_id = p_period_id FOR UPDATE;
  IF NOT FOUND OR v_previous.job_state IS NULL OR v_previous.job_kind<>'import' THEN
    RAISE EXCEPTION 'Legacy SIE import requires reviewed reconciliation before replacement' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_job FROM public.sie_imports WHERE supersedes_import_id = p_supersedes_import_id
    AND company_id = p_company_id AND job_state NOT IN ('undone','failed') ORDER BY created_at DESC LIMIT 1;
  IF FOUND THEN
    IF v_job.file_hash IS DISTINCT FROM p_file_hash OR v_job.manifest->'input' IS DISTINCT FROM p_manifest->'input' THEN
      RAISE EXCEPTION 'SIE replacement already reserved with different input' USING ERRCODE = '23505';
    END IF;
    RETURN v_job;
  END IF;
  IF v_previous.job_state NOT IN ('completed','undoing','undone') THEN
    RAISE EXCEPTION 'SIE import is unfinished: resume or undo it first' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_period FROM public.fiscal_periods WHERE id = p_period_id AND company_id = p_company_id FOR UPDATE;
  IF FOUND THEN
    v_refusal := public.sie_write_lock_refusal(p_company_id,p_period_id,v_period.period_start,v_period.period_end,'replace');
    IF v_refusal IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SIE_IMPORT_PERIOD_LOCKED: ' || v_refusal;
    END IF;
  END IF;
  IF v_previous.job_state = 'completed' THEN
    PERFORM public.request_sie_import_undo(p_company_id,p_supersedes_import_id,p_actor);
  END IF;
  RETURN public.start_sie_import_job(p_company_id,p_actor,p_period_id,p_filename,p_file_hash,p_manifest,p_supersedes_import_id);
END;
$$;

-- Body from 20260911140531_sie_import_period_holds.sql. Changed: only a lock
-- date that locks more waits for unfinished imports.
CREATE OR REPLACE FUNCTION public.guard_sie_company_lock_date() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Moving the lock date back, or removing it, only makes more dates
  -- writable. It cannot break an import or undo in flight, and it is how a
  -- held run that a lock date stopped continues (crm#1022).
  IF NEW.bookkeeping_locked_through IS NULL OR (OLD.bookkeeping_locked_through IS NOT NULL
      AND NEW.bookkeeping_locked_through <= OLD.bookkeeping_locked_through) THEN
    RETURN NEW;
  END IF;
  -- A row trigger already owns the settings row. Never wait for a period
  -- owned by a worker that may need those settings; return a retryable lock
  -- conflict. An acquired lock still protects the check through commit.
  PERFORM 1 FROM public.fiscal_periods WHERE company_id = NEW.company_id ORDER BY id FOR UPDATE NOWAIT;
  IF EXISTS (SELECT 1 FROM public.fiscal_periods WHERE company_id = NEW.company_id AND import_hold IS NOT NULL) THEN
    RAISE EXCEPTION 'SIE_IMPORT_HOLD: importen måste slutföras innan bokföringen låses' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
