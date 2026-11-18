-- One answer to "does a live verifikat book this bank row?", one opening
-- balance floor, one window, and a booking that leaves no reconciliation method.
--
-- 1. bank_row_anchors: the rule, once. A bank row is anchored by its pointer, a
--    bank_line link or a payment row at a live verifikat. Every list, count,
--    proposal and guard asked this with its own copy: any pointer of any status
--    (is_transaction_booked), the pointer alone (the MCP tools, the receipt hunt,
--    the ledger change preview), posted pointers and links but no payments (the
--    gate). So a pointer at a reversed verifikat read booked in the lists and
--    bookable at the gate, and a row booked through a link read open in the MCP
--    tools.
--
--    A verifikat is live while it is posted, and after that while a posted
--    correction of it books on a bank account (standing_correction). correctEntry
--    moves the row's anchors along, but it logs a failed move and carries on, and
--    before 3c7800fc2 a correction could take the bank leg to another bank
--    account, where the binding guard refused the move: such rows exist, with
--    the amount booked once on the other 19xx. Reading them as open would
--    offer the money for a second verifikat, and the duplicate guard looks on the
--    row's own ledger only. They stay as they read today; the gate now refuses
--    them too. A correction with no bank line (a purchase rebooked as a supplier
--    invoice, crm#1433) took the money off the bank: nothing books the row, and
--    it is open work. Rows are not touched.
--
--    A supplementary link (role 'other', 'clearing') books no bank amount, so it
--    anchors nothing on its own: the gate always read it so. A payment row whose
--    verifikat was deleted names no verifikat at all, so it anchors nothing
--    either, and a row with nothing else on it is open work; the invoice's
--    fate stays the payment register's.
--
--    The shape is the planner's. The arms are four plain tables with no WHERE, so
--    Postgres flattens them and an anti join can probe each table's index with
--    the row's id; arms with a join or a WHERE stay opaque, and it builds every
--    anchor of the company per pass or per row. The rule sits on the one join to
--    journal_entries, which carries company_id so the hash plans stay inside the
--    company.
--
-- 2. unbooked_bank_rows: the complement, the rows no live verifikat books, read
--    from the side the indexes serve. Only two kinds of row can lack an anchor:
--    no pointer (idx_transactions_company_date holds exactly those), and a
--    pointer at a verifikat no longer posted (idx_journal_entries_company_not_posted,
--    new here). The rule itself stays in the NOT EXISTS, which on the first side
--    skips the pointer arm: there is no pointer to read. open_bank_rows adds the
--    triage, not ignored and not private. The bank status reads the complement
--    too, a company's unbooked rows being few, instead of reading every anchor.
--
--    is_booked keeps its own EXISTS instead of calling is_transaction_booked: a
--    nested SQL function is planned again for every row, which took a 50-row page
--    from 9 to 94 ms.
--
-- 3. account_ib_floor: the floor of every balance, the rule findOpeningBalanceFloor
--    held in TypeScript and 9c115bbc5c gave the derived IB. The bank status took
--    the latest verifikat labelled opening_balance on any date and did not skip
--    a date whose IB entries cancel. So labelled lines off a year start and
--    cancelling dates moved both sides of the status. The status and the
--    bank list now start at the same floor.
--
-- 4. A linked row's window: get_bank_reconciliation_items reads the anchor the
--    facts read (the latest of the pointer and every link), so the row is
--    listed in the one month the status counts it.
--
-- 5. transactions_own_booking_clears_method: a method says how a row was linked
--    to a verifikat that existed before it. categorize, the book route and the
--    Inkorg direct booking overwrite a stale pointer with the row's own
--    booking and did not clear it, so Koppla bort could detach the booking.
--    Trigger, not three more door edits: bankLinkMethod is the same rule. It
--    fires only on the row's own verifikat, so a correction or a relink that
--    moves a link keeps its method.
--
-- pg-test: tests/pg/bank-row-anchors.pg.test.ts,
--          tests/pg/bank-reconciliation-floor-and-window.pg.test.ts

CREATE OR REPLACE FUNCTION public.standing_correction(p_entry_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path TO ''
AS $function$
  WITH RECURSIVE chain AS (
    SELECT e.id, e.status, e.company_id
    FROM public.journal_entries e
    WHERE e.correction_of_id = p_entry_id
    UNION
    SELECT n.id, n.status, n.company_id
    FROM chain c
    JOIN public.journal_entries n ON n.correction_of_id = c.id
    WHERE c.status <> 'posted'
  )
  SELECT c.id
  FROM chain c
  WHERE c.status = 'posted'
    AND EXISTS (
      SELECT 1
      FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = c.id
        AND (
          l.account_number LIKE '19%'
          OR l.account_number IN (SELECT ca.ledger_account FROM public.cash_accounts ca WHERE ca.company_id = c.company_id)
        )
    )
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.standing_correction(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.standing_correction(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.standing_correction(uuid) IS
  'The posted verifikat at the end of a correction chain (correction_of_id) from this one that books on a bank account (a 19xx account or a cash account''s ledger, isBankLedgerAccount), NULL when none does: where the bank money of a verifikat no longer posted lives on.';

CREATE INDEX IF NOT EXISTS idx_journal_entries_company_not_posted
  ON public.journal_entries (company_id, id)
  WHERE status <> 'posted';

CREATE OR REPLACE VIEW public.bank_row_anchors WITH (security_invoker = true) AS
  SELECT
    a.company_id,
    a.transaction_id,
    CASE WHEN e.status = 'posted' THEN e.id ELSE public.standing_correction(e.id) END AS journal_entry_id,
    a.via
  FROM (
    SELECT t.company_id, t.id AS transaction_id, t.journal_entry_id, 'bank_line'::text AS role, 'pointer'::text AS via
    FROM public.transactions t
    UNION ALL
    SELECT l.company_id, l.transaction_id, l.journal_entry_id, l.role, 'link'::text
    FROM public.transaction_voucher_links l
    UNION ALL
    SELECT p.company_id, p.transaction_id, p.journal_entry_id, 'bank_line'::text, 'payment'::text
    FROM public.invoice_payments p
    UNION ALL
    SELECT p.company_id, p.transaction_id, p.journal_entry_id, 'bank_line'::text, 'payment'::text
    FROM public.supplier_invoice_payments p
  ) a
  JOIN public.journal_entries e ON e.id = a.journal_entry_id AND e.company_id = a.company_id
  WHERE a.role = 'bank_line'
    AND (e.status = 'posted' OR public.standing_correction(e.id) IS NOT NULL);

REVOKE ALL ON public.bank_row_anchors FROM PUBLIC, anon;
GRANT SELECT ON public.bank_row_anchors TO authenticated, service_role;

COMMENT ON VIEW public.bank_row_anchors IS
  'The live verifikat that book a bank row. Filter on company_id and transaction_id: the arms hold no WHERE, so the filter reaches each table''s index.';

CREATE OR REPLACE VIEW public.unbooked_bank_rows WITH (security_invoker = true) AS
  SELECT t.*
  FROM public.transactions t
  WHERE t.journal_entry_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.bank_row_anchors a
      WHERE a.company_id = t.company_id AND a.transaction_id = t.id AND a.via <> 'pointer'
    )
  UNION ALL
  SELECT t.*
  FROM public.journal_entries e
  JOIN public.transactions t ON t.journal_entry_id = e.id AND t.company_id = e.company_id
  WHERE e.status <> 'posted'
    AND NOT EXISTS (
      SELECT 1 FROM public.bank_row_anchors a
      WHERE a.company_id = t.company_id AND a.transaction_id = t.id
    );

REVOKE ALL ON public.unbooked_bank_rows FROM PUBLIC, anon;
GRANT SELECT ON public.unbooked_bank_rows TO authenticated, service_role;

-- SELECT t.* is expanded here: a new transactions column reaches these views by
-- a CREATE OR REPLACE at the end of its column list, and bank-row-anchors.pg
-- fails until it does.
CREATE OR REPLACE VIEW public.open_bank_rows WITH (security_invoker = true) AS
  SELECT u.*
  FROM public.unbooked_bank_rows u
  WHERE NOT u.is_ignored
    AND u.is_business IS NOT FALSE;

REVOKE ALL ON public.open_bank_rows FROM PUBLIC, anon;
GRANT SELECT ON public.open_bank_rows TO authenticated, service_role;

COMMENT ON VIEW public.open_bank_rows IS
  'Bank rows that are open work: unbooked_bank_rows that are neither ignored nor private. Every list of work to do reads this.';

COMMENT ON VIEW public.unbooked_bank_rows IS
  'Bank rows no live verifikat books: the complement of bank_row_anchors, read from the two sides the indexes serve. Ask with company_id.';

CREATE OR REPLACE FUNCTION public.is_booked(t public.transactions)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.bank_row_anchors a
    WHERE a.company_id = t.company_id
      AND a.transaction_id = t.id
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_transaction_booked(p_transaction_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.bank_row_anchors a WHERE a.transaction_id = p_transaction_id);
$function$;

-- Same answer as before for every row match_batch_allocate can lock, read from
-- the one definition. p_pointer stays in the signature: that function passes
-- it, and the view reads the same locked row.
CREATE OR REPLACE FUNCTION public.bank_row_posted_anchor(p_company_id uuid, p_transaction_id uuid, p_pointer uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $function$
  SELECT a.journal_entry_id
  FROM public.bank_row_anchors a
  WHERE a.company_id = p_company_id
    AND a.transaction_id = p_transaction_id
    AND a.via IN ('pointer', 'link')
  ORDER BY (a.via = 'link'), a.journal_entry_id
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.cash_account_booked_rows(p_company_id uuid, p_cash_account_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
  WITH anchored AS MATERIALIZED (
    SELECT a.transaction_id, a.journal_entry_id
    FROM public.bank_row_anchors a
    WHERE a.company_id = p_company_id
  )
  SELECT count(*)::integer
  FROM public.cash_accounts ca
  JOIN public.transactions t
    ON t.company_id = ca.company_id
   AND t.cash_account_id = ca.id
  WHERE ca.company_id = p_company_id
    AND ca.id = p_cash_account_id
    AND EXISTS (
      SELECT 1
      FROM anchored x
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = x.journal_entry_id
      WHERE x.transaction_id = t.id
        AND jel.account_number = ca.ledger_account
    );
$function$;

CREATE OR REPLACE FUNCTION public.account_ib_floor(p_company_id uuid, p_account_number text, p_through date DEFAULT NULL)
RETURNS TABLE (floor_date date, amount numeric, entry_ids uuid[])
LANGUAGE sql
STABLE
SET search_path TO ''
ROWS 1
AS $function$
  SELECT g.entry_date, g.amount, g.entry_ids
  FROM (
    SELECT e.entry_date,
           round(sum(coalesce(l.debit_amount, 0) - coalesce(l.credit_amount, 0)), 2) AS amount,
           array_agg(DISTINCT e.id) AS entry_ids
    FROM public.journal_entries e
    JOIN public.journal_entry_lines l
      ON l.journal_entry_id = e.id
     AND l.account_number = p_account_number
    WHERE e.company_id = p_company_id
      AND e.source_type = 'opening_balance'
      AND e.status = 'posted'
      AND (p_through IS NULL OR e.entry_date <= p_through)
      AND EXISTS (
        SELECT 1 FROM public.fiscal_periods fp
        WHERE fp.company_id = p_company_id
          AND fp.period_start = e.entry_date
      )
    GROUP BY e.entry_date
  ) g
  WHERE NOT (cardinality(g.entry_ids) >= 2 AND g.amount = 0)
  ORDER BY g.entry_date DESC
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.account_ib_floor(uuid, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_ib_floor(uuid, text, date) TO authenticated, service_role;

COMMENT ON FUNCTION public.account_ib_floor(uuid, text, date) IS
  'The latest ingående balans on an account through a date: posted, labelled opening_balance, on a fiscal year''s first day, skipping a date whose two or more IB verifikat cancel on the account. Everything before it is history the IB restates. No row: the balance runs over all history.';

CREATE OR REPLACE FUNCTION public.transactions_own_booking_clears_method()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.journal_entries je
    WHERE je.id = NEW.journal_entry_id
      AND je.source_type = 'bank_transaction'
      AND je.source_id = NEW.id
  ) THEN
    NEW.reconciliation_method := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER transactions_own_booking_clears_method
  BEFORE UPDATE OF journal_entry_id ON public.transactions
  FOR EACH ROW
  WHEN (
    NEW.journal_entry_id IS NOT NULL
    AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
    AND NEW.reconciliation_method IS NOT NULL
  )
  EXECUTE FUNCTION public.transactions_own_booking_clears_method();

CREATE OR REPLACE FUNCTION public.get_bank_reconciliation_facts(p_company_id uuid, p_account_number text, p_currency text, p_cash_account_id uuid, p_include_unassigned boolean, p_date_from date, p_date_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_hi date := coalesce(p_date_to, 'infinity'::date);
  v_read_lo date := coalesce(p_date_from, '-infinity'::date);
  v_sek boolean := p_currency = 'SEK';
  -- ledger_account_days sums the lines' kronor: a foreign account counts its
  -- lines in its own currency, which only the line level can answer.
  v_indexed boolean := v_sek AND public.ledger_account_days_ready(p_company_id);
  v_ib_floor date;
  v_from date;
  v_lo date;
  v_gl jsonb;
  v_bank jsonb;
  v_cash_accounts integer;
  v_candidates jsonb;
  v_candidate_entries uuid[];
  v_entry_amounts jsonb;
  v_saldo jsonb;
  v_balance numeric;
  v_balance_at timestamptz;
  v_balance_date date;
BEGIN
  -- The opening-balance floor (issue #751), when it lies inside the window.
  -- Both sides of the comparison start there: everything before it is history
  -- the IB restates.
  SELECT f.floor_date INTO v_ib_floor
  FROM public.account_ib_floor(p_company_id, p_account_number, p_date_to) f;
  IF v_ib_floor < v_read_lo THEN
    v_ib_floor := NULL;
  END IF;

  v_from := CASE
    WHEN p_date_from IS NOT NULL AND v_ib_floor IS NOT NULL THEN greatest(p_date_from, v_ib_floor)
    ELSE coalesce(p_date_from, v_ib_floor)
  END;
  v_lo := coalesce(v_from, '-infinity'::date);

  IF v_indexed THEN
    -- The account's verifikat in ledger_account_entries (posted and
    -- reversed, every date: a row's anchor can lie outside the window) and
    -- one pass over the company's bank rows answer the bank side and the
    -- verifikat that can be ledger-only (bank_account_candidate_entries'
    -- narrowing, on the rows already read); the day sums answer the ledger.
    WITH periods AS MATERIALIZED (
      SELECT fp.id FROM public.fiscal_periods fp WHERE fp.company_id = p_company_id
    ),
    entries AS MATERIALIZED (
      SELECT a.journal_entry_id AS id, a.entry_date
      FROM public.ledger_account_entries a
      WHERE a.company_id = p_company_id
        AND a.fiscal_period_id IN (SELECT p.id FROM periods p)
        AND a.account_number = p_account_number
    ),
    company_tx AS MATERIALIZED (
      SELECT t.id, t.date, t.amount, t.journal_entry_id, t.is_ignored, t.currency, t.cash_account_id,
             ca.ledger_account
      FROM public.transactions t
      LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
      WHERE t.company_id = p_company_id
    ),
    links AS MATERIALIZED (
      SELECT l.transaction_id, l.journal_entry_id
      FROM public.transaction_voucher_links l
      WHERE l.company_id = p_company_id
    ),
    unbooked AS MATERIALIZED (
      SELECT u.id
      FROM public.unbooked_bank_rows u
      WHERE u.company_id = p_company_id
    ),
    tx AS (
      SELECT t.*
      FROM company_tx t
      WHERE t.currency = p_currency
        AND (
          p_cash_account_id IS NULL
          OR t.cash_account_id = p_cash_account_id
          OR (p_include_unassigned AND t.cash_account_id IS NULL)
        )
    ),
    -- A linked row's anchor: the latest of the verifikat it is linked to and
    -- the one it points at, among those with a line on the account, for every
    -- row in one join.
    link_anchor AS (
      SELECT u.transaction_id, max(x.entry_date) AS entry_date
      FROM (
        SELECT k.transaction_id, k.journal_entry_id FROM links k
        UNION ALL
        SELECT t.id, t.journal_entry_id FROM tx t WHERE t.journal_entry_id IS NOT NULL
      ) u
      JOIN entries x ON x.id = u.journal_entry_id
      GROUP BY u.transaction_id
    ),
    counted AS (
      SELECT tx.date, tx.amount, tx.is_ignored,
             ub.id IS NULL AS linked,
             CASE WHEN ub.id IS NULL THEN coalesce(la.entry_date, tx.date) ELSE tx.date END AS anchor_date
      FROM tx
      LEFT JOIN unbooked ub ON ub.id = tx.id
      LEFT JOIN link_anchor la ON la.transaction_id = tx.id
    ),
    legacy AS MATERIALIZED (
      SELECT NOT EXISTS (
        SELECT 1
        FROM public.cash_accounts pca
        WHERE pca.company_id = p_company_id
          AND pca.is_primary
          AND pca.ledger_account <> p_account_number
      ) AS legacy_null_ok
    ),
    settled_here AS (
      SELECT t.journal_entry_id AS id
      FROM company_tx t
      WHERE t.journal_entry_id IS NOT NULL
        AND (
          t.ledger_account = p_account_number
          OR (t.ledger_account IS NULL AND (SELECT g.legacy_null_ok FROM legacy g))
        )
    )
    SELECT
      (
        -- The posted and reversed lines on the account, the set the
        -- balansräkning sums; the IB and the storno/rättelse verifikat among
        -- them (journal_entries_adjustment_idx) read line by line.
        SELECT jsonb_build_object(
          'balance', (
            SELECT coalesce(sum(d.debit - d.credit), 0)
            FROM public.ledger_account_days d
            WHERE d.company_id = p_company_id
              AND d.fiscal_period_id IN (SELECT p.id FROM periods p)
              AND d.account_number = p_account_number
              AND d.entry_date >= v_lo
              AND d.entry_date <= v_hi
          ),
          'opening_balance', coalesce(sum(x.amount)
            FILTER (WHERE x.source_type = 'opening_balance' AND x.status = 'posted' AND x.entry_date = v_ib_floor), 0),
          'correction_adjustment', coalesce(sum(x.amount)
            FILTER (WHERE x.source_type IN ('storno', 'correction')), 0),
          'unconvertible_line_count', 0
        )
        FROM (
          SELECT e.status, e.source_type, e.entry_date, coalesce(l.debit_amount, 0) - coalesce(l.credit_amount, 0) AS amount
          FROM public.journal_entries e
          JOIN public.journal_entry_lines l
            ON l.journal_entry_id = e.id AND l.account_number = p_account_number
          WHERE e.company_id = p_company_id
            AND e.source_type IN ('opening_balance', 'storno', 'correction')
            AND e.status IN ('posted', 'reversed')
            AND e.entry_date >= v_lo
            AND e.entry_date <= v_hi
        ) x
      ),
      (
        SELECT jsonb_build_object(
          'count', count(*) FILTER (WHERE NOT m.is_ignored),
          'total', coalesce(sum(m.amount) FILTER (WHERE NOT m.is_ignored), 0),
          'inflow', coalesce(sum(greatest(m.amount, 0)) FILTER (WHERE NOT m.is_ignored), 0),
          'outflow', coalesce(sum(least(m.amount, 0)) FILTER (WHERE NOT m.is_ignored), 0),
          'ignored_count', count(*) FILTER (WHERE m.is_ignored),
          'ignored_total', coalesce(sum(m.amount) FILTER (WHERE m.is_ignored), 0),
          'matched_count', count(*) FILTER (WHERE NOT m.is_ignored AND m.linked),
          'unmatched_count', count(*) FILTER (WHERE NOT m.is_ignored AND NOT m.linked),
          'unmatched_total', coalesce(sum(m.amount) FILTER (WHERE NOT m.is_ignored AND NOT m.linked), 0),
          'history_start', (SELECT min(tx.date) FROM tx)
        )
        FROM counted m
        WHERE m.anchor_date >= v_lo AND m.anchor_date <= v_hi
      ),
      (
        -- A superset, like the narrowing's: the lines function drops the
        -- reversed verifikat, the IB and the storno.
        SELECT array_agg(c.id ORDER BY c.id)
        FROM entries c
        WHERE c.entry_date >= v_lo
          AND c.entry_date <= v_hi
          -- A hashed lookup; settled_here holds no NULL, so NOT IN is NOT EXISTS.
          AND c.id NOT IN (SELECT s.id FROM settled_here s)
      )
    INTO v_gl, v_bank, v_candidate_entries;

    SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.entry_date, g.voucher_number, g.line_id), '[]'::jsonb)
      INTO v_candidates
    FROM public.bank_account_candidate_lines(
      p_company_id, p_account_number, v_from, p_date_to, false, coalesce(v_candidate_entries, '{}'::uuid[])
    ) g;
  ELSE
    -- Ledger side over [v_from, p_date_to]: posted and reversed lines on the
    -- account, the set the balansräkning sums, with the IB and the storno and
    -- rättelse activity split out. A foreign account counts its lines in its
    -- own currency (ledgerLineAmountIn in lib/bookkeeping/ledger-line-amount.ts,
    -- restated), so only the line level can answer it.
    SELECT jsonb_build_object(
      'balance', coalesce(sum(coalesce(x.amount, 0)), 0),
      'opening_balance', coalesce(sum(coalesce(x.amount, 0))
        FILTER (WHERE x.source_type = 'opening_balance' AND x.status = 'posted' AND x.entry_date = v_ib_floor), 0),
      'correction_adjustment', coalesce(sum(coalesce(x.amount, 0))
        FILTER (WHERE x.source_type IN ('storno', 'correction')), 0),
      'unconvertible_line_count', count(*) FILTER (WHERE x.amount IS NULL)
    ) INTO v_gl
    FROM (
      SELECT e.status, e.source_type, e.entry_date,
             CASE
               WHEN v_sek THEN coalesce(l.debit_amount, 0) - coalesce(l.credit_amount, 0)
               WHEN l.currency IS DISTINCT FROM p_currency
                    OR l.amount_in_currency IS NULL
                    OR l.amount_in_currency = 'NaN'::numeric THEN NULL
               WHEN coalesce(l.debit_amount, 0) > 0 THEN abs(l.amount_in_currency)
               WHEN coalesce(l.credit_amount, 0) > 0 THEN -abs(l.amount_in_currency)
               ELSE 0
             END AS amount
      FROM public.journal_entries e
      JOIN public.journal_entry_lines l
        ON l.journal_entry_id = e.id AND l.account_number = p_account_number
      WHERE e.company_id = p_company_id
        AND e.status IN ('posted', 'reversed')
        AND e.entry_date >= v_lo
        AND e.entry_date <= v_hi
    ) x;

    -- Bank side, the same rule, with the verifikat a row is linked to probed
    -- for a line on the account.
    WITH links AS MATERIALIZED (
      SELECT l.transaction_id, l.journal_entry_id
      FROM public.transaction_voucher_links l
      WHERE l.company_id = p_company_id
    ),
    unbooked AS MATERIALIZED (
      SELECT u.id
      FROM public.unbooked_bank_rows u
      WHERE u.company_id = p_company_id
    ),
    tx AS MATERIALIZED (
      SELECT t.id, t.date, t.amount, t.journal_entry_id, t.is_ignored
      FROM public.transactions t
      WHERE t.company_id = p_company_id
        AND t.currency = p_currency
        AND (
          p_cash_account_id IS NULL
          OR t.cash_account_id = p_cash_account_id
          OR (p_include_unassigned AND t.cash_account_id IS NULL)
        )
    ),
    entries AS MATERIALIZED (
      SELECT e.id, e.entry_date
      FROM public.journal_entries e
      WHERE e.id IN (
          SELECT tx.journal_entry_id FROM tx WHERE tx.journal_entry_id IS NOT NULL
          UNION
          SELECT k.journal_entry_id FROM links k
        )
        AND e.company_id = p_company_id
        AND e.status IN ('posted', 'reversed')
        AND EXISTS (
          SELECT 1 FROM public.journal_entry_lines l
          WHERE l.journal_entry_id = e.id AND l.account_number = p_account_number
        )
    ),
    -- A linked row's anchor: the latest of the verifikat it is linked to and
    -- the one it points at, among those with a line on the account, for every
    -- row in one join.
    link_anchor AS (
      SELECT u.transaction_id, max(x.entry_date) AS entry_date
      FROM (
        SELECT k.transaction_id, k.journal_entry_id FROM links k
        UNION ALL
        SELECT t.id, t.journal_entry_id FROM tx t WHERE t.journal_entry_id IS NOT NULL
      ) u
      JOIN entries x ON x.id = u.journal_entry_id
      GROUP BY u.transaction_id
    ),
    counted AS (
      SELECT tx.date, tx.amount, tx.is_ignored,
             ub.id IS NULL AS linked,
             CASE WHEN ub.id IS NULL THEN coalesce(la.entry_date, tx.date) ELSE tx.date END AS anchor_date
      FROM tx
      LEFT JOIN unbooked ub ON ub.id = tx.id
      LEFT JOIN link_anchor la ON la.transaction_id = tx.id
    )
    SELECT jsonb_build_object(
      'count', count(*) FILTER (WHERE NOT m.is_ignored),
      'total', coalesce(sum(m.amount) FILTER (WHERE NOT m.is_ignored), 0),
      'inflow', coalesce(sum(greatest(m.amount, 0)) FILTER (WHERE NOT m.is_ignored), 0),
      'outflow', coalesce(sum(least(m.amount, 0)) FILTER (WHERE NOT m.is_ignored), 0),
      'ignored_count', count(*) FILTER (WHERE m.is_ignored),
      'ignored_total', coalesce(sum(m.amount) FILTER (WHERE m.is_ignored), 0),
      'matched_count', count(*) FILTER (WHERE NOT m.is_ignored AND m.linked),
      'unmatched_count', count(*) FILTER (WHERE NOT m.is_ignored AND NOT m.linked),
      'unmatched_total', coalesce(sum(m.amount) FILTER (WHERE NOT m.is_ignored AND NOT m.linked), 0),
      'history_start', (SELECT min(tx.date) FROM tx)
    ) INTO v_bank
    FROM counted m
    WHERE m.anchor_date >= v_lo AND m.anchor_date <= v_hi;

    -- The ledger-only verifikat on the account over the floored window: the
    -- candidate RPC's own answer, so "unmatched" has one definition.
    SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.entry_date, g.voucher_number, g.line_id), '[]'::jsonb)
      INTO v_candidates
    FROM public.get_account_gl_lines_for_matching(
      p_company_id, p_account_number, v_from, p_date_to, false
    ) g;
  END IF;

  -- Rows read on their own date across several cash accounts: only an
  -- unscoped call can pool them (#1290); the caller logs it.
  IF p_cash_account_id IS NULL THEN
    SELECT count(DISTINCT t.cash_account_id) INTO v_cash_accounts
    FROM public.transactions t
    WHERE t.company_id = p_company_id
      AND t.currency = p_currency
      AND t.date >= v_read_lo
      AND t.date <= v_hi;
  END IF;

  -- The bank's own saldo ahead of its first row (crm#1221): the balance it
  -- last reported less every non-ignored row from the window's start through
  -- that day. The caller uses it only when the bank's history starts inside
  -- the window.
  IF p_cash_account_id IS NOT NULL THEN
    SELECT ca.balance, ca.balance_updated_at INTO v_balance, v_balance_at
    FROM public.cash_accounts ca
    WHERE ca.company_id = p_company_id AND ca.id = p_cash_account_id;
    IF FOUND THEN
      v_balance_date := (v_balance_at AT TIME ZONE 'Europe/Stockholm')::date;
      v_saldo := jsonb_build_object(
        'balance', v_balance,
        'balance_updated_at', v_balance_at,
        'balance_date', v_balance_date,
        'rows_total', CASE WHEN v_balance_date IS NULL THEN NULL ELSE (
          SELECT coalesce(sum(t.amount), 0)
          FROM public.transactions t
          WHERE t.company_id = p_company_id
            AND t.currency = p_currency
            AND (t.cash_account_id = p_cash_account_id
                 OR (p_include_unassigned AND t.cash_account_id IS NULL))
            AND NOT t.is_ignored
            AND t.date >= v_read_lo
            AND t.date <= v_balance_date
        ) END
      );
    END IF;
  END IF;

  -- A foreign account's candidate lines carry no amount in its currency: the
  -- caller needs each candidate verifikat's own amount from its lines.
  IF NOT v_sek AND jsonb_array_length(v_candidates) > 0 THEN
    SELECT jsonb_object_agg(x.journal_entry_id, x.amount) INTO v_entry_amounts
    FROM (
      SELECT l.journal_entry_id,
             CASE WHEN bool_or(a.amount IS NULL) THEN NULL ELSE sum(a.amount) END AS amount
      FROM public.journal_entry_lines l
      CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN l.currency IS DISTINCT FROM p_currency
                      OR l.amount_in_currency IS NULL
                      OR l.amount_in_currency = 'NaN'::numeric THEN NULL
                 WHEN coalesce(l.debit_amount, 0) > 0 THEN abs(l.amount_in_currency)
                 WHEN coalesce(l.credit_amount, 0) > 0 THEN -abs(l.amount_in_currency)
                 ELSE 0
               END AS amount
      ) a
      WHERE l.account_number = p_account_number
        AND l.journal_entry_id IN (
          SELECT DISTINCT (c ->> 'journal_entry_id')::uuid FROM jsonb_array_elements(v_candidates) c
        )
      GROUP BY l.journal_entry_id
    ) x;
  END IF;

  RETURN jsonb_build_object(
    'ib_floor', v_ib_floor,
    'effective_from', v_from,
    'gl', v_gl,
    'bank', v_bank,
    'read_window_cash_accounts', v_cash_accounts,
    'saldo', v_saldo,
    'candidates', v_candidates,
    'entry_amounts', v_entry_amounts
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_bank_reconciliation_items(p_company_id uuid, p_account_number text, p_currency text, p_cash_account_id uuid, p_include_unassigned boolean, p_date_from date, p_date_to date, p_with_rows boolean, p_with_ledger boolean, p_matched_offset integer, p_matched_limit integer, p_matched_after_open boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_from date := p_date_from;
  v_lo date := coalesce(p_date_from, '-infinity'::date);
  v_hi date := coalesce(p_date_to, 'infinity'::date);
  v_indexed boolean := public.ledger_account_days_ready(p_company_id);
  v_ib_floor date;
  v_rows jsonb;
  v_history_start date;
  v_unlinked uuid[];
  v_lines jsonb;
  v_year_starts jsonb;
BEGIN
  -- The window get_bank_reconciliation_facts counts: an opening balance inside
  -- it restates everything before it, on the bank side and the ledger side.
  SELECT f.floor_date INTO v_ib_floor
  FROM public.account_ib_floor(p_company_id, p_account_number, p_date_to) f;
  IF v_ib_floor >= v_lo THEN
    v_from := v_ib_floor;
    v_lo := v_ib_floor;
  END IF;

  IF p_with_rows OR p_with_ledger THEN
    WITH company_tx AS MATERIALIZED (
      SELECT t.id, t.date, t.amount, t.journal_entry_id, t.potential_journal_entry_id, t.is_ignored,
             t.currency, t.cash_account_id
      FROM public.transactions t
      WHERE t.company_id = p_company_id
    ),
    tx AS MATERIALIZED (
      SELECT t.id, t.date, t.journal_entry_id, t.is_ignored
      FROM company_tx t
      WHERE t.currency = p_currency
        AND (
          p_cash_account_id IS NULL
          OR t.cash_account_id = p_cash_account_id
          OR (p_include_unassigned AND t.cash_account_id IS NULL)
        )
    ),
    links AS MATERIALIZED (
      SELECT l.id, l.transaction_id, l.journal_entry_id, l.role, l.created_at
      FROM public.transaction_voucher_links l
      WHERE l.company_id = p_company_id
    ),
    -- Live (posted or reversed) verifikat with a line on the account, and
    -- their dates.
    bank_entries AS MATERIALIZED (
      SELECT a.journal_entry_id AS id, a.entry_date
      FROM public.ledger_account_entries a
      WHERE v_indexed
        AND a.company_id = p_company_id
        AND a.fiscal_period_id IN (SELECT fp.id FROM public.fiscal_periods fp WHERE fp.company_id = p_company_id)
        AND a.account_number = p_account_number
      UNION ALL
      SELECT e.id, e.entry_date
      FROM public.journal_entries e
      WHERE NOT v_indexed
        AND e.id IN (
          SELECT tx.journal_entry_id FROM tx WHERE tx.journal_entry_id IS NOT NULL
          UNION
          SELECT k.journal_entry_id FROM links k
        )
        AND e.company_id = p_company_id
        AND e.status IN ('posted', 'reversed')
        AND EXISTS (
          SELECT 1 FROM public.journal_entry_lines l
          WHERE l.journal_entry_id = e.id AND l.account_number = p_account_number
        )
    ),
    link_anchor AS (
      SELECT k.transaction_id, max(be.entry_date) AS entry_date
      FROM links k
      JOIN bank_entries be ON be.id = k.journal_entry_id
      GROUP BY k.transaction_id
    ),
    unbooked AS MATERIALIZED (
      SELECT u.id
      FROM public.unbooked_bank_rows u
      WHERE u.company_id = p_company_id
    ),
    -- A row's first link, bank_line anchors before supplementary ones.
    first_link AS (
      SELECT DISTINCT ON (k.transaction_id) k.transaction_id, k.journal_entry_id
      FROM links k
      ORDER BY k.transaction_id, (k.role <> 'bank_line'), k.created_at, k.id
    ),
    listed AS (
      SELECT tx.id, tx.date, tx.journal_entry_id, tx.is_ignored,
             ub.id IS NULL AS linked,
             fl.journal_entry_id AS first_link_id,
             -- The status's anchor: the later of the pointer's verifikat and
             -- the linked ones, among those with a line on the account.
             CASE WHEN ub.id IS NULL THEN coalesce(greatest(bp.entry_date, la.entry_date), tx.date) ELSE tx.date END AS anchor_date
      FROM tx
      LEFT JOIN unbooked ub ON ub.id = tx.id
      LEFT JOIN bank_entries bp ON bp.id = tx.journal_entry_id
      LEFT JOIN link_anchor la ON la.transaction_id = tx.id
      LEFT JOIN first_link fl ON fl.transaction_id = tx.id
    ),
    member AS MATERIALIZED (
      SELECT x.id, x.date, x.is_ignored, x.linked,
             CASE WHEN x.linked THEN coalesce(x.journal_entry_id, x.first_link_id) END AS linked_journal_entry_id
      FROM listed x
      WHERE p_with_rows
        AND x.anchor_date >= v_lo
        AND x.anchor_date <= v_hi
    ),
    picked AS (
      SELECT m.*, false AS matched_slice
      FROM member m
      WHERE m.is_ignored OR NOT m.linked
      UNION ALL
      SELECT s.*, true
      FROM (
        SELECT m.*
        FROM member m
        WHERE NOT m.is_ignored AND m.linked
        ORDER BY m.date DESC, m.id
        OFFSET greatest(p_matched_offset, 0)
        LIMIT greatest(
          p_matched_limit - CASE WHEN p_matched_after_open
            THEN (SELECT count(*) FROM member o WHERE o.is_ignored OR NOT o.linked) ELSE 0 END,
          0
        )
      ) s
    ),
    -- The listing's columns, read for the rows it returns only.
    shown AS (
      SELECT p.matched_slice,
             jsonb_build_object(
               'id', t.id, 'date', t.date, 'description', t.description, 'merchant_name', t.merchant_name,
               'amount', t.amount, 'currency', t.currency, 'journal_entry_id', t.journal_entry_id,
               'potential_journal_entry_id', t.potential_journal_entry_id,
               'potential_match_method', t.potential_match_method,
               'potential_match_confidence', t.potential_match_confidence,
               'is_ignored', t.is_ignored, 'reconciliation_method', t.reconciliation_method,
               'linked', p.linked, 'linked_journal_entry_id', p.linked_journal_entry_id) AS row,
             p.date, p.id
      FROM picked p
      JOIN public.transactions t ON t.id = p.id AND t.company_id = p_company_id
    )
    SELECT
      CASE WHEN p_with_rows THEN jsonb_build_object(
        'open_rows', coalesce((
          SELECT jsonb_agg(x.row ORDER BY x.date DESC, x.id) FROM shown x WHERE NOT x.matched_slice
        ), '[]'::jsonb),
        'matched_count', (SELECT count(*) FROM member m WHERE NOT m.is_ignored AND m.linked),
        'matched_rows', coalesce((
          SELECT jsonb_agg(x.row ORDER BY x.date DESC, x.id) FROM shown x WHERE x.matched_slice
        ), '[]'::jsonb)
      ) END,
      -- The first day the bank side covers on this account (crm#1221),
      -- ignored rows included, as fetchBankHistoryStart reads it.
      CASE WHEN p_with_ledger THEN (SELECT min(tx.date) FROM tx) END,
      -- get_unlinked_gl_lines' narrowing (bank_account_unlinked_entries) on
      -- the rows already read: the window's verifikat on the account that no
      -- bank row of the company points at (the lines function drops the
      -- reversed ones, the IB and the storno).
      CASE WHEN p_with_ledger AND v_indexed THEN (
        SELECT coalesce(array_agg(be.id ORDER BY be.id), '{}'::uuid[])
        FROM bank_entries be
        WHERE be.entry_date >= v_lo
          AND be.entry_date <= v_hi
          -- A hashed lookup; the subquery holds no NULL, so NOT IN is NOT EXISTS.
          AND be.id NOT IN (
            SELECT t.journal_entry_id FROM company_tx t WHERE t.journal_entry_id IS NOT NULL
          )
      ) END
    INTO v_rows, v_history_start, v_unlinked;
  END IF;

  IF p_with_ledger THEN
    IF v_unlinked IS NULL THEN
      v_unlinked := public.bank_account_unlinked_entries(p_company_id, p_account_number, v_from, p_date_to);
    END IF;
    SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.entry_date, g.voucher_number, g.line_id), '[]'::jsonb)
      INTO v_lines
    FROM public.bank_account_unlinked_lines(p_company_id, p_account_number, v_from, p_date_to, v_unlinked) g;

    IF jsonb_array_length(v_lines) > 0 THEN
      SELECT coalesce(jsonb_agg(fp.period_start), '[]'::jsonb) INTO v_year_starts
      FROM public.fiscal_periods fp
      WHERE fp.company_id = p_company_id;
    END IF;
  END IF;

  RETURN coalesce(v_rows, '{}'::jsonb) || jsonb_build_object(
    'history_start', v_history_start,
    'ledger_lines', coalesce(v_lines, '[]'::jsonb),
    'fiscal_year_starts', coalesce(v_year_starts, '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_bank_balance_facts(p_company_id uuid, p_cash_account_id uuid, p_include_unassigned boolean, p_currency text, p_through date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  WITH scoped AS (
    SELECT
      t.date,
      t.amount,
      t.is_ignored,
      (o.id IS NOT NULL) AS unbooked
    FROM public.transactions t
    LEFT JOIN public.open_bank_rows o ON o.id = t.id AND o.company_id = p_company_id
    WHERE t.company_id = p_company_id
      AND t.currency = p_currency
      AND (
        t.cash_account_id = p_cash_account_id
        OR (p_include_unassigned AND t.cash_account_id IS NULL)
      )
      AND t.date <= p_through
  )
  SELECT jsonb_build_object(
    'history_start', min(s.date) FILTER (WHERE NOT s.is_ignored),
    'rows_count', count(*) FILTER (WHERE NOT s.is_ignored),
    'rows_total', coalesce(sum(s.amount) FILTER (WHERE NOT s.is_ignored), 0),
    'unbooked_count', count(*) FILTER (WHERE s.unbooked),
    'unbooked_total', coalesce(sum(s.amount) FILTER (WHERE s.unbooked), 0),
    'ignored_count', count(*) FILTER (WHERE s.is_ignored),
    'ignored_total', coalesce(sum(s.amount) FILTER (WHERE s.is_ignored), 0)
  )
  FROM scoped s;
$function$;

NOTIFY pgrst, 'reload schema';
