-- Verifikat inline rättelse (founder-approved 2026-07-23, both cards):
--
--   Card 1: correct description/entry_date of a POSTED entry without a
--           rättelseverifikation (BFL 5 kap 9 §: a verifikation may be
--           corrected if who/when is recorded).
--   Card 2: strike lines inside a POSTED verifikat and add replacement
--           lines in the SAME verifikat (BFL 5 kap 5 §: a bokföringspost
--           may be corrected other than via a särskild rättelsepost, as
--           long as the original remains visible and who/when is recorded).
--
-- Legal position: Fortnox and Visma both offer exactly this inside the same
-- envelope. The envelope here is strictly bounded: posted entries only, open
-- periods only (not closed, not locked), company lock date honored, one
-- audited SECURITY DEFINER write path per operation, immutable before/after
-- log (journal_entry_rattelse_log), and the struck original preserved both in
-- the log (full row snapshots) and in audit_log (write_audit_log fires on all
-- line DML). Past a lock/close, the storno flow remains the only path.
--
-- Carve-out pattern follows the sanctioned precedents:
--   20260608120000 (notes-only entry update), 20260613120000 (source_type
--   retag GUC), 20260702170000 (dimension retag GUC + immutable log).
--
-- pg-test: tests/pg/inline-rattelse.pg.test.ts

-- =============================================================================
-- 1. journal_entry_rattelse_log — immutable rättelse audit trail
-- =============================================================================
-- Like dimension_retag_log: no FK to journal_entries so the log survives
-- hard-deletes (undo_sie_import); behandlingshistorik must not vanish with
-- its subject. Company FK keeps tenant lifecycle.

CREATE TABLE IF NOT EXISTS public.journal_entry_rattelse_log (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  journal_entry_id  uuid NOT NULL,
  rattelse_type     text NOT NULL CHECK (rattelse_type IN ('metadata', 'lines')),
  old_description   text,
  new_description   text,
  old_entry_date    date,
  new_entry_date    date,
  struck_lines      jsonb,
  added_lines       jsonb,
  actor             uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.journal_entry_rattelse_log ENABLE ROW LEVEL SECURITY;

-- Read-only for members; INSERT happens exclusively inside the SECURITY
-- DEFINER RPCs (no INSERT/UPDATE/DELETE policies on purpose).
DROP POLICY IF EXISTS "view own-company journal_entry_rattelse_log"
  ON public.journal_entry_rattelse_log;
CREATE POLICY "view own-company journal_entry_rattelse_log"
  ON public.journal_entry_rattelse_log FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));

CREATE INDEX IF NOT EXISTS idx_journal_entry_rattelse_log_entry
  ON public.journal_entry_rattelse_log (company_id, journal_entry_id);

CREATE OR REPLACE FUNCTION public.journal_entry_rattelse_log_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION 'journal_entry_rattelse_log är oföränderlig — rader kan inte ändras eller tas bort.';
END;
$$;

DROP TRIGGER IF EXISTS journal_entry_rattelse_log_immutable
  ON public.journal_entry_rattelse_log;
CREATE TRIGGER journal_entry_rattelse_log_immutable
  BEFORE UPDATE OR DELETE ON public.journal_entry_rattelse_log
  FOR EACH ROW EXECUTE FUNCTION public.journal_entry_rattelse_log_immutable();

-- =============================================================================
-- 2. Entry-immutability carve-out: metadata rättelse (append-only replacement)
-- =============================================================================
-- Adds ONE branch to the current function body (verbatim from staging/prod,
-- last replaced by 20260613120000): while the transaction-local GUC set by
-- correct_entry_metadata() is active, permit an UPDATE of a POSTED entry iff
-- ONLY description/entry_date change (whole-row to_jsonb diff; updated_at
-- exempt because journal_entries_updated_at bumps it). Voucher number, period,
-- amounts, linkage and every future column stay immutable by construction.

CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('gnubok.allow_delete', true) = 'true' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Cannot delete journal entries (id: %, status: %). Use cancelled status instead.',
      OLD.id, OLD.status;
  END IF;

  IF OLD.status = 'draft' AND NEW.status IN ('draft', 'posted', 'cancelled') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status IN ('reversed', 'cancelled') THEN
    IF NEW.status = 'reversed' THEN
      IF NEW.description != OLD.description OR NEW.entry_date != OLD.entry_date
         OR NEW.fiscal_period_id != OLD.fiscal_period_id
         OR NEW.voucher_number != OLD.voucher_number
         OR NEW.commit_method IS DISTINCT FROM OLD.commit_method
         OR NEW.rubric_version IS DISTINCT FROM OLD.rubric_version
         OR NEW.source_voucher_series IS DISTINCT FROM OLD.source_voucher_series
         OR NEW.source_voucher_number IS DISTINCT FROM OLD.source_voucher_number THEN
        RAISE EXCEPTION 'Cannot modify fields of a posted entry during reversal (id: %)', OLD.id;
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
  -- `notes` is internal metadata, not verifikation content, so editing it does
  -- not violate immutability. Allowed ONLY when the status is unchanged and the
  -- sole difference between OLD and NEW is `notes` (updated_at is exempt because
  -- the journal_entries_updated_at trigger bumps it). The to_jsonb() diff covers
  -- every other column automatically, so any real bookkeeping change still raises.
  IF OLD.status = NEW.status
     AND OLD.status IN ('posted', 'reversed', 'cancelled')
     AND (to_jsonb(NEW) - 'notes' - 'updated_at')
       = (to_jsonb(OLD) - 'notes' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  -- Source-type re-tag of a mis-typed opening balance. source_type is internal
  -- classification metadata, not verifikation content (see header), so moving a
  -- bank-account IB from manual/import to opening_balance does not alter the
  -- bokföringspost. Allowed ONLY when: the transaction-local bypass flag set by
  -- mark_entry_as_opening_balance() is present; status is unchanged 'posted'; the
  -- value moves manual/import -> opening_balance; and source_type is the SOLE
  -- changed column (whole-row to_jsonb diff, updated_at exempt as above). Any other
  -- field delta, status change, or missing flag still raises below.
  IF OLD.status = NEW.status
     AND OLD.status = 'posted'
     AND current_setting('gnubok.allow_source_type_retag', true) = 'true'
     AND OLD.source_type IN ('manual', 'import')
     AND NEW.source_type = 'opening_balance'
     AND (to_jsonb(NEW) - 'source_type' - 'updated_at')
       = (to_jsonb(OLD) - 'source_type' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  -- Metadata rättelse of a posted verifikation (BFL 5 kap 9 §): while the
  -- transaction-local GUC set by correct_entry_metadata() is active, permit an
  -- UPDATE iff ONLY description and/or entry_date change. The RPC has already
  -- recorded who/when in journal_entry_rattelse_log, verified the period is
  -- open/unlocked and (for date moves) that the new date stays inside the same
  -- fiscal period. Any other field delta still raises below.
  IF OLD.status = NEW.status
     AND OLD.status = 'posted'
     AND current_setting('gnubok.allow_metadata_rattelse', true) = 'true'
     AND (to_jsonb(NEW) - 'description' - 'entry_date' - 'updated_at')
       = (to_jsonb(OLD) - 'description' - 'entry_date' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Cannot modify a % journal entry (id: %). Committed entries are immutable per Bokforingslagen.',
    OLD.status, OLD.id;
END;
$function$;

ALTER FUNCTION public.enforce_journal_entry_immutability() SET search_path = public;

-- =============================================================================
-- 3. Line-immutability carve-out: inline line rättelse
-- =============================================================================
-- Current body verbatim (last replaced by 20260702170000) plus ONE branch:
-- while the transaction-local GUC set by correct_entry_lines_inline() is
-- active, permit DELETE of lines on a POSTED entry (the struck originals; the
-- RPC snapshots them to journal_entry_rattelse_log first and re-verifies the
-- entry balances afterwards). UPDATE of posted lines stays blocked: a strike
-- is remove-and-replace, never edit-in-place. (Line INSERT has no immutability
-- trigger; the balance invariant is enforced by the RPC.)

CREATE OR REPLACE FUNCTION public.enforce_journal_entry_line_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_status text;
BEGIN
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT status INTO v_status FROM public.journal_entries
  WHERE id = COALESCE(OLD.journal_entry_id, NEW.journal_entry_id);

  -- Dimension retag carve-out (dimensions plan PR6, founder-approved):
  -- while the transaction-local GUC set by retag_line_dimensions is active,
  -- permit UPDATE of a POSTED line iff ONLY the dimension columns change —
  -- dimensions (source of truth) and its derived mirrors cost_center/project.
  -- Account, amounts, description, currency fields, sort order and entry
  -- linkage remain absolutely immutable.
  IF TG_OP = 'UPDATE'
     AND v_status = 'posted'
     AND current_setting('gnubok.allow_dimension_retag', true) = 'true'
     AND (to_jsonb(NEW) - 'dimensions' - 'cost_center' - 'project')
       = (to_jsonb(OLD) - 'dimensions' - 'cost_center' - 'project') THEN
    RETURN NEW;
  END IF;

  -- Inline rättelse carve-out (BFL 5 kap 5 §, founder-approved 2026-07-23):
  -- while the transaction-local GUC set by correct_entry_lines_inline() is
  -- active, permit DELETE of a POSTED line (a struck line). The RPC has
  -- already snapshotted the row to journal_entry_rattelse_log and verifies
  -- post-state balance before committing.
  IF TG_OP = 'DELETE'
     AND v_status = 'posted'
     AND current_setting('gnubok.allow_line_rattelse', true) = 'true' THEN
    RETURN OLD;
  END IF;

  IF v_status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF v_status = 'cancelled' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Cannot % lines of a cancelled journal entry.', TG_OP;
  END IF;

  RAISE EXCEPTION 'Cannot % lines of a % journal entry.', TG_OP, v_status;
END; $function$;

ALTER FUNCTION public.enforce_journal_entry_line_immutability() SET search_path = public;

-- =============================================================================
-- 4. correct_entry_metadata — the ONE write path for Card 1
-- =============================================================================

CREATE OR REPLACE FUNCTION public.correct_entry_metadata(
  p_company_id  uuid,
  p_entry_id    uuid,
  p_description text DEFAULT NULL,
  p_entry_date  date DEFAULT NULL,
  p_user_id     uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role    text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_actor       uuid := COALESCE(p_user_id, auth.uid());
  v_caller_role text;
  v_entry       record;
  v_is_closed   boolean;
  v_locked_at   timestamptz;
  v_p_start     date;
  v_p_end       date;
  v_lock_date   date;
  v_new_desc    text;
  v_new_date    date;
  v_log_id      uuid;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF NOT public.caller_is_company_member(p_company_id) THEN
      RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
        USING ERRCODE = '42501';
    END IF;
    -- A JWT caller can never act as someone else: p_user_id is only for
    -- service-role paths, which authenticate the user application-side.
    v_actor := auth.uid();
  END IF;

  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id AND cm.user_id = v_actor;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'Endast användare med skrivbehörighet kan rätta verifikat.';
  END IF;

  SELECT je.id, je.status, je.description, je.entry_date, je.source_type,
         je.fiscal_period_id, je.company_id AS entry_company_id
    INTO v_entry
    FROM public.journal_entries je
   WHERE je.id = p_entry_id
     FOR UPDATE OF je;

  IF NOT FOUND OR v_entry.entry_company_id <> p_company_id THEN
    RAISE EXCEPTION 'Verifikationen hittades inte.';
  END IF;

  IF v_entry.status <> 'posted' THEN
    RAISE EXCEPTION 'Endast bokförda verifikat kan rättas (utkast redigeras direkt).';
  END IF;

  v_new_desc := COALESCE(NULLIF(btrim(p_description), ''), v_entry.description);
  v_new_date := COALESCE(p_entry_date, v_entry.entry_date);

  IF length(v_new_desc) > 500 THEN
    RAISE EXCEPTION 'Beskrivningen får vara högst 500 tecken.';
  END IF;

  -- A storno mirrors its original: its generated text and date are part of
  -- the correction chain and are never edited directly.
  IF v_entry.source_type = 'storno' THEN
    RAISE EXCEPTION 'Stornoverifikat kan inte rättas — rätta eller återför originalverifikatet i stället.';
  END IF;

  -- Date moves are forbidden for entry types whose date carries structural
  -- meaning (IB and year-end are period-bound; a vat_settlement is looked up
  -- by entry_date when the "already booked" gate runs, so moving it enables
  -- double-booking a settlement).
  IF v_new_date <> v_entry.entry_date
     AND v_entry.source_type IN ('opening_balance', 'year_end', 'vat_settlement') THEN
    RAISE EXCEPTION 'Datumet på den här verifikationstypen kan inte ändras.';
  END IF;

  SELECT fp.is_closed, fp.locked_at, fp.period_start, fp.period_end
    INTO v_is_closed, v_locked_at, v_p_start, v_p_end
    FROM public.fiscal_periods fp
   WHERE fp.id = v_entry.fiscal_period_id;

  IF v_is_closed OR v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Perioden är stängd eller låst — använd rättelseverifikat (storno).';
  END IF;

  -- The date may only move WITHIN the entry's fiscal period; cross-period
  -- moves change period sums and must go through the recordate (storno) flow.
  IF v_new_date <> v_entry.entry_date
     AND (v_new_date < v_p_start OR v_new_date > v_p_end) THEN
    RAISE EXCEPTION 'Nytt datum måste ligga inom samma bokföringsperiod (% – %). Använd "Flytta till annat datum" för att byta period.', v_p_start, v_p_end;
  END IF;

  SELECT cs.bookkeeping_locked_through INTO v_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF v_lock_date IS NOT NULL
     AND (v_entry.entry_date <= v_lock_date OR v_new_date <= v_lock_date) THEN
    RAISE EXCEPTION 'Bokföringen är låst t.o.m. % — använd rättelseverifikat (storno).', v_lock_date;
  END IF;

  IF v_new_desc = v_entry.description AND v_new_date = v_entry.entry_date THEN
    RETURN jsonb_build_object('changed', false, 'log_id', NULL);
  END IF;

  -- Immutable who/when log FIRST — the carve-out is only ever exercised in a
  -- transaction that has already recorded the rättelse (BFL 5 kap 9 §).
  INSERT INTO public.journal_entry_rattelse_log
    (company_id, journal_entry_id, rattelse_type,
     old_description, new_description, old_entry_date, new_entry_date, actor)
  VALUES
    (p_company_id, p_entry_id, 'metadata',
     v_entry.description, v_new_desc, v_entry.entry_date, v_new_date, v_actor)
  RETURNING id INTO v_log_id;

  PERFORM set_config('gnubok.allow_metadata_rattelse', 'true', true);

  UPDATE public.journal_entries
     SET description = v_new_desc,
         entry_date  = v_new_date
   WHERE id = p_entry_id;

  PERFORM set_config('gnubok.allow_metadata_rattelse', 'false', true);

  RETURN jsonb_build_object(
    'changed', true,
    'log_id', v_log_id,
    'old_description', v_entry.description,
    'new_description', v_new_desc,
    'old_entry_date', v_entry.entry_date,
    'new_entry_date', v_new_date
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.correct_entry_metadata(uuid, uuid, text, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_entry_metadata(uuid, uuid, text, date, uuid) TO authenticated, service_role;

-- =============================================================================
-- 5. correct_entry_lines_inline — the ONE write path for Card 2
-- =============================================================================
-- Strikes lines (delete + snapshot) and/or adds replacement lines inside the
-- same posted verifikat. The effective line set must balance to the öre and
-- stay non-empty; the original rows survive in the log and in audit_log.

CREATE OR REPLACE FUNCTION public.correct_entry_lines_inline(
  p_company_id      uuid,
  p_entry_id        uuid,
  p_strike_line_ids uuid[],
  p_new_lines       jsonb DEFAULT '[]'::jsonb,
  p_user_id         uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role     text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_actor        uuid := COALESCE(p_user_id, auth.uid());
  v_caller_role  text;
  v_entry        record;
  v_is_closed    boolean;
  v_locked_at    timestamptz;
  v_lock_date    date;
  v_strike_ids   uuid[] := ARRAY(SELECT DISTINCT unnest(COALESCE(p_strike_line_ids, '{}'::uuid[])));
  v_strike_count int := COALESCE(array_length(v_strike_ids, 1), 0);
  v_owned_count  int;
  v_line         jsonb;
  v_acc          text;
  v_debit        numeric;
  v_credit       numeric;
  v_new_count    int := 0;
  v_new_debit    numeric := 0;
  v_new_credit   numeric := 0;
  v_rem_debit    numeric;
  v_rem_credit   numeric;
  v_rem_count    int;
  v_struck_json  jsonb;
  v_struck_keys  text[];
  v_added_keys   text[];
  v_sort         int;
  v_added_ids    uuid[] := '{}';
  v_added_json   jsonb;
  v_new_id       uuid;
  v_log_id       uuid;
  v_fin_debit    numeric;
  v_fin_credit   numeric;
  v_fin_count    int;
  v_bank_linked     boolean;
  v_invoice_linked  boolean;
  v_supplier_linked boolean;
  v_delta        numeric;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF NOT public.caller_is_company_member(p_company_id) THEN
      RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
        USING ERRCODE = '42501';
    END IF;
    -- A JWT caller can never act as someone else: p_user_id is only for
    -- service-role paths, which authenticate the user application-side.
    v_actor := auth.uid();
  END IF;

  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id AND cm.user_id = v_actor;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'Endast användare med skrivbehörighet kan rätta verifikat.';
  END IF;

  IF p_new_lines IS NULL OR jsonb_typeof(p_new_lines) <> 'array' THEN
    RAISE EXCEPTION 'Nya rader måste vara en lista.';
  END IF;

  IF v_strike_count = 0 AND jsonb_array_length(p_new_lines) = 0 THEN
    RAISE EXCEPTION 'Rättelsen måste stryka eller lägga till minst en rad.';
  END IF;

  IF jsonb_array_length(p_new_lines) > 100 THEN
    RAISE EXCEPTION 'Högst 100 nya rader per rättelse.';
  END IF;

  SELECT je.id, je.status, je.entry_date, je.source_type,
         je.fiscal_period_id, je.company_id AS entry_company_id
    INTO v_entry
    FROM public.journal_entries je
   WHERE je.id = p_entry_id
     FOR UPDATE OF je;

  IF NOT FOUND OR v_entry.entry_company_id <> p_company_id THEN
    RAISE EXCEPTION 'Verifikationen hittades inte.';
  END IF;

  IF v_entry.status <> 'posted' THEN
    RAISE EXCEPTION 'Endast bokförda verifikat kan rättas (utkast redigeras direkt).';
  END IF;

  -- Structural entry types keep their dedicated flows: a storno mirrors its
  -- original, an IB feeds opening_balance_entry_id, year-end vouchers feed
  -- dispositions/idempotency checks.
  IF v_entry.source_type IN ('storno', 'opening_balance', 'year_end', 'vat_settlement') THEN
    RAISE EXCEPTION 'Den här verifikationstypen kan inte rättas radvis — använd dess egen rättelsefunktion.';
  END IF;

  SELECT fp.is_closed, fp.locked_at INTO v_is_closed, v_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.id = v_entry.fiscal_period_id;

  IF v_is_closed OR v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Perioden är stängd eller låst — använd rättelseverifikat (storno).';
  END IF;

  SELECT cs.bookkeeping_locked_through INTO v_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF v_lock_date IS NOT NULL AND v_entry.entry_date <= v_lock_date THEN
    RAISE EXCEPTION 'Bokföringen är låst t.o.m. % — använd rättelseverifikat (storno).', v_lock_date;
  END IF;

  -- Every struck id must be a line of THIS entry.
  SELECT count(*) INTO v_owned_count
    FROM public.journal_entry_lines jel
   WHERE jel.journal_entry_id = p_entry_id
     AND jel.id = ANY (v_strike_ids);

  IF v_owned_count <> v_strike_count THEN
    RAISE EXCEPTION 'En eller flera rader som ska strykas hör inte till verifikationen.';
  END IF;

  -- Foreign-currency lines carry conversion data (amount_in_currency /
  -- exchange_rate) that replacement lines cannot reproduce: those
  -- corrections stay on the storno flow.
  IF EXISTS (
    SELECT 1 FROM public.journal_entry_lines jel
     WHERE jel.journal_entry_id = p_entry_id
       AND jel.id = ANY (v_strike_ids)
       AND jel.currency IS NOT NULL AND jel.currency <> 'SEK'
  ) THEN
    RAISE EXCEPTION 'Rader i utländsk valuta kan inte strykas — använd rättelseverifikat (storno).';
  END IF;

  -- A struck line with a line-level underlag link would sever the document
  -- coupling (document_attachments.journal_entry_line_id is ON DELETE
  -- RESTRICT, so the DELETE would fail anyway — this gives a clear message).
  IF EXISTS (
    SELECT 1 FROM public.document_attachments da
     WHERE da.journal_entry_line_id = ANY (v_strike_ids)
  ) THEN
    RAISE EXCEPTION 'En rad som ska strykas har ett kopplat underlag — använd rättelseverifikat (storno).';
  END IF;

  -- Validate the replacement lines. SEK only: inline additions never carry
  -- foreign-currency conversion data (that correction stays on the storno flow).
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_new_lines)
  LOOP
    v_acc    := btrim(COALESCE(v_line ->> 'account_number', ''));
    v_debit  := round(COALESCE((v_line ->> 'debit_amount')::numeric, 0), 2);
    v_credit := round(COALESCE((v_line ->> 'credit_amount')::numeric, 0), 2);

    IF v_acc !~ '^[0-9]{4}$' THEN
      RAISE EXCEPTION 'Ogiltigt kontonummer: "%".', v_acc;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.chart_of_accounts coa
       WHERE coa.company_id = p_company_id AND coa.account_number = v_acc
    ) THEN
      RAISE EXCEPTION 'Kontot % finns inte i kontoplanen.', v_acc;
    END IF;
    IF v_debit < 0 OR v_credit < 0 THEN
      RAISE EXCEPTION 'Belopp kan inte vara negativa (konto %).', v_acc;
    END IF;
    IF v_debit > 0 AND v_credit > 0 THEN
      RAISE EXCEPTION 'En rad kan inte ha både debet och kredit (konto %).', v_acc;
    END IF;
    IF v_debit = 0 AND v_credit = 0 THEN
      RAISE EXCEPTION 'En rad måste ha ett belopp (konto %).', v_acc;
    END IF;

    v_new_count  := v_new_count + 1;
    v_new_debit  := v_new_debit + v_debit;
    v_new_credit := v_new_credit + v_credit;
  END LOOP;

  -- Effective post-state must balance and stay a real bokföringspost.
  SELECT COALESCE(sum(jel.debit_amount), 0), COALESCE(sum(jel.credit_amount), 0), count(*)
    INTO v_rem_debit, v_rem_credit, v_rem_count
    FROM public.journal_entry_lines jel
   WHERE jel.journal_entry_id = p_entry_id
     AND NOT (jel.id = ANY (v_strike_ids));

  IF (v_rem_count + v_new_count) < 2 THEN
    RAISE EXCEPTION 'Verifikationen måste ha minst två rader efter rättelsen. Använd "Återför (storno)" för att makulera hela verifikationen.';
  END IF;

  IF abs((v_rem_debit + v_new_debit) - (v_rem_credit + v_new_credit)) >= 0.005 THEN
    RAISE EXCEPTION 'Verifikationen balanserar inte efter rättelsen (debet %, kredit %).',
      round(v_rem_debit + v_new_debit, 2), round(v_rem_credit + v_new_credit, 2);
  END IF;

  IF (v_rem_debit + v_new_debit) < 0.005 THEN
    RAISE EXCEPTION 'Rättelsen skulle nollställa verifikationen. Använd "Återför (storno)" i stället.';
  END IF;

  -- A rättelse must change something: striking rows and re-adding an
  -- identical set is a no-op in disguise.
  SELECT COALESCE(array_agg(k ORDER BY k), '{}'), COALESCE(jsonb_agg(to_jsonb(jel) ORDER BY jel.sort_order), '[]'::jsonb)
    INTO v_struck_keys, v_struck_json
    FROM public.journal_entry_lines jel,
         LATERAL (SELECT jel.account_number || '|' || round(jel.debit_amount, 2)::text || '|'
                         || round(jel.credit_amount, 2)::text || '|' || COALESCE(jel.line_description, '')) AS key(k)
   WHERE jel.journal_entry_id = p_entry_id
     AND jel.id = ANY (v_strike_ids);

  SELECT COALESCE(array_agg(k ORDER BY k), '{}')
    INTO v_added_keys
    FROM (
      SELECT btrim(l ->> 'account_number') || '|'
             || round(COALESCE((l ->> 'debit_amount')::numeric, 0), 2)::text || '|'
             || round(COALESCE((l ->> 'credit_amount')::numeric, 0), 2)::text || '|'
             || COALESCE(NULLIF(btrim(COALESCE(l ->> 'line_description', '')), ''), '') AS k
        FROM jsonb_array_elements(p_new_lines) AS l
    ) keys;

  IF v_struck_keys = v_added_keys THEN
    RAISE EXCEPTION 'Rättelsen ändrar ingenting.';
  END IF;

  -- Reconciliation guard: when the entry is anchored to external records
  -- (bank transactions, payment links), the anchored side must keep its
  -- per-account net. The bank feed / payment amount is immutable, so letting
  -- a strike change the 19xx/cash-account (or reskontra) net would create a
  -- permanent unexplained reconciliation difference. Net-preserving strikes
  -- (e.g. fixing a line description) stay allowed.
  v_bank_linked := EXISTS (SELECT 1 FROM public.transactions t WHERE t.journal_entry_id = p_entry_id)
                OR EXISTS (SELECT 1 FROM public.transaction_voucher_links tvl WHERE tvl.journal_entry_id = p_entry_id);
  v_invoice_linked := EXISTS (SELECT 1 FROM public.invoice_payments ip WHERE ip.journal_entry_id = p_entry_id);
  v_supplier_linked := EXISTS (SELECT 1 FROM public.supplier_invoice_payments sp WHERE sp.journal_entry_id = p_entry_id);

  IF v_bank_linked OR v_invoice_linked OR v_supplier_linked THEN
    FOR v_acc, v_delta IN
      SELECT x.acc, sum(x.delta)
        FROM (
          SELECT jel.account_number AS acc,
                 -(jel.debit_amount - jel.credit_amount) AS delta
            FROM public.journal_entry_lines jel
           WHERE jel.journal_entry_id = p_entry_id
             AND jel.id = ANY (v_strike_ids)
          UNION ALL
          SELECT btrim(l ->> 'account_number'),
                 round(COALESCE((l ->> 'debit_amount')::numeric, 0), 2)
                 - round(COALESCE((l ->> 'credit_amount')::numeric, 0), 2)
            FROM jsonb_array_elements(p_new_lines) AS l
        ) x
       GROUP BY x.acc
    LOOP
      IF abs(v_delta) >= 0.005 AND (
           (v_bank_linked AND (v_acc LIKE '19%' OR v_acc IN (
              SELECT ca.ledger_account FROM public.cash_accounts ca WHERE ca.company_id = p_company_id)))
        OR (v_invoice_linked AND v_acc LIKE '15%')
        OR (v_supplier_linked AND v_acc LIKE '24%')
      ) THEN
        RAISE EXCEPTION 'Raden mot konto % kan inte ändras: verifikationen är kopplad till en banktransaktion eller betalning. Använd rättelseverifikat (storno).', v_acc;
      END IF;
    END LOOP;
  END IF;

  PERFORM set_config('gnubok.allow_line_rattelse', 'true', true);

  DELETE FROM public.journal_entry_lines
   WHERE journal_entry_id = p_entry_id
     AND id = ANY (v_strike_ids);

  SELECT COALESCE(max(jel.sort_order), 0) INTO v_sort
    FROM public.journal_entry_lines jel
   WHERE jel.journal_entry_id = p_entry_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_new_lines)
  LOOP
    v_sort := v_sort + 1;
    -- cost_center/project are GENERATED columns derived from dimensions:
    -- never inserted explicitly, they recompute from the bag.
    INSERT INTO public.journal_entry_lines
      (journal_entry_id, account_number, account_id, debit_amount, credit_amount,
       line_description, sort_order, dimensions, currency)
    VALUES
      (p_entry_id,
       btrim(v_line ->> 'account_number'),
       (SELECT coa.id FROM public.chart_of_accounts coa
         WHERE coa.company_id = p_company_id
           AND coa.account_number = btrim(v_line ->> 'account_number')
         ORDER BY (coa.is_active IS TRUE) DESC, coa.created_at
         LIMIT 1),
       round(COALESCE((v_line ->> 'debit_amount')::numeric, 0), 2),
       round(COALESCE((v_line ->> 'credit_amount')::numeric, 0), 2),
       NULLIF(btrim(COALESCE(v_line ->> 'line_description', '')), ''),
       v_sort,
       COALESCE(v_line -> 'dimensions', '{}'::jsonb),
       'SEK')
    RETURNING id INTO v_new_id;
    v_added_ids := v_added_ids || v_new_id;
  END LOOP;

  PERFORM set_config('gnubok.allow_line_rattelse', 'false', true);

  -- Authoritative post-state verification straight from the table: the entry
  -- must still balance to the öre and hold at least two lines, or everything
  -- rolls back.
  SELECT COALESCE(sum(jel.debit_amount), 0), COALESCE(sum(jel.credit_amount), 0), count(*)
    INTO v_fin_debit, v_fin_credit, v_fin_count
    FROM public.journal_entry_lines jel
   WHERE jel.journal_entry_id = p_entry_id;

  IF abs(v_fin_debit - v_fin_credit) >= 0.005 OR v_fin_count < 2 OR v_fin_debit < 0.005 THEN
    RAISE EXCEPTION 'Internt fel: verifikationen balanserar inte efter rättelsen — ändringen har återställts.';
  END IF;

  -- Close the check-then-write window on period locks: if a lock or close
  -- committed while this rättelse was running, abort and roll back rather
  -- than write into a period that is now locked.
  SELECT fp.is_closed, fp.locked_at INTO v_is_closed, v_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.id = v_entry.fiscal_period_id;
  IF v_is_closed OR v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Perioden är stängd eller låst — använd rättelseverifikat (storno).';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(jel) ORDER BY jel.sort_order), '[]'::jsonb)
    INTO v_added_json
    FROM public.journal_entry_lines jel
   WHERE jel.id = ANY (v_added_ids);

  INSERT INTO public.journal_entry_rattelse_log
    (company_id, journal_entry_id, rattelse_type, struck_lines, added_lines, actor)
  VALUES
    (p_company_id, p_entry_id, 'lines', v_struck_json, v_added_json, v_actor)
  RETURNING id INTO v_log_id;

  RETURN jsonb_build_object(
    'log_id', v_log_id,
    'struck_count', v_strike_count,
    'added_count', v_new_count,
    'total_debit', round(v_fin_debit, 2),
    'total_credit', round(v_fin_credit, 2)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.correct_entry_lines_inline(uuid, uuid, uuid[], jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_entry_lines_inline(uuid, uuid, uuid[], jsonb, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
