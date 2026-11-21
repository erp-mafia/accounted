-- support_remove_undone_sie_import: a support operation removes an undone
-- SIE import and its stornos from the ledger, and gives the replacement
-- import back its own voucher numbers (crm#1954).
--
-- The case. A company moving from another system imported a partial SIE
-- file, undid it (the undo posts one storno per imported verifikat) and then
-- imported the full file. The year reads A1-A400 (the undone import, all
-- reversed), A401-A800 (their stornos) and A801-A1358 (the full import,
-- whose source_voucher_number is the old system's number, 1-558). The
-- accountant wants the books to read as they did in the old system: A1-A558.
--
-- THIS IS A DELIBERATE, NARROW EXCEPTION, decided by the founders on
-- 2026-11-20, to CLAUDE.md Hard Rule 1 (posted verifikat change only through
-- storno or inline rättelse and are never deleted), Hard Rule 4 (period locks
-- hold) and the SIE retention guard retain_sie_batch_entry. Posted verifikat
-- are deleted, and posted verifikat in a locked year are renumbered. It is
-- narrow in these ways:
--   * One SECURITY DEFINER function, EXECUTE for service_role only, run by
--     support for one company and one import per call. It is a dry run unless
--     p_dry_run is false.
--   * It acts only on an undone import whose every verifikat is reversed by a
--     posted storno of its own, where the two sets net to zero per account and
--     dimension, no other record points at any of them, the year is not
--     closed and nothing relying on it was filed or signed (VAT, AGI, ROT/RUT,
--     annual report: the checks fiscal_year_reset_snapshot owns). Any miss
--     raises a typed SIE_REMOVAL_* error before anything is written.
--   * It renumbers only when every other verifikat of the series belongs to
--     one completed import of the same year, with distinct old-system
--     numbers and no gap explanations yet. Otherwise nothing is renumbered
--     and the freed numbers get gap explanations (BFNAR 2013:2).
--   * The trigger bypasses below are honoured only inside that function: a
--     transaction-local setting naming the import, read only when
--     current_user is the owner of support_remove_undone_sie_import (a
--     statement inside a SECURITY DEFINER function runs as its owner; a
--     direct Data API write runs as anon, authenticated or service_role and
--     never passes), and cleared before the function goes on. The renumber
--     bypass lets voucher_number (and updated_at) change and nothing else.
--   * What is deleted stays in audit_log: the audit triggers write every
--     deleted verifikat and line, and one summary row names the file, the
--     counts, the ranges, the reason and the support actor. The undone
--     sie_imports row is kept and carries the receipt in
--     job_result.support_removal, which the import history and the
--     behandlingshistorik read.
-- The year's locked_at is left as it is: the year stays locked.
--
-- Triggers changed (CREATE OR REPLACE with the current body copied and one
-- branch added; owners, grants and trigger definitions are unchanged):
--   * retain_sie_batch_entry (body of 20260913200625): may delete a reversed
--     verifikat of the named undone import.
--   * enforce_journal_entry_immutability (body of 20260915140000, migration
--     017's enforcement trigger): may change voucher_number of a posted
--     verifikat of the named replacement import.
--   * enforce_period_lock (body of 20240101000017 with the search_path of
--     20260304191528, migration 017's enforcement trigger): the same
--     voucher_number change in a locked, not closed, year.
-- Not changed, and why: the DELETE guards (the DELETE branch of
-- enforce_journal_entry_immutability, enforce_retention_journal_entries and
-- the journal line guards) already honour gnubok.allow_delete, which the
-- function sets around its one DELETE; retain_sie_undo_reversal fires only on
-- a reversed to posted status flip, which never happens here;
-- enforce_company_lock_date and the other entry-date guards fire only on
-- UPDATE OF entry_date; guard_sie_entry_provenance refuses only provenance
-- column changes. uq_journal_entries_voucher_number is kept: when a target
-- number is still held, the renumber goes through a temporary offset.
--
-- pg-test: covered-by tests/pg/support-remove-undone-sie-import.pg.test.ts

-- 1. retain_sie_batch_entry ----------------------------------------------------

CREATE OR REPLACE FUNCTION public.retain_sie_batch_entry() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.import_batch_id IS NOT NULL THEN
    IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
      AND current_user = (SELECT pg_get_userbyid(proowner) FROM pg_proc
        WHERE oid = 'public.cleanup_sandbox_user(uuid)'::regprocedure)
      AND (SELECT bool_and(cs.is_sandbox IS TRUE) FROM public.company_settings cs
        WHERE cs.company_id = OLD.company_id) IS TRUE THEN RETURN OLD; END IF;
    -- support_remove_undone_sie_import (crm#1954): a reversed verifikat of
    -- the one undone import it names, while it runs as its owner.
    IF coalesce(current_setting('gnubok.support_sie_removal', true), '') <> '' THEN
      IF current_setting('gnubok.support_sie_removal', true) = OLD.import_batch_id::text
        AND OLD.status = 'reversed'
        AND current_user = (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
          WHERE p.oid = to_regprocedure('public.support_remove_undone_sie_import(uuid,uuid,text,text,boolean)'))
      THEN RETURN OLD; END IF;
    END IF;
    RAISE EXCEPTION 'SIE batch entries cannot be deleted; use batch storno' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

-- 2. enforce_journal_entry_immutability ---------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_last_number integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('gnubok.allow_delete', true) = 'true' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Cannot delete journal entries (id: %, status: %). Use cancelled status instead.',
      OLD.id, OLD.status;
  END IF;

  IF OLD.status = 'draft' AND NEW.status IN ('draft', 'posted', 'cancelled') THEN
    IF NEW.status = 'posted' AND current_user IN ('anon', 'authenticated') THEN
      SELECT vs.last_number INTO v_last_number
      FROM public.voucher_sequences vs
      WHERE vs.company_id = NEW.company_id
        AND vs.fiscal_period_id = NEW.fiscal_period_id
        AND vs.voucher_series = NEW.voucher_series;
      IF NEW.voucher_number IS NULL OR NEW.voucher_number <= 0
         OR v_last_number IS NULL OR NEW.voucher_number > v_last_number THEN
        RAISE EXCEPTION 'journal_entries: voucher number % was not issued by the sequence; post through commit_journal_entry',
          NEW.voucher_number USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status IN ('reversed', 'cancelled') THEN
    IF NEW.status = 'reversed' THEN
      -- Unchanged from the live definition: the storno path sets
      -- reversed_by_id alongside the status, so this stays an enumerated list.
      IF NEW.description != OLD.description OR NEW.entry_date != OLD.entry_date
         OR NEW.fiscal_period_id != OLD.fiscal_period_id
         OR NEW.voucher_number != OLD.voucher_number
         OR NEW.commit_method IS DISTINCT FROM OLD.commit_method
         OR NEW.rubric_version IS DISTINCT FROM OLD.rubric_version
         OR NEW.source_voucher_series IS DISTINCT FROM OLD.source_voucher_series
         OR NEW.source_voucher_number IS DISTINCT FROM OLD.source_voucher_number THEN
        RAISE EXCEPTION 'Cannot modify fields of a posted entry during reversal (id: %)', OLD.id;
      END IF;
    ELSE
      -- cancelled: nothing but the status may move.
      IF (to_jsonb(NEW) - 'status' - 'updated_at') != (to_jsonb(OLD) - 'status' - 'updated_at') THEN
        RAISE EXCEPTION 'Cannot modify fields of a posted entry during cancellation (id: %)', OLD.id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- Narrow un-reversal path: when delete_last_voucher removes a storno entry,
  -- it flips the original from 'reversed' back to 'posted'. No other fields
  -- may change, and the bypass flag must be set.
  IF OLD.status = 'reversed' AND NEW.status = 'posted'
     AND current_setting('gnubok.allow_delete', true) = 'true' THEN
    IF NEW.description != OLD.description OR NEW.entry_date != OLD.entry_date
       OR NEW.fiscal_period_id != OLD.fiscal_period_id
       OR NEW.voucher_number != OLD.voucher_number THEN
      RAISE EXCEPTION 'Cannot modify fields during un-reversal (id: %)', OLD.id;
    END IF;
    RETURN NEW;
  END IF;

  -- Notes-only annotation on a committed entry (posted/reversed/cancelled).
  IF OLD.status = NEW.status
     AND OLD.status IN ('posted', 'reversed', 'cancelled')
     AND (to_jsonb(NEW) - 'notes' - 'updated_at')
       = (to_jsonb(OLD) - 'notes' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  -- Source-type re-tag of a mis-typed opening balance (mark_entry_as_opening_balance).
  IF OLD.status = NEW.status
     AND OLD.status = 'posted'
     AND current_setting('gnubok.allow_source_type_retag', true) = 'true'
     AND OLD.source_type IN ('manual', 'import')
     AND NEW.source_type = 'opening_balance'
     AND (to_jsonb(NEW) - 'source_type' - 'updated_at')
       = (to_jsonb(OLD) - 'source_type' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  -- Metadata rättelse of a posted verifikation (correct_entry_metadata).
  IF OLD.status = NEW.status
     AND OLD.status = 'posted'
     AND current_setting('gnubok.allow_metadata_rattelse', true) = 'true'
     AND (to_jsonb(NEW) - 'description' - 'entry_date' - 'updated_at')
       = (to_jsonb(OLD) - 'description' - 'entry_date' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  -- Renumbering by support_remove_undone_sie_import (crm#1954): a posted
  -- verifikat of the one replacement import it names gets its old-system
  -- number. Only voucher_number (and updated_at) may change, and only while
  -- that function runs as its owner.
  IF OLD.status = 'posted' AND NEW.status = 'posted'
     AND coalesce(current_setting('gnubok.support_sie_renumber', true), '') <> '' THEN
    IF current_setting('gnubok.support_sie_renumber', true) = OLD.import_batch_id::text
       AND current_user = (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
         WHERE p.oid = to_regprocedure('public.support_remove_undone_sie_import(uuid,uuid,text,text,boolean)'))
       AND (to_jsonb(NEW) - 'voucher_number' - 'updated_at')
         = (to_jsonb(OLD) - 'voucher_number' - 'updated_at') THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'Cannot modify a % journal entry (id: %). Committed entries are immutable per Bokforingslagen.',
    OLD.status, OLD.id;
END;
$$;

-- 3. enforce_period_lock ------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_period_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_is_closed boolean;
  v_locked_at timestamptz;
  v_period_name text;
BEGIN
  SELECT is_closed, locked_at, name
  INTO v_is_closed, v_locked_at, v_period_name
  FROM public.fiscal_periods
  WHERE id = NEW.fiscal_period_id;

  IF v_is_closed OR v_locked_at IS NOT NULL THEN
    -- Renumbering by support_remove_undone_sie_import (crm#1954) in a
    -- locked, not closed, year: a posted verifikat of the one replacement
    -- import it names, voucher_number (and updated_at) only, while that
    -- function runs as its owner.
    IF TG_OP = 'UPDATE' AND NOT coalesce(v_is_closed, false)
       AND coalesce(current_setting('gnubok.support_sie_renumber', true), '') <> '' THEN
      IF OLD.status = 'posted' AND NEW.status = 'posted'
         AND current_setting('gnubok.support_sie_renumber', true) = OLD.import_batch_id::text
         AND current_user = (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
           WHERE p.oid = to_regprocedure('public.support_remove_undone_sie_import(uuid,uuid,text,text,boolean)'))
         AND (to_jsonb(NEW) - 'voucher_number' - 'updated_at')
           = (to_jsonb(OLD) - 'voucher_number' - 'updated_at') THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'Cannot write to locked/closed fiscal period "%" (is_closed=%, locked_at=%)',
      v_period_name, v_is_closed, v_locked_at;
  END IF;

  RETURN NEW;
END;
$$;

-- 4. The support operation -------------------------------------------------

CREATE FUNCTION public.support_remove_undone_sie_import(
  p_company_id  uuid,
  p_import_id   uuid,
  p_reason      text,
  p_actor_label text,
  p_dry_run     boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dry_run        boolean := coalesce(p_dry_run, true);
  v_reason         text := btrim(coalesce(p_reason, ''));
  v_actor          text := btrim(coalesce(p_actor_label, ''));
  v_actor_label    text;
  v_today          text := to_char(public.stockholm_today(), 'YYYY-MM-DD');
  v_import         public.sie_imports%ROWTYPE;
  v_period         public.fiscal_periods%ROWTYPE;
  v_reset          jsonb;
  v_refused        text;
  v_tolerated      jsonb;
  v_originals      uuid[];
  v_stornos        uuid[];
  v_removed        uuid[];
  v_lines          uuid[];
  v_line_count     integer;
  v_rattelse_rows  integer;
  v_fk             record;
  v_count          bigint;
  v_refs           jsonb := '[]'::jsonb;
  v_balance_before jsonb;
  v_balance_after  jsonb;
  v_series         text;
  v_plan           jsonb;
  v_plans          jsonb := '[]'::jsonb;
  v_removed_ranges jsonb;
  v_last_before    integer;
  v_last_after     integer;
  v_remaining      integer;
  v_batch          uuid;
  v_batch_count    integer;
  v_why            text;
  v_rep_id         uuid;
  v_rep_filename   text;
  v_rep_kind       text;
  v_rep_state      text;
  v_rep_period     uuid;
  v_from           jsonb;
  v_to             jsonb;
  v_renumbered     integer;
  v_offset         integer;
  v_gaps           jsonb;
  v_text           text;
  v_receipt        jsonb;
BEGIN
  IF p_company_id IS NULL OR p_import_id IS NULL
     OR char_length(v_reason) < 10 OR char_length(v_reason) > 1000
     OR char_length(v_actor) < 2 OR char_length(v_actor) > 120 THEN
    RAISE EXCEPTION 'SIE_REMOVAL_INVALID_INPUT: a company, an import, a reason of 10 to 1000 characters and the support actor (2 to 120 characters) are required'
      USING ERRCODE = '22023', HINT = 'invalid_input';
  END IF;
  v_actor_label := 'Support: ' || v_actor;

  -- The lock every SIE job RPC takes first: no import, undo or repair of
  -- this company can run beside this call.
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text, 0));

  IF NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company_id) THEN
    RAISE EXCEPTION 'SIE_REMOVAL_NOT_FOUND: company % not found', p_company_id
      USING ERRCODE = 'P0002', HINT = 'company_not_found';
  END IF;
  IF EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company_id AND c.archived_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.company_migration_resets m WHERE m.source_company_id = p_company_id) THEN
    RAISE EXCEPTION 'SIE_REMOVAL_COMPANY_ARCHIVED: the company is archived; its records are retained as they are'
      USING ERRCODE = '55000', HINT = 'company_archived';
  END IF;

  -- 1. Preconditions. Nothing below writes until all of them hold. ----------

  SELECT * INTO v_import
    FROM public.sie_imports
   WHERE id = p_import_id
     AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIE_REMOVAL_NOT_FOUND: SIE import % not found for company %', p_import_id, p_company_id
      USING ERRCODE = 'P0002', HINT = 'import_not_found';
  END IF;
  IF v_import.job_kind IS DISTINCT FROM 'import' OR v_import.job_state IS DISTINCT FROM 'undone' THEN
    RAISE EXCEPTION 'SIE_REMOVAL_IMPORT_NOT_UNDONE: only an undone SIE import can be removed (job_state %)',
      coalesce(v_import.job_state, 'none')
      USING ERRCODE = '55000', HINT = 'import_not_undone';
  END IF;
  IF jsonb_typeof(v_import.job_result) = 'object' AND v_import.job_result ? 'support_removal' THEN
    RAISE EXCEPTION 'SIE_REMOVAL_ALREADY_REMOVED: the import was removed at %',
      v_import.job_result -> 'support_removal' ->> 'removed_at'
      USING ERRCODE = '55000', HINT = 'already_removed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.sie_imports s
     WHERE s.company_id = p_company_id
       AND s.job_state IS NOT NULL
       AND s.job_state NOT IN ('completed', 'undone', 'failed')
  ) THEN
    RAISE EXCEPTION 'SIE_REMOVAL_IMPORT_RUNNING: an SIE job of the company has not finished'
      USING ERRCODE = '55000', HINT = 'import_running';
  END IF;

  SELECT * INTO v_period
    FROM public.fiscal_periods
   WHERE id = v_import.fiscal_period_id
     AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIE_REMOVAL_NOT_FOUND: the import has no fiscal year of the company'
      USING ERRCODE = 'P0002', HINT = 'period_not_found';
  END IF;
  IF coalesce(v_period.is_closed, false) OR v_period.closed_at IS NOT NULL
     OR v_period.closing_entry_id IS NOT NULL OR coalesce(v_period.closed_externally, false) THEN
    RAISE EXCEPTION 'SIE_REMOVAL_PERIOD_CLOSED: the fiscal year "%" is closed', v_period.name
      USING ERRCODE = '55000', HINT = 'period_closed';
  END IF;
  IF v_period.import_hold IS NOT NULL THEN
    RAISE EXCEPTION 'SIE_REMOVAL_IMPORT_RUNNING: the fiscal year is held by an SIE job'
      USING ERRCODE = '55000', HINT = 'import_running';
  END IF;

  -- Filed or signed state that relies on the year's verifikat: the year
  -- reset's own checks (VAT lock or submit, AGI, ROT/RUT, annual report,
  -- bokslut). The blockers that describe this very situation, or that the
  -- removal cannot affect because the balances do not move, are tolerated
  -- and reported; any other blocker, including one added later, refuses.
  v_reset := public.fiscal_year_reset_snapshot(p_company_id, v_period.id);
  SELECT string_agg(DISTINCT b ->> 'code', ', ')
    INTO v_refused
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_reset -> 'blockers') = 'array'
                                   THEN v_reset -> 'blockers' ELSE '[]'::jsonb END) b
   WHERE coalesce(b ->> 'code', '') NOT IN (
     'period_locked', 'retained_import_history', 'sie_import_in_place',
     'company_lock_date', 'next_year_dependency', 'cross_year_reference');
  IF v_reset ->> 'ok' IS DISTINCT FROM 'true' OR v_refused IS NOT NULL THEN
    RAISE EXCEPTION 'SIE_REMOVAL_PERIOD_RELIED_UPON: the fiscal year has filed or closing state (%)',
      coalesce(v_refused, v_reset ->> 'code', 'unknown')
      USING ERRCODE = '55000', HINT = 'period_relied_upon';
  END IF;
  SELECT coalesce(jsonb_agg(b ORDER BY b ->> 'code'), '[]'::jsonb)
    INTO v_tolerated
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_reset -> 'blockers') = 'array'
                                   THEN v_reset -> 'blockers' ELSE '[]'::jsonb END) b;

  SELECT array_agg(j.id ORDER BY j.id)
    INTO v_originals
    FROM public.journal_entries j
   WHERE j.company_id = p_company_id
     AND j.import_batch_id = p_import_id;
  IF v_originals IS NULL THEN
    RAISE EXCEPTION 'SIE_REMOVAL_NOTHING_TO_REMOVE: the import has no verifikat'
      USING ERRCODE = '55000', HINT = 'nothing_to_remove';
  END IF;
  PERFORM 1 FROM public.journal_entries j WHERE j.id = ANY (v_originals) ORDER BY j.id FOR UPDATE;

  -- Every verifikat of the import is reversed, in the import's year, by a
  -- posted storno of its own that nothing has reversed or corrected.
  IF EXISTS (
    SELECT 1
      FROM public.journal_entries o
     WHERE o.id = ANY (v_originals)
       AND (o.status IS DISTINCT FROM 'reversed'
            OR o.fiscal_period_id IS DISTINCT FROM v_period.id
            OR NOT EXISTS (
              SELECT 1
                FROM public.journal_entries s
               WHERE s.id = o.reversed_by_id
                 AND s.company_id = p_company_id
                 AND s.reverses_id = o.id
                 AND s.source_type = 'storno'
                 AND s.status = 'posted'
                 AND s.fiscal_period_id = v_period.id
                 AND s.import_batch_id IS NULL
                 AND s.correction_of_id IS NULL
                 AND s.reversed_by_id IS NULL))
  ) THEN
    RAISE EXCEPTION 'SIE_REMOVAL_NOT_FULLY_REVERSED: every verifikat of the import must be reversed by its own posted storno in the same fiscal year'
      USING ERRCODE = '55000', HINT = 'not_fully_reversed';
  END IF;

  SELECT array_agg(o.reversed_by_id ORDER BY o.reversed_by_id)
    INTO v_stornos
    FROM public.journal_entries o
   WHERE o.id = ANY (v_originals);
  PERFORM 1 FROM public.journal_entries j WHERE j.id = ANY (v_stornos) ORDER BY j.id FOR UPDATE;
  v_removed := v_originals || v_stornos;

  SELECT array_agg(l.id), count(*)::integer
    INTO v_lines, v_line_count
    FROM public.journal_entry_lines l
   WHERE l.journal_entry_id = ANY (v_removed);

  -- The two sets cancel out on every account and dimension set, so no
  -- balance, report or opening balance of a later year moves.
  IF EXISTS (
    SELECT 1
      FROM public.journal_entry_lines l
     WHERE l.journal_entry_id = ANY (v_removed)
     GROUP BY l.account_number, coalesce(l.dimensions, '{}'::jsonb)
    HAVING round(coalesce(sum(l.debit_amount), 0) - coalesce(sum(l.credit_amount), 0), 2) <> 0
  ) THEN
    RAISE EXCEPTION 'SIE_REMOVAL_NOT_NET_ZERO: the import and its stornos do not cancel out on every account'
      USING ERRCODE = '55000', HINT = 'not_net_zero';
  END IF;

  -- No other record points at any of them, through any foreign key to
  -- journal_entries or journal_entry_lines, whatever its delete action: a
  -- document, bank row, voucher link, invoice, payment, register row or a
  -- verifikat outside the set. The lines themselves, the set's own storno
  -- links and the undone import's own opening balance pointer are expected.
  FOR v_fk IN
    SELECT c.conrelid::regclass AS tbl, c.confrelid::regclass AS target, a.attname::text AS col
      FROM pg_catalog.pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(src, dst)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.src
      JOIN pg_catalog.pg_attribute t ON t.attrelid = c.confrelid AND t.attnum = k.dst
     WHERE c.contype = 'f'
       AND c.confrelid IN ('public.journal_entries'::regclass, 'public.journal_entry_lines'::regclass)
       AND t.attname = 'id'
     ORDER BY c.conrelid::regclass::text, a.attname
  LOOP
    CONTINUE WHEN v_fk.tbl = 'public.journal_entry_lines'::regclass
              AND v_fk.target = 'public.journal_entries'::regclass;
    EXECUTE format(
      'SELECT count(*) FROM %s r WHERE r.%I = ANY ($1)%s',
      v_fk.tbl,
      v_fk.col,
      CASE
        WHEN v_fk.tbl = v_fk.target THEN ' AND NOT (r.id = ANY ($1))'
        WHEN v_fk.tbl = 'public.sie_imports'::regclass AND v_fk.col = 'opening_balance_entry_id'
          THEN ' AND r.id <> $2'
        ELSE ''
      END)
      INTO v_count
      USING CASE WHEN v_fk.target = 'public.journal_entries'::regclass THEN v_removed ELSE v_lines END,
            p_import_id;
    IF v_count > 0 THEN
      v_refs := v_refs || jsonb_build_array(jsonb_build_object(
        'table', v_fk.tbl::text, 'column', v_fk.col, 'rows', v_count));
    END IF;
  END LOOP;
  IF jsonb_array_length(v_refs) > 0 THEN
    RAISE EXCEPTION 'SIE_REMOVAL_ENTRIES_REFERENCED: other records point at the verifikat to remove: %',
      (SELECT string_agg(format('%s.%s (%s)', r ->> 'table', r ->> 'column', r ->> 'rows'), ', ')
         FROM jsonb_array_elements(v_refs) r)
      USING ERRCODE = '55000', HINT = 'entries_referenced', DETAIL = v_refs::text;
  END IF;

  -- The source system's correction history of the removed verifikat (no
  -- foreign key): kept, and counted in the receipt.
  SELECT count(*)::integer INTO v_rattelse_rows
    FROM public.journal_entry_rattelse_log r
   WHERE r.company_id = p_company_id
     AND r.journal_entry_id = ANY (v_removed);

  SELECT coalesce(jsonb_object_agg(b.account_number, b.net), '{}'::jsonb)
    INTO v_balance_before
    FROM (
      SELECT l.account_number,
             round(sum(coalesce(l.debit_amount, 0) - coalesce(l.credit_amount, 0)), 2) AS net
        FROM public.journal_entry_lines l
        JOIN public.journal_entries e ON e.id = l.journal_entry_id
       WHERE e.company_id = p_company_id
         AND e.fiscal_period_id = v_period.id
         AND e.status IN ('posted', 'reversed')
       GROUP BY l.account_number
      HAVING round(sum(coalesce(l.debit_amount, 0) - coalesce(l.credit_amount, 0)), 2) <> 0
    ) b;

  -- The plan per series: renumber the replacement to the old system's
  -- numbers, or explain the freed numbers as a gap.
  FOR v_series IN
    SELECT DISTINCT j.voucher_series FROM public.journal_entries j WHERE j.id = ANY (v_removed) ORDER BY 1
  LOOP
    v_last_before := NULL; v_last_after := NULL; v_batch := NULL; v_why := NULL;
    v_rep_id := NULL; v_rep_filename := NULL; v_from := NULL; v_to := NULL;
    v_renumbered := 0; v_gaps := '[]'::jsonb;

    SELECT vs.last_number INTO v_last_before
      FROM public.voucher_sequences vs
     WHERE vs.company_id = p_company_id
       AND vs.fiscal_period_id = v_period.id
       AND vs.voucher_series = v_series
     FOR UPDATE;

    SELECT coalesce(jsonb_agg(jsonb_build_object('from', r.lo, 'to', r.hi) ORDER BY r.lo), '[]'::jsonb)
      INTO v_removed_ranges
      FROM (
        SELECT min(x.n) AS lo, max(x.n) AS hi
          FROM (
            SELECT j.voucher_number AS n,
                   j.voucher_number - row_number() OVER (ORDER BY j.voucher_number) AS grp
              FROM public.journal_entries j
             WHERE j.id = ANY (v_removed)
               AND j.voucher_series = v_series
          ) x
         GROUP BY x.grp
      ) r;

    -- What stays in the series once the set is gone.
    SELECT count(*)::integer,
           count(DISTINCT j.import_batch_id)::integer
             + CASE WHEN bool_or(j.import_batch_id IS NULL) THEN 1 ELSE 0 END,
           min(j.import_batch_id::text)::uuid
      INTO v_remaining, v_batch_count, v_batch
      FROM public.journal_entries j
     WHERE j.company_id = p_company_id
       AND j.fiscal_period_id = v_period.id
       AND j.voucher_series = v_series
       AND j.status <> 'draft'
       AND NOT (j.id = ANY (v_removed));

    IF v_remaining > 0 THEN
      IF v_batch_count <> 1 OR v_batch IS NULL THEN
        v_why := 'other_verifikat_in_series';
      ELSE
        SELECT s.id, s.filename, s.job_kind, s.job_state, s.fiscal_period_id
          INTO v_rep_id, v_rep_filename, v_rep_kind, v_rep_state, v_rep_period
          FROM public.sie_imports s
         WHERE s.id = v_batch
           AND s.company_id = p_company_id;
        IF v_rep_id IS NULL OR v_rep_kind IS DISTINCT FROM 'import'
           OR v_rep_state IS DISTINCT FROM 'completed' OR v_rep_period IS DISTINCT FROM v_period.id THEN
          v_why := 'replacement_is_not_a_completed_import_of_the_year';
        ELSIF EXISTS (
          SELECT 1 FROM public.journal_entries j
           WHERE j.company_id = p_company_id AND j.fiscal_period_id = v_period.id
             AND j.voucher_series = v_series AND j.import_batch_id = v_batch AND j.status <> 'draft'
             AND (j.status <> 'posted' OR j.source_voucher_number IS NULL OR j.source_voucher_number <= 0)
        ) THEN
          v_why := 'replacement_lacks_source_numbers';
        ELSIF EXISTS (
          SELECT 1 FROM public.journal_entries j
           WHERE j.company_id = p_company_id AND j.fiscal_period_id = v_period.id
             AND j.voucher_series = v_series AND j.import_batch_id = v_batch AND j.status <> 'draft'
           GROUP BY j.source_voucher_number
          HAVING count(*) > 1
        ) THEN
          v_why := 'replacement_source_numbers_repeat';
        ELSIF (
          SELECT count(*) FROM (
            SELECT DISTINCT j.source_voucher_series FROM public.journal_entries j
             WHERE j.company_id = p_company_id AND j.fiscal_period_id = v_period.id
               AND j.voucher_series = v_series AND j.import_batch_id = v_batch AND j.status <> 'draft'
          ) d
        ) <> 1 THEN
          v_why := 'replacement_spans_several_source_series';
        END IF;
      END IF;
    END IF;
    IF v_why IS NULL AND EXISTS (
      SELECT 1 FROM public.voucher_gap_explanations g
       WHERE g.company_id = p_company_id
         AND g.fiscal_period_id = v_period.id
         AND g.voucher_series = v_series
    ) THEN
      v_why := 'series_has_gap_explanations';
    END IF;

    IF v_why IS NULL THEN
      -- Renumber: each verifikat of the replacement takes its old-system
      -- number; the counter continues after the highest kept number; a gap
      -- in the old system's own series gets an explanation.
      IF v_remaining > 0 THEN
        SELECT jsonb_build_object('from', min(j.voucher_number), 'to', max(j.voucher_number)),
               jsonb_build_object('from', min(j.source_voucher_number), 'to', max(j.source_voucher_number)),
               (count(*) FILTER (WHERE j.voucher_number <> j.source_voucher_number))::integer,
               max(j.source_voucher_number)
          INTO v_from, v_to, v_renumbered, v_last_after
          FROM public.journal_entries j
         WHERE j.company_id = p_company_id AND j.fiscal_period_id = v_period.id
           AND j.voucher_series = v_series AND j.import_batch_id = v_batch AND j.status <> 'draft';
        SELECT coalesce(jsonb_agg(jsonb_build_object('gap_start', x.n + 1, 'gap_end', x.nxt - 1) ORDER BY x.n), '[]'::jsonb)
          INTO v_gaps
          FROM (
            SELECT u.n, lead(u.n) OVER (ORDER BY u.n) AS nxt
              FROM (
                SELECT 0 AS n
                UNION ALL
                SELECT j.source_voucher_number
                  FROM public.journal_entries j
                 WHERE j.company_id = p_company_id AND j.fiscal_period_id = v_period.id
                   AND j.voucher_series = v_series AND j.import_batch_id = v_batch AND j.status <> 'draft'
              ) u
          ) x
         WHERE x.nxt > x.n + 1;
      ELSE
        -- Nothing else in the series: it starts over.
        v_last_after := 0;
        v_batch := NULL;
      END IF;
    ELSE
      -- Explain the freed numbers: every gap the removal leaves (between the
      -- kept numbers, from 1, and up to the counter) that holds one of them.
      v_last_after := v_last_before;
      v_batch := NULL;
      WITH kept AS (
        SELECT j.voucher_number AS n
          FROM public.journal_entries j
         WHERE j.company_id = p_company_id AND j.fiscal_period_id = v_period.id
           AND j.voucher_series = v_series AND j.status <> 'draft'
           AND NOT (j.id = ANY (v_removed))
      ), bounds AS (
        SELECT u.n, lead(u.n) OVER (ORDER BY u.n) AS nxt
          FROM (SELECT 0 AS n UNION ALL SELECT kept.n FROM kept) u
      ), gaps AS (
        SELECT b.n + 1 AS gap_start, b.nxt - 1 AS gap_end FROM bounds b WHERE b.nxt > b.n + 1
        UNION ALL
        SELECT max(u.n) + 1, coalesce(v_last_before, 0)
          FROM (SELECT 0 AS n UNION ALL SELECT kept.n FROM kept) u
        HAVING coalesce(v_last_before, 0) > max(u.n)
      )
      SELECT coalesce(jsonb_agg(jsonb_build_object('gap_start', g.gap_start, 'gap_end', g.gap_end) ORDER BY g.gap_start), '[]'::jsonb)
        INTO v_gaps
        FROM gaps g
       WHERE EXISTS (
         SELECT 1 FROM public.journal_entries r
          WHERE r.id = ANY (v_removed)
            AND r.voucher_series = v_series
            AND r.voucher_number BETWEEN g.gap_start AND g.gap_end);
    END IF;

    v_plans := v_plans || jsonb_build_array(jsonb_build_object(
      'series', v_series,
      'mode', CASE WHEN v_why IS NULL THEN 'renumber' ELSE 'gap_explanations' END,
      'not_renumbered_because', v_why,
      'removed_numbers', v_removed_ranges,
      'replacement_import_id', v_batch,
      'replacement_filename', CASE WHEN v_batch IS NOT NULL THEN v_rep_filename END,
      'renumbered', v_renumbered,
      'renumbered_from', v_from,
      'renumbered_to', v_to,
      'last_number_before', v_last_before,
      'last_number_after', v_last_after,
      'gap_explanations', v_gaps));
  END LOOP;

  v_receipt := jsonb_build_object(
    'ok', true,
    'dry_run', v_dry_run,
    'company_id', p_company_id,
    'import_id', p_import_id,
    'filename', v_import.filename,
    'fiscal_period', jsonb_build_object(
      'id', v_period.id, 'name', v_period.name,
      'start', v_period.period_start, 'end', v_period.period_end,
      'locked_at', v_period.locked_at),
    'removed', jsonb_build_object(
      'imported_verifikat', cardinality(v_originals),
      'stornos', cardinality(v_stornos),
      'verifikat', cardinality(v_removed),
      'lines', coalesce(v_line_count, 0)),
    'series', v_plans,
    'retained_rattelse_log_rows', v_rattelse_rows,
    'tolerated_year_state', v_tolerated,
    'reason', v_reason,
    'actor_label', v_actor_label,
    'removed_at', NULL);

  IF v_dry_run THEN
    RETURN v_receipt;
  END IF;

  -- 2. Delete the stornos and the undone import's verifikat. ----------------
  -- One statement, so the storno links inside the set never fire their ON
  -- DELETE SET NULL as an UPDATE of a posted verifikat; the lines cascade.
  -- The audit triggers write every deleted verifikat and line.

  PERFORM set_config('gnubok.actor_type', 'system', true);
  PERFORM set_config('gnubok.actor_label', v_actor_label, true);

  UPDATE public.sie_imports
     SET opening_balance_entry_id = NULL
   WHERE id = p_import_id
     AND opening_balance_entry_id = ANY (v_removed);

  PERFORM set_config('gnubok.allow_delete', 'true', true);
  PERFORM set_config('gnubok.support_sie_removal', p_import_id::text, true);
  DELETE FROM public.journal_entries j
   WHERE j.company_id = p_company_id
     AND j.id = ANY (v_removed);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM set_config('gnubok.support_sie_removal', '', true);
  PERFORM set_config('gnubok.allow_delete', '', true);
  IF v_count <> cardinality(v_removed) THEN
    RAISE EXCEPTION 'SIE_REMOVAL_INCOMPLETE: % of % verifikat deleted', v_count, cardinality(v_removed)
      USING ERRCODE = 'P0001', HINT = 'incomplete';
  END IF;

  -- 3. Renumber, or explain the gap, per series. ----------------------------

  FOR v_plan IN SELECT p FROM jsonb_array_elements(v_plans) p LOOP
    v_series := v_plan ->> 'series';

    IF v_plan ->> 'mode' = 'renumber' THEN
      v_batch := (v_plan ->> 'replacement_import_id')::uuid;
      IF v_batch IS NOT NULL AND (v_plan ->> 'renumbered')::integer > 0 THEN
        PERFORM set_config('gnubok.support_sie_renumber', v_batch::text, true);
        -- uq_journal_entries_voucher_number is checked row by row: when a
        -- target number is still held by another verifikat of the series,
        -- move the ones that change above every number first.
        IF EXISTS (
          SELECT 1
            FROM public.journal_entries a
            JOIN public.journal_entries b
              ON b.company_id = a.company_id
             AND b.fiscal_period_id = a.fiscal_period_id
             AND b.voucher_series = a.voucher_series
             AND b.voucher_number = a.source_voucher_number
             AND b.id <> a.id
           WHERE a.company_id = p_company_id AND a.fiscal_period_id = v_period.id
             AND a.voucher_series = v_series AND a.import_batch_id = v_batch
             AND a.voucher_number <> a.source_voucher_number
        ) THEN
          SELECT greatest(max(j.voucher_number), max(j.source_voucher_number))
            INTO v_offset
            FROM public.journal_entries j
           WHERE j.company_id = p_company_id AND j.fiscal_period_id = v_period.id
             AND j.voucher_series = v_series;
          UPDATE public.journal_entries j
             SET voucher_number = j.voucher_number + v_offset
           WHERE j.company_id = p_company_id AND j.fiscal_period_id = v_period.id
             AND j.voucher_series = v_series AND j.import_batch_id = v_batch
             AND j.status = 'posted'
             AND j.voucher_number <> j.source_voucher_number;
        END IF;
        UPDATE public.journal_entries j
           SET voucher_number = j.source_voucher_number
         WHERE j.company_id = p_company_id AND j.fiscal_period_id = v_period.id
           AND j.voucher_series = v_series AND j.import_batch_id = v_batch
           AND j.status = 'posted'
           AND j.voucher_number <> j.source_voucher_number;
        PERFORM set_config('gnubok.support_sie_renumber', '', true);

        IF EXISTS (
          SELECT 1 FROM public.journal_entries j
           WHERE j.company_id = p_company_id AND j.fiscal_period_id = v_period.id
             AND j.voucher_series = v_series AND j.import_batch_id = v_batch
             AND j.status <> 'draft'
             AND j.voucher_number IS DISTINCT FROM j.source_voucher_number
        ) THEN
          RAISE EXCEPTION 'SIE_REMOVAL_INCOMPLETE: series % was not fully renumbered', v_series
            USING ERRCODE = 'P0001', HINT = 'incomplete';
        END IF;
      END IF;

      INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
      VALUES (p_company_id, v_import.user_id, v_period.id, v_series, (v_plan ->> 'last_number_after')::integer)
      ON CONFLICT (company_id, fiscal_period_id, voucher_series)
      DO UPDATE SET last_number = EXCLUDED.last_number, updated_at = now();

      v_text := format(
        'Numret finns inte i det tidigare systemets verifikationsserie: SIE-filen %s har inget verifikat med numret. Serien följer det systemets numrering sedan support tog bort en ångrad import %s.',
        coalesce(v_plan ->> 'replacement_filename', ''), v_today);
    ELSE
      v_text := format(
        'Numren användes av den ångrade SIE-importen %s och dess vändningsverifikationer, som support tog bort %s. Skäl: %s',
        coalesce(v_import.filename, p_import_id::text), v_today, v_reason);
    END IF;

    INSERT INTO public.voucher_gap_explanations
      (company_id, user_id, fiscal_period_id, voucher_series, gap_start, gap_end, explanation)
    SELECT p_company_id, v_import.user_id, v_period.id, v_series,
           (g ->> 'gap_start')::integer, (g ->> 'gap_end')::integer, left(v_text, 500)
      FROM jsonb_array_elements(v_plan -> 'gap_explanations') g
    ON CONFLICT (company_id, fiscal_period_id, voucher_series, gap_start, gap_end) DO NOTHING;
  END LOOP;

  -- Defense in depth: the year's balances are what they were.
  SELECT coalesce(jsonb_object_agg(b.account_number, b.net), '{}'::jsonb)
    INTO v_balance_after
    FROM (
      SELECT l.account_number,
             round(sum(coalesce(l.debit_amount, 0) - coalesce(l.credit_amount, 0)), 2) AS net
        FROM public.journal_entry_lines l
        JOIN public.journal_entries e ON e.id = l.journal_entry_id
       WHERE e.company_id = p_company_id
         AND e.fiscal_period_id = v_period.id
         AND e.status IN ('posted', 'reversed')
       GROUP BY l.account_number
      HAVING round(sum(coalesce(l.debit_amount, 0) - coalesce(l.credit_amount, 0)), 2) <> 0
    ) b;
  IF v_balance_after IS DISTINCT FROM v_balance_before THEN
    RAISE EXCEPTION 'SIE_REMOVAL_BALANCE_CHANGED: the fiscal year''s account balances would change'
      USING ERRCODE = 'P0001', HINT = 'balance_changed';
  END IF;

  -- 4. Record it. ------------------------------------------------------------

  v_receipt := v_receipt || jsonb_build_object('removed_at', clock_timestamp());

  -- The undone import stays in the history, now marked removed with its
  -- receipt (the import history and the behandlingshistorik read it).
  UPDATE public.sie_imports
     SET job_result = CASE WHEN jsonb_typeof(job_result) = 'object' THEN job_result ELSE '{}'::jsonb END
                      || jsonb_build_object('support_removal', v_receipt)
   WHERE id = p_import_id;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    old_state, new_state, description, actor_type, actor_label
  ) VALUES (
    v_import.user_id, p_company_id, 'UPDATE', 'sie_imports', p_import_id, NULL,
    jsonb_build_object(
      'removed_verifikat_ids', to_jsonb(v_originals),
      'removed_storno_ids', to_jsonb(v_stornos),
      'account_balances', v_balance_before),
    v_receipt,
    left(format(
      'Support removed the undone SIE import %s from the ledger: %s imported verifikat and %s stornos deleted (support_remove_undone_sie_import). Reason: %s',
      coalesce(v_import.filename, p_import_id::text), cardinality(v_originals), cardinality(v_stornos), v_reason), 2000),
    'system',
    v_actor_label
  );

  PERFORM set_config('gnubok.actor_type', '', true);
  PERFORM set_config('gnubok.actor_label', '', true);

  RETURN v_receipt;
END;
$$;

COMMENT ON FUNCTION public.support_remove_undone_sie_import(uuid, uuid, text, text, boolean) IS
  'Service role only, dry run by default (crm#1954). Deletes an undone SIE import''s reversed verifikat and their stornos when nothing else points at them and the year is not closed or filed, then renumbers the replacement import''s verifikat in the same series to their old-system numbers (or explains the freed numbers as a gap). A narrow, logged exception to Hard Rules 1 and 4: see migration 20261120140000. Returns a receipt; any precondition miss raises SIE_REMOVAL_*.';

REVOKE ALL ON FUNCTION public.support_remove_undone_sie_import(uuid, uuid, text, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.support_remove_undone_sie_import(uuid, uuid, text, text, boolean)
  TO service_role;

NOTIFY pgrst, 'reload schema';
