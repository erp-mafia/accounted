-- Records that still name a reversed verifikat: a second pass.
--
-- 20261127021500 moved the rows whose pointer names a reversed verifikat to
-- the verifikat that stands at the end of its correction chain. Each row was
-- written in its own block, and a row its own table refused stayed where it
-- was: the guard on a payment row with a bank row takes its locks without
-- waiting, so a row in a company that was being worked in at that moment was
-- refused. This migration runs the same selection and the same move once
-- more for what is still there.
--
-- The rule is unchanged, for the same seven pointers:
--   invoices.journal_entry_id
--   supplier_invoices.registration_journal_entry_id
--   supplier_invoices.payment_journal_entry_id
--   invoice_payments.journal_entry_id
--   supplier_invoice_payments.journal_entry_id
--   invoice_inbox_items.created_journal_entry_id
--   expense_claims.journal_entry_id
-- A row moves only when exactly one posted verifikat ends the chain, and an
-- invoice, a supplier invoice or a payment row is left when its reversed
-- verifikat posted to kundfordringar (151x) or leverantörsskulder (244x)
-- while the standing verifikat posts to neither. Rows of a company archived
-- by a migration reset are left (.claude/rules/database.md, rule 9). The
-- header of 20261127021500 lists the triggers that fire on these updates.
--
-- One addition: the NOTICE of a pointer with refused rows also says which
-- SQLSTATE refused how many of them. It names no row.
--
-- Idempotent: a row that already names the standing verifikat matches
-- nothing. No table, column, constraint, index, function or policy changes.

DO $$
DECLARE
  v_pointer record;
  v_row record;
  v_moved integer;
  v_skipped integer;
  v_states jsonb;
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
    v_states := '{}'::jsonb;

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
        -- it stays where it is and the rest go on. Only the SQLSTATE is kept,
        -- never the row.
        v_skipped := v_skipped + 1;
        v_states := jsonb_set(v_states, ARRAY[SQLSTATE], to_jsonb(coalesce((v_states ->> SQLSTATE)::integer, 0) + 1), true);
      END;
    END LOOP;

    RAISE NOTICE 'repair %.%: moved %, skipped % %', v_pointer.tbl, v_pointer.col, v_moved, v_skipped,
      CASE WHEN v_skipped > 0 THEN '(sqlstates ' || v_states::text || ')' ELSE '' END;
  END LOOP;
END;
$$;
