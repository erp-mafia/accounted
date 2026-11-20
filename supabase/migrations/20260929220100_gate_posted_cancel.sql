-- Gate the posted -> cancelled transition to the sanctioned cleanup path.
--
-- Why this exists: several multi-step client workflows (reverseEntry,
-- correctEntry, the payment and invoice-booking flows) post a verifikat and
-- only then run a follow-up write (mark the original reversed, link the
-- invoice, CAS the invoice status). When that follow-up fails they compensate
-- by cancelling the verifikat they just posted. The database could not tell
-- that compensation apart from any company writer cancelling an ordinary
-- posted verifikat, so enforce_journal_entry_immutability() let posted ->
-- cancelled through for everyone (20260915140000 already locked every other
-- column in that statement). Cancelled entries drop out of every report, and
-- the line enforcement then allowed deleting the lines of a cancelled entry,
-- so the voucher's amounts could be erased afterwards too.
--
-- Fix, additive only: the migration-017 enforcement functions are NOT
-- redefined (they are legally required and stay byte-identical). Two new
-- BEFORE triggers can only ever tighten, because Postgres runs every BEFORE
-- trigger and any one of them raising aborts the statement; their firing
-- order relative to the existing triggers is therefore irrelevant.
--
--   1. guard_posted_cancel (journal_entries): posted -> cancelled requires the
--      transaction-local GUC gnubok.allow_posted_cancel, for every role.
--   2. guard_posted_entry_line_delete (journal_entry_lines): the lines of a
--      cancelled entry that was once posted (committed_at is set) are kept.
--      Only the gnubok.allow_delete teardown paths (undo/replace SIE import,
--      reset_fiscal_year, delete_last_voucher, sandbox cleanup) may remove
--      them, exactly as they already may remove the entry itself.
--      committed_at is the "was posted" marker: set_committed_at() stamps it
--      on every draft -> posted transition, an end user can never insert it
--      (enforce_journal_entry_insert_shape), and a never-posted draft keeps
--      it NULL, so the cleanup of a cancelled draft is unaffected.
--
--   3. committed_by (journal_entries): the user who moved the entry from
--      draft to posted, stamped by a new BEFORE trigger on that transition
--      and frozen afterwards. user_id is only the creator: a writer can create
--      or edit a draft that a colleague then posts, so the creator alone does
--      not prove whose workflow posted it.
--
--   4. cancel_orphaned_entry(): the one door that sets the GUC. It cancels a
--      posted entry only when it is provably the orphan of a workflow that
--      just failed: created and posted by the acting user, posted within the
--      last 15 minutes, referenced by no live verifikat, in an open and
--      unlocked period and not behind the company lock date. A draft is cancelled as
--      it is (anyone may cancel a draft), so a caller that does not know
--      whether its own post landed gets the right outcome either way. An
--      optional gap explanation is written in the same transaction, which
--      closes the crash window between the cancel and the explanation that
--      the client-side sequence had.
--
--      SECURITY DEFINER, like the sibling GUC-setting RPCs
--      (correct_entry_metadata, correct_entry_lines_inline,
--      retag_line_dimensions), with the tenant and writer checks done
--      explicitly. The enforcement triggers still fire inside it, including
--      aa_enforce_company_writer_role for a JWT caller. SECURITY INVOKER was
--      considered and rejected: voucher_gap_explanations INSERT is limited by
--      RLS to team owners/admins, so under INVOKER an ordinary writer's gap
--      row would abort the whole transaction, cancel included, and leave the
--      orphan posted and double-counted, which is worse than the hole this
--      closes. The definer does not widen who may author an explanation
--      either: for a JWT caller the row is written only when the same RLS
--      predicate (team owner/admin) would have let the caller insert it; for
--      anyone else the cancel still happens and the note is skipped. No gap
--      goes unexplained that way: the cancelled header keeps occupying its
--      number, which detect_voucher_gaps counts as used.
--
-- The RPC never deletes lines: a cancelled header together with its lines is
-- the retained record of how the voucher number was used (BFL 5 kap 5 § and
-- 7 kap), and every report already excludes cancelled entries by status.
--
-- No SQL function flips posted -> cancelled today (the last one, the old
-- replace_sie_import, was replaced by a gnubok.allow_delete hard delete), so
-- nothing server-side needs the GUC besides the new RPC.

-- 1. Header gate

CREATE OR REPLACE FUNCTION public.guard_journal_entry_posted_cancel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_setting('gnubok.allow_posted_cancel', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Cannot cancel a posted journal entry (id: %). Use a storno (reversal) instead; only cancel_orphaned_entry may void the orphan of a failed workflow.',
      OLD.id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_posted_cancel ON public.journal_entries;
CREATE TRIGGER guard_posted_cancel
  BEFORE UPDATE ON public.journal_entries
  FOR EACH ROW
  WHEN (OLD.status = 'posted' AND NEW.status = 'cancelled')
  EXECUTE FUNCTION public.guard_journal_entry_posted_cancel();

-- 2. Line retention on cancelled, once-posted entries

CREATE OR REPLACE FUNCTION public.guard_posted_entry_line_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_committed_at timestamptz;
BEGIN
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    RETURN OLD;
  END IF;

  SELECT je.status, je.committed_at
    INTO v_status, v_committed_at
    FROM public.journal_entries je
   WHERE je.id = OLD.journal_entry_id;

  IF v_status = 'cancelled' AND v_committed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot delete lines of a cancelled journal entry that was posted (id: %). Its lines are retained accounting records.',
      OLD.journal_entry_id
      USING ERRCODE = '42501';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS guard_posted_entry_line_delete ON public.journal_entry_lines;
CREATE TRIGGER guard_posted_entry_line_delete
  BEFORE DELETE ON public.journal_entry_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_posted_entry_line_delete();

-- 3. Posting actor

ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS committed_by uuid;

COMMENT ON COLUMN public.journal_entries.committed_by IS
  'User who moved the entry from draft to posted (auth.uid(), or user_id for a trusted backend caller). Stamped by stamp_journal_entry_committed_by, frozen once posted; NULL on drafts and on entries posted before 20260929220100.';

CREATE OR REPLACE FUNCTION public.stamp_journal_entry_committed_by()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Only a trusted writer can insert a non-draft (enforce_journal_entry_insert_shape).
    IF NEW.status = 'draft' THEN
      NEW.committed_by := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' THEN
    IF NEW.status = 'posted' THEN
      -- Same trust split as commit_journal_entry: a JWT caller is auth.uid(),
      -- a trusted backend posts on behalf of the entry's user.
      IF public.jwt_caller_is_end_user() THEN
        NEW.committed_by := auth.uid();
      ELSE
        NEW.committed_by := coalesce(auth.uid(), NEW.user_id);
      END IF;
    ELSE
      NEW.committed_by := NULL;
    END IF;
  ELSE
    NEW.committed_by := OLD.committed_by;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stamp_journal_entry_committed_by ON public.journal_entries;
CREATE TRIGGER stamp_journal_entry_committed_by
  BEFORE INSERT OR UPDATE ON public.journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_journal_entry_committed_by();

-- 4. The sanctioned door

CREATE OR REPLACE FUNCTION public.cancel_orphaned_entry(
  p_company_id      uuid,
  p_entry_id        uuid,
  p_user_id         uuid DEFAULT NULL,
  p_gap_explanation text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor        uuid := p_user_id;
  v_entry        record;
  v_is_closed    boolean;
  v_locked_at    timestamptz;
  v_lock_date    date;
  v_series       text;
  v_explanation  text := nullif(btrim(coalesce(p_gap_explanation, '')), '');
  v_gap_recorded boolean := false;
  v_gap_rows     integer;
BEGIN
  -- Same trust split as commit_journal_entry, the door that posted the
  -- orphan, so cleanup is never stricter than the post it undoes:
  --   * JWT caller (anon/authenticated): acts as auth.uid() only, whatever
  --     p_user_id says, and must hold write access to the company.
  --   * service_role / no-JWT caller: trusted backend that authenticated the
  --     user application-side; p_user_id names the user whose workflow
  --     created the entry and is required.
  IF public.jwt_caller_is_end_user() THEN
    v_actor := auth.uid();
    IF v_actor IS NULL OR NOT public.caller_can_write_company(p_company_id) THEN
      RAISE EXCEPTION 'cancel_orphaned_entry: no write access to company %', p_company_id
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_actor IS NULL THEN
    RAISE EXCEPTION 'cancel_orphaned_entry: p_user_id is required for a backend caller'
      USING ERRCODE = '22023';
  END IF;

  SELECT je.id, je.company_id, je.status, je.user_id, je.committed_at, je.committed_by,
         je.fiscal_period_id, je.voucher_series, je.voucher_number, je.entry_date
    INTO v_entry
    FROM public.journal_entries je
   WHERE je.id = p_entry_id
     FOR UPDATE;

  IF NOT FOUND OR v_entry.company_id IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'cancel_orphaned_entry: journal entry % not found in company %', p_entry_id, p_company_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Idempotent: a retried cleanup finds its own earlier result.
  IF v_entry.status = 'cancelled' THEN
    RETURN jsonb_build_object('cancelled', false, 'previous_status', 'cancelled', 'gap_recorded', false);
  END IF;

  -- The workflow failed before its post landed: a plain draft cancel, which
  -- the immutability trigger allows for every writer anyway.
  IF v_entry.status = 'draft' THEN
    UPDATE public.journal_entries
       SET status = 'cancelled'
     WHERE id = p_entry_id AND status = 'draft';
    RETURN jsonb_build_object('cancelled', true, 'previous_status', 'draft', 'gap_recorded', false);
  END IF;

  IF v_entry.status <> 'posted' THEN
    RAISE EXCEPTION 'cancel_orphaned_entry: a % journal entry cannot be cancelled (id: %)', v_entry.status, p_entry_id
      USING ERRCODE = '55000';
  END IF;

  -- Proof that this posted entry is the orphan of the caller's own workflow.
  IF v_entry.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'cancel_orphaned_entry: journal entry % was not created by the acting user; use a storno instead', p_entry_id
      USING ERRCODE = '42501';
  END IF;

  IF v_entry.committed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'cancel_orphaned_entry: journal entry % was not posted by the acting user; use a storno instead', p_entry_id
      USING ERRCODE = '42501';
  END IF;

  IF v_entry.committed_at IS NULL OR v_entry.committed_at < now() - interval '15 minutes' THEN
    RAISE EXCEPTION 'cancel_orphaned_entry: journal entry % was not posted within the last 15 minutes; use a storno instead', p_entry_id
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.journal_entries r
     WHERE r.company_id = p_company_id
       AND r.id <> p_entry_id
       AND r.status <> 'cancelled'
       AND (r.reverses_id = p_entry_id
            OR r.correction_of_id = p_entry_id
            OR r.reversed_by_id = p_entry_id)
  ) THEN
    RAISE EXCEPTION 'cancel_orphaned_entry: journal entry % is referenced by another verifikat; use a storno instead', p_entry_id
      USING ERRCODE = '55000';
  END IF;

  SELECT fp.is_closed, fp.locked_at
    INTO v_is_closed, v_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.id = v_entry.fiscal_period_id;

  IF v_is_closed OR v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'cancel_orphaned_entry: the fiscal period of journal entry % is closed or locked', p_entry_id
      USING ERRCODE = '55000';
  END IF;

  SELECT cs.bookkeeping_locked_through INTO v_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF v_lock_date IS NOT NULL AND v_entry.entry_date <= v_lock_date THEN
    RAISE EXCEPTION 'cancel_orphaned_entry: bookkeeping is locked through % (journal entry %)', v_lock_date, p_entry_id
      USING ERRCODE = '55000';
  END IF;

  PERFORM set_config('gnubok.allow_posted_cancel', 'true', true);

  UPDATE public.journal_entries
     SET status = 'cancelled'
   WHERE id = p_entry_id AND status = 'posted';

  PERFORM set_config('gnubok.allow_posted_cancel', 'false', true);

  -- The stranded number as a closed single-voucher range: every reader keys
  -- explanations on series:gap_start:gap_end. An existing explanation for
  -- the same number (possibly a human's) wins, and gap_recorded then says
  -- false: it reports whether this call wrote the row.
  --
  -- Being DEFINER, this insert would bypass the owner/admin RLS on
  -- voucher_gap_explanations, so a JWT caller gets the row only when that
  -- same predicate would have let them insert it themselves. Otherwise the
  -- note is skipped (gap_recorded false); no gap is left unexplained, since
  -- the cancelled header still occupies the number, which detect_voucher_gaps
  -- counts as used. A trusted backend caller keeps writing it.
  IF v_explanation IS NOT NULL
     AND (NOT public.jwt_caller_is_end_user()
          OR EXISTS (
            SELECT 1
              FROM public.team_members tm
              JOIN public.companies c ON c.team_id = tm.team_id
             WHERE c.id = p_company_id
               AND tm.user_id = v_actor
               AND tm.role IN ('owner', 'admin'))) THEN
    v_series := coalesce(nullif(v_entry.voucher_series, ''), 'A');
    INSERT INTO public.voucher_gap_explanations
      (company_id, user_id, fiscal_period_id, voucher_series, gap_start, gap_end, explanation)
    VALUES
      (p_company_id, v_actor, v_entry.fiscal_period_id, v_series,
       v_entry.voucher_number, v_entry.voucher_number, left(v_explanation, 500))
    ON CONFLICT (company_id, fiscal_period_id, voucher_series, gap_start, gap_end) DO NOTHING;
    GET DIAGNOSTICS v_gap_rows = ROW_COUNT;
    v_gap_recorded := v_gap_rows > 0;
  END IF;

  RETURN jsonb_build_object(
    'cancelled', true,
    'previous_status', 'posted',
    'voucher_series', v_entry.voucher_series,
    'voucher_number', v_entry.voucher_number,
    'gap_recorded', v_gap_recorded
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_orphaned_entry(uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_orphaned_entry(uuid, uuid, uuid, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
