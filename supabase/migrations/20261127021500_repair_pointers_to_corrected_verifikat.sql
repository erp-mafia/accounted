-- Records that still name a reversed verifikat are moved to its rättelse.
--
-- A rättelse (correctEntry) reverses a verifikat and posts the corrected one
-- in its place (correction_of_id names the original). The records the
-- original booked are meant to follow: correctEntry moves them to the
-- corrected verifikat. Rows written before it moved a given kind of record
-- stayed on the reversed original. This migration moves those rows once.
--
-- The pointers it reads:
--   invoices.journal_entry_id
--   supplier_invoices.registration_journal_entry_id
--   supplier_invoices.payment_journal_entry_id
--   invoice_payments.journal_entry_id
--   supplier_invoice_payments.journal_entry_id
--   invoice_inbox_items.created_journal_entry_id
--   expense_claims.journal_entry_id
--
-- The rule, the same for each: a row whose pointer names a 'reversed'
-- verifikat of its own company is moved to the verifikat that stands at the
-- end of that verifikat's correction chain. The chain follows
-- correction_of_id from the reversed original to its rättelse, and on through
-- a rättelse that is itself reversed, at most 25 steps. The row moves only
-- when exactly one posted verifikat ends the chain.
--
-- Left as they are:
--   * a row whose verifikat was reversed by a plain storno (no rättelse):
--     nothing stands in its place;
--   * a row whose chain ends in more than one posted verifikat;
--   * an invoice, a supplier invoice or a payment row whose reversed
--     verifikat posted to kundfordringar (151x) or leverantörsskulder (244x)
--     while the standing verifikat posts to neither: the rättelse no longer
--     books the receivable or the payable the record stands for, so the
--     record is not moved to it. Inbox items and expense claims have no such
--     account and are not held to this;
--   * every row of a company archived by a migration reset
--     (.claude/rules/database.md, rule 9);
--   * a row whose own table refuses the move. Each row is written in its own
--     block, so a refusal (the cash anchor guard on a payment row whose
--     rättelse books no bank line, a lock that is not granted within the
--     timeout below) skips that row and the others still move.
--
-- Triggers that fire on these updates. The writer-role gate
-- (enforce_company_writer_role) passes a caller that is not an end user. The
-- audit triggers record the change. updated_at is stamped on the moved rows.
-- guard_kontantmetod_carry_link holds the pointer of a posted year-end carry;
-- a reversed verifikat is not one. guard_cash_transaction_anchor checks a
-- payment row that has a bank row against the verifikat it is moved to.
--
-- Idempotent: a row that already names the standing verifikat matches
-- nothing, so a second run moves nothing. No table, column, constraint,
-- index, function or policy changes. One NOTICE per pointer says how many
-- rows moved and how many were skipped.

DO $$
DECLARE
  v_pointer record;
  v_row record;
  v_moved integer;
  v_skipped integer;
BEGIN
  -- A row lock held by a running request is not waited for: the row is
  -- skipped by the handler below instead.
  PERFORM set_config('lock_timeout', '5s', true);

  FOR v_pointer IN
    -- family: the account group the record stands on (kundfordringar 151x,
    -- leverantörsskulder 244x), NULL where there is none.
    SELECT p.tbl, p.col, p.family
    FROM (VALUES
      ('invoices', 'journal_entry_id', '151'),
      ('supplier_invoices', 'registration_journal_entry_id', '244'),
      ('supplier_invoices', 'payment_journal_entry_id', '244'),
      ('invoice_payments', 'journal_entry_id', '151'),
      ('supplier_invoice_payments', 'journal_entry_id', '244'),
      ('invoice_inbox_items', 'created_journal_entry_id', NULL),
      ('expense_claims', 'journal_entry_id', NULL)
    ) AS p(tbl, col, family)
  LOOP
    v_moved := 0;
    v_skipped := 0;

    FOR v_row IN EXECUTE format($query$
      WITH RECURSIVE stale AS (
        -- Rows whose pointer names a reversed verifikat of their own company.
        SELECT t.id AS row_id, t.company_id, t.%1$I AS entry_id
        FROM public.%2$I t
        JOIN public.journal_entries o
          ON o.id = t.%1$I
         AND o.company_id = t.company_id
         AND o.status = 'reversed'
        WHERE NOT EXISTS (
          SELECT 1 FROM public.company_migration_resets m
          WHERE m.source_company_id = t.company_id
        )
      ),
      chain AS (
        -- The rättelse of each reversed original, then the rättelse of a
        -- rättelse that was itself reversed.
        SELECT s.entry_id AS root, s.company_id, c.id AS cur, c.status, 1 AS depth
        FROM (SELECT DISTINCT entry_id, company_id FROM stale) s
        JOIN public.journal_entries c
          ON c.correction_of_id = s.entry_id
         AND c.company_id = s.company_id
         AND c.status IN ('posted', 'reversed')
        UNION ALL
        SELECT ch.root, ch.company_id, c.id, c.status, ch.depth + 1
        FROM chain ch
        JOIN public.journal_entries c
          ON c.correction_of_id = ch.cur
         AND c.company_id = ch.company_id
         AND c.status IN ('posted', 'reversed')
        WHERE ch.status = 'reversed'
          AND ch.depth < 25
      ),
      standing AS (
        -- Exactly one posted verifikat ends the chain.
        SELECT ch.root, min(ch.cur::text)::uuid AS standing_id
        FROM chain ch
        WHERE ch.status = 'posted'
        GROUP BY ch.root
        HAVING count(*) = 1
      )
      SELECT s.row_id, st.standing_id
      FROM stale s
      JOIN standing st ON st.root = s.entry_id
      -- The standing verifikat still posts to the record's account group
      -- when the reversed one did.
      WHERE %3$L IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM public.journal_entry_lines l
           WHERE l.journal_entry_id = s.entry_id
             AND l.account_number LIKE %3$L || '%%'
         )
         OR EXISTS (
           SELECT 1 FROM public.journal_entry_lines l
           WHERE l.journal_entry_id = st.standing_id
             AND l.account_number LIKE %3$L || '%%'
         )
    $query$, v_pointer.col, v_pointer.tbl, v_pointer.family)
    LOOP
      BEGIN
        EXECUTE format(
          'UPDATE public.%1$I SET %2$I = $1 WHERE id = $2 AND %2$I IS DISTINCT FROM $1',
          v_pointer.tbl, v_pointer.col
        ) USING v_row.standing_id, v_row.row_id;
        v_moved := v_moved + 1;
      EXCEPTION WHEN OTHERS THEN
        -- The row's own table refused the move, or its lock was not granted:
        -- it stays where it is and the rest go on.
        v_skipped := v_skipped + 1;
      END;
    END LOOP;

    RAISE NOTICE 'repair %.%: moved %, skipped %', v_pointer.tbl, v_pointer.col, v_moved, v_skipped;
  END LOOP;
END;
$$;
