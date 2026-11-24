-- Inline rättelse refuses a verifikat that a posted storno already reverses.
--
-- A verifikat in a locked or closed year is corrected with a storno and a
-- corrected verifikat dated in the first open period, and the original stays
-- 'posted' in its own year (lib/core/bookkeeping/storno-target.ts). Once that
-- year is unlocked or reopened, correct_entry_metadata and
-- correct_entry_lines_inline checked the status only, so a write member
-- calling either RPC directly could change the text, date or lines of an
-- original under the storno that already reverses it. The application
-- refuses the same (stornoedRefusal in
-- lib/core/bookkeeping/journal-entry-corrections.ts); now the database does
-- too, with the same Swedish sentence, so every door answers
-- JOURNAL_RATTELSE_REFUSED.
--
-- The refusal: a posted journal entry of the company whose reverses_id is
-- the verifikat (standingStornoOf in storno-target.ts reads the same). It
-- runs right after the status check, before the period and lock checks, as
-- the application orders them.
--
-- Each function is the newest definition copied byte for byte (both from
-- 20261016005000_inline_rattelse_actor) with only that refusal added; the
-- copied text keeps its original punctuation verbatim. The signatures do not
-- change, so CREATE OR REPLACE keeps the one candidate PostgREST resolves;
-- SECURITY DEFINER, search_path and the grants are restated exactly as they
-- were (authenticated, service_role; not PUBLIC or anon).
--
-- pg-test: tests/pg/inline-rattelse-stornoed-original.pg.test.ts

CREATE OR REPLACE FUNCTION public.correct_entry_metadata(
  p_company_id  uuid,
  p_entry_id    uuid,
  p_description text DEFAULT NULL,
  p_entry_date  date DEFAULT NULL,
  p_user_id     uuid DEFAULT NULL,
  p_actor_type  text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
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

  -- A storno moved out of a locked year leaves its original 'posted': its
  -- text and date stay as the storno reverses them, also once that year is
  -- unlocked or reopened. The application refuses the same
  -- (journal-entry-corrections.ts, stornoedRefusal).
  IF EXISTS (
    SELECT 1 FROM public.journal_entries s
     WHERE s.company_id = p_company_id
       AND s.reverses_id = p_entry_id
       AND s.status = 'posted'
  ) THEN
    RAISE EXCEPTION 'Verifikationen är redan rättad med storno i en senare period. Rätta det rättade verifikatet i stället.';
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

  -- WHO beside the uuid: the credential that relayed this rättelse (the user,
  -- API key, OAuth client, cron job or assistant), as commit_journal_entry
  -- records it for a commit. The transaction-local GUCs hand the same actor
  -- to write_audit_log for the rows this rättelse writes. Left as they are
  -- when no actor is passed.
  IF p_actor_type IS NOT NULL THEN
    PERFORM set_config('gnubok.actor_type', p_actor_type, true);
    PERFORM set_config('gnubok.actor_label', coalesce(p_actor_label, ''), true);
  END IF;

  -- Immutable who/when log FIRST — the carve-out is only ever exercised in a
  -- transaction that has already recorded the rättelse (BFL 5 kap 9 §).
  INSERT INTO public.journal_entry_rattelse_log
    (company_id, journal_entry_id, rattelse_type,
     old_description, new_description, old_entry_date, new_entry_date, actor,
     actor_type, actor_label)
  VALUES
    (p_company_id, p_entry_id, 'metadata',
     v_entry.description, v_new_desc, v_entry.entry_date, v_new_date, v_actor,
     p_actor_type, p_actor_label)
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

REVOKE ALL ON FUNCTION public.correct_entry_metadata(uuid, uuid, text, date, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_entry_metadata(uuid, uuid, text, date, uuid, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.correct_entry_lines_inline(p_company_id uuid, p_entry_id uuid, p_strike_line_ids uuid[], p_new_lines jsonb DEFAULT '[]'::jsonb, p_user_id uuid DEFAULT NULL::uuid, p_actor_type text DEFAULT NULL::text, p_actor_label text DEFAULT NULL::text)
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
  v_bank_origin_unlinked boolean;
  v_invoice_linked  boolean;
  v_supplier_linked boolean;
  v_delta        numeric;
  v_anchor       numeric;
  v_post_net     numeric;
  v_is_ob        boolean := false;
  v_linked_ob    uuid;
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

  PERFORM public.lock_cash_account_company(p_company_id);

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

  -- A storno moved out of a locked year leaves its original 'posted': its
  -- lines stay as the storno reverses them, also once that year is unlocked
  -- or reopened. The application refuses the same
  -- (journal-entry-corrections.ts, stornoedRefusal).
  IF EXISTS (
    SELECT 1 FROM public.journal_entries s
     WHERE s.company_id = p_company_id
       AND s.reverses_id = p_entry_id
       AND s.status = 'posted'
  ) THEN
    RAISE EXCEPTION 'Verifikationen är redan rättad med storno i en senare period. Rätta det rättade verifikatet i stället.';
  END IF;

  -- Structural entry types keep their dedicated flows: a storno mirrors its
  -- original, year-end vouchers feed dispositions/idempotency checks. An IB
  -- (source_type 'opening_balance') IS allowed since 20260831150000: the
  -- entry id (and thus fiscal_periods.opening_balance_entry_id) never
  -- changes, and the IB-specific guards below apply.
  IF v_entry.source_type IN ('storno', 'year_end', 'vat_settlement') THEN
    RAISE EXCEPTION 'Den här verifikationstypen kan inte rättas radvis: använd dess egen rättelsefunktion.';
  END IF;

  v_is_ob := v_entry.source_type = 'opening_balance';

  SELECT fp.is_closed, fp.locked_at, fp.opening_balance_entry_id
    INTO v_is_closed, v_locked_at, v_linked_ob
    FROM public.fiscal_periods fp
   WHERE fp.id = v_entry.fiscal_period_id;

  IF v_is_closed OR v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Perioden är stängd eller låst: använd rättelseverifikat (storno).';
  END IF;

  SELECT cs.bookkeeping_locked_through INTO v_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF v_lock_date IS NOT NULL AND v_entry.entry_date <= v_lock_date THEN
    RAISE EXCEPTION 'Bokföringen är låst t.o.m. %: använd rättelseverifikat (storno).', v_lock_date;
  END IF;

  IF v_is_ob THEN
    -- Guard 1: only the period's CURRENT linked IB is a rättelse target.
    IF v_linked_ob IS DISTINCT FROM p_entry_id THEN
      RAISE EXCEPTION 'Verifikationen är inte periodens aktuella ingående balans.';
    END IF;

    -- Guard 2: a posted bokslut on the period must be unwound first, same
    -- rule as the storno-based IB correction flow.
    IF EXISTS (
      SELECT 1 FROM public.journal_entries je2
       WHERE je2.company_id = p_company_id
         AND je2.fiscal_period_id = v_entry.fiscal_period_id
         AND je2.source_type = 'year_end'
         AND je2.status = 'posted'
    ) THEN
      RAISE EXCEPTION 'Perioden har ett bokslut. Återför bokslutet innan ingående balanser kan rättas.';
    END IF;
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
    RAISE EXCEPTION 'Rader i utländsk valuta kan inte strykas: använd rättelseverifikat (storno).';
  END IF;

  -- A struck line with a line-level underlag link would sever the document
  -- coupling (document_attachments.journal_entry_line_id is ON DELETE
  -- RESTRICT, so the DELETE would fail anyway: this gives a clear message).
  IF EXISTS (
    SELECT 1 FROM public.document_attachments da
     WHERE da.journal_entry_line_id = ANY (v_strike_ids)
  ) THEN
    RAISE EXCEPTION 'En rad som ska strykas har ett kopplat underlag: använd rättelseverifikat (storno).';
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
    -- Guard 3 (IB only): opening balances hold balance-sheet accounts
    -- (class 1-2). P&L balances reset at year start (BFNAR 2013:2).
    IF v_is_ob AND left(v_acc, 1) NOT IN ('1', '2') THEN
      RAISE EXCEPTION 'Resultatkonton (klass 3-8) kan inte användas i ingående balanser (konto %).', v_acc;
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
  -- identical set is a no-op in disguise. The key includes dimensions (as
  -- canonical jsonb text) so a dimensions-only rättelse counts as a change
  -- (CodeRabbit finding on PR #2076; the 20260819 version omitted it).
  SELECT COALESCE(array_agg(k ORDER BY k), '{}'), COALESCE(jsonb_agg(to_jsonb(jel) ORDER BY jel.sort_order), '[]'::jsonb)
    INTO v_struck_keys, v_struck_json
    FROM public.journal_entry_lines jel,
         LATERAL (SELECT jel.account_number || '|' || round(jel.debit_amount, 2)::text || '|'
                         || round(jel.credit_amount, 2)::text || '|' || COALESCE(jel.line_description, '') || '|'
                         || COALESCE(jel.dimensions, '{}'::jsonb)::text) AS key(k)
   WHERE jel.journal_entry_id = p_entry_id
     AND jel.id = ANY (v_strike_ids);

  SELECT COALESCE(array_agg(k ORDER BY k), '{}')
    INTO v_added_keys
    FROM (
      SELECT btrim(l ->> 'account_number') || '|'
             || round(COALESCE((l ->> 'debit_amount')::numeric, 0), 2)::text || '|'
             || round(COALESCE((l ->> 'credit_amount')::numeric, 0), 2)::text || '|'
             || COALESCE(NULLIF(btrim(COALESCE(l ->> 'line_description', '')), ''), '') || '|'
             || COALESCE(l -> 'dimensions', '{}'::jsonb)::text AS k
        FROM jsonb_array_elements(p_new_lines) AS l
    ) keys;

  IF v_struck_keys = v_added_keys THEN
    RAISE EXCEPTION 'Rättelsen ändrar ingenting.';
  END IF;

  -- Reconciliation guard: when the entry is anchored to external records
  -- (bank transactions, payment links), the anchored side must agree with
  -- the external amount. The bank feed / payment amount is immutable, so a
  -- strike that moves the 19xx/cash-account (or reskontra) net AWAY from it
  -- would create a permanent unexplained reconciliation difference.
  --
  -- On the bank side two shapes are allowed:
  --   1. net-preserving strikes (e.g. fixing a line description);
  --   2. strikes whose post-state net on the account EQUALS the linked bank
  --      amount. This is the "wrong contra line on the bank account itself"
  --      case (1930 D / 1930 K against a deposit): the entry never matched
  --      the feed, and the rättelse is exactly what makes it match again.
  -- Anything else still needs a rättelseverifikat (storno). Reskontra sides
  -- (15xx for customer payments, 24xx for supplier payments) stay strictly
  -- net-preserving: their anchor is the payment row, not a bank amount.

  -- Source context is immutable after posting and also covers invoice and
  -- supplier payment vouchers. Missing/partial links must not turn a bank
  -- origin into an unrestricted manual voucher during correction.
  v_bank_origin_unlinked := EXISTS (
    SELECT 1 FROM (
      SELECT j.source_id AS transaction_id FROM public.journal_entries j
        WHERE j.company_id = p_company_id AND j.id = p_entry_id AND j.source_type = 'bank_transaction'
      UNION
      SELECT (c->>'transaction_id')::uuid FROM public.journal_entries j,
        LATERAL jsonb_array_elements(j.bank_booking_context) c
        WHERE j.company_id = p_company_id AND j.id = p_entry_id
    ) origin WHERE NOT EXISTS (
      SELECT 1 FROM public.transactions t WHERE t.company_id = p_company_id AND t.id = origin.transaction_id
        AND (t.journal_entry_id = p_entry_id OR EXISTS (
          SELECT 1 FROM public.transaction_voucher_links l WHERE l.transaction_id = t.id
            AND l.journal_entry_id = p_entry_id AND l.role = 'bank_line'))
    )
  );
  v_bank_linked := v_bank_origin_unlinked
                OR EXISTS (SELECT 1 FROM public.transactions t WHERE t.journal_entry_id = p_entry_id)
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
      IF abs(v_delta) < 0.005 THEN
        CONTINUE;
      END IF;

      IF v_bank_linked AND (v_acc LIKE '19%' OR v_acc IN (
           SELECT ca.ledger_account FROM public.cash_accounts ca WHERE ca.company_id = p_company_id)) THEN
        IF v_bank_origin_unlinked THEN
          RAISE EXCEPTION 'Raden mot konto % kan inte ändras: verifikationen är kopplad till en banktransaktion eller betalning. Använd rättelseverifikat (storno).', v_acc;
        END IF;
        -- Signed bank amount anchored on this account across every linked
        -- transaction, counted once per transaction: a split link
        -- (transaction_voucher_links, bank_line role) carries the allocated
        -- slice, otherwise the transaction's own amount (the 1:1 path sets
        -- both the direct FK and a link row for the same transaction).
        -- Positive = deposit = debit on the bank account, so it compares to
        -- the post-state net debit - credit. A transaction without a
        -- cash_account_id resolves to the company's primary cash account,
        -- falling back to 1930 (the historical default ledger).
        SELECT sum(x.amount) INTO v_anchor
          FROM (
            SELECT COALESCE(
                     (SELECT sum(tvl.allocated_amount)
                        FROM public.transaction_voucher_links tvl
                       WHERE tvl.transaction_id = t.id
                         AND tvl.journal_entry_id = p_entry_id
                         AND tvl.role = 'bank_line'),
                     t.amount) AS amount
              FROM public.transactions t
             WHERE t.company_id = p_company_id
               AND (t.journal_entry_id = p_entry_id
                    OR EXISTS (SELECT 1 FROM public.transaction_voucher_links tvl
                                WHERE tvl.transaction_id = t.id
                                  AND tvl.journal_entry_id = p_entry_id
                                  AND tvl.role = 'bank_line'))
               AND COALESCE(
                     (SELECT ca.ledger_account FROM public.cash_accounts ca WHERE ca.id = t.cash_account_id),
                     (SELECT ca.ledger_account FROM public.cash_accounts ca
                       WHERE ca.company_id = p_company_id AND ca.is_primary
                       ORDER BY ca.created_at LIMIT 1),
                     '1930') = v_acc
          ) x;

        SELECT COALESCE(sum(jel.debit_amount - jel.credit_amount), 0) INTO v_post_net
          FROM public.journal_entry_lines jel
         WHERE jel.journal_entry_id = p_entry_id
           AND jel.account_number = v_acc
           AND NOT (jel.id = ANY (v_strike_ids));
        v_post_net := v_post_net + COALESCE((
          SELECT sum(round(COALESCE((l ->> 'debit_amount')::numeric, 0), 2)
                     - round(COALESCE((l ->> 'credit_amount')::numeric, 0), 2))
            FROM jsonb_array_elements(p_new_lines) AS l
           WHERE btrim(l ->> 'account_number') = v_acc), 0);

        IF v_anchor IS NULL THEN
          RAISE EXCEPTION 'Raden mot konto % kan inte ändras: verifikationen är kopplad till en banktransaktion eller betalning. Använd rättelseverifikat (storno).', v_acc;
        END IF;
        IF abs(v_post_net - v_anchor) >= 0.005 THEN
          RAISE EXCEPTION 'Raden mot konto % kan inte ändras så: verifikationen är kopplad till en banktransaktion på % kr, och kontots belopp efter rättelsen skulle bli % kr. Rättelsen måste få bankkontot att stämma med banken, annars: använd rättelseverifikat (storno).',
            v_acc, round(v_anchor, 2), round(v_post_net, 2);
        END IF;
      ELSIF (v_invoice_linked AND v_acc LIKE '15%')
         OR (v_supplier_linked AND v_acc LIKE '24%') THEN
        RAISE EXCEPTION 'Raden mot konto % kan inte ändras: verifikationen är kopplad till en banktransaktion eller betalning. Använd rättelseverifikat (storno).', v_acc;
      END IF;
    END LOOP;
  END IF;

  -- WHO beside the uuid: the credential that relayed this rättelse (the user,
  -- API key, OAuth client, cron job or assistant), as commit_journal_entry
  -- records it for a commit. The transaction-local GUCs hand the same actor
  -- to write_audit_log for the rows this rättelse writes. Left as they are
  -- when no actor is passed.
  IF p_actor_type IS NOT NULL THEN
    PERFORM set_config('gnubok.actor_type', p_actor_type, true);
    PERFORM set_config('gnubok.actor_label', coalesce(p_actor_label, ''), true);
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
    RAISE EXCEPTION 'Internt fel: verifikationen balanserar inte efter rättelsen: ändringen har återställts.';
  END IF;

  -- Close the check-then-write window on period locks: if a lock or close
  -- committed while this rättelse was running, abort and roll back rather
  -- than write into a period that is now locked.
  SELECT fp.is_closed, fp.locked_at INTO v_is_closed, v_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.id = v_entry.fiscal_period_id;
  IF v_is_closed OR v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Perioden är stängd eller låst: använd rättelseverifikat (storno).';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(jel) ORDER BY jel.sort_order), '[]'::jsonb)
    INTO v_added_json
    FROM public.journal_entry_lines jel
   WHERE jel.id = ANY (v_added_ids);

  INSERT INTO public.journal_entry_rattelse_log
    (company_id, journal_entry_id, rattelse_type, struck_lines, added_lines, actor,
     actor_type, actor_label)
  VALUES
    (p_company_id, p_entry_id, 'lines', v_struck_json, v_added_json, v_actor,
     p_actor_type, p_actor_label)
  RETURNING id INTO v_log_id;

  RETURN jsonb_build_object(
    'log_id', v_log_id,
    'struck_count', v_strike_count,
    'added_count', v_new_count,
    'total_debit', round(v_fin_debit, 2),
    'total_credit', round(v_fin_credit, 2)
  );
END;
$function$
;

REVOKE ALL ON FUNCTION public.correct_entry_lines_inline(uuid, uuid, uuid[], jsonb, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_entry_lines_inline(uuid, uuid, uuid[], jsonb, uuid, text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
