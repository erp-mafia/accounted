-- Upgrade-path assertions: run AFTER the pull request's migrations have been
-- applied on top of the seeded database.
--
-- Every check raises an exception on failure, so `psql -v ON_ERROR_STOP=1`
-- fails the job. Keep the assertions about invariants that must hold for ANY
-- migration, not about the specifics of one change.

DO $$
DECLARE
  v_entries       INT;
  v_lines         INT;
  v_debits        NUMERIC;
  v_credits       NUMERIC;
  v_ore           NUMERIC;
  v_company       INT;
  v_period        INT;
  v_max_voucher   INT;
BEGIN
  -- 1. The company, its membership and its fiscal period survived.
  SELECT count(*) INTO v_company
    FROM public.companies WHERE id = '22222222-2222-2222-2222-222222222222';
  IF v_company <> 1 THEN
    RAISE EXCEPTION 'upgrade: seeded company disappeared (found %)', v_company;
  END IF;

  SELECT count(*) INTO v_period
    FROM public.fiscal_periods WHERE id = '33333333-3333-3333-3333-333333333333';
  IF v_period <> 1 THEN
    RAISE EXCEPTION 'upgrade: seeded fiscal period disappeared (found %)', v_period;
  END IF;

  -- 2. All three posted verifikat survived, still posted. A migration must
  --    never silently drop or unpost a posted entry (BFL 5 kap).
  SELECT count(*) INTO v_entries
    FROM public.journal_entries
    WHERE company_id = '22222222-2222-2222-2222-222222222222'
      AND status = 'posted';
  IF v_entries <> 3 THEN
    RAISE EXCEPTION 'upgrade: expected 3 posted entries after migration, found %', v_entries;
  END IF;

  -- 3. Every line survived.
  SELECT count(*) INTO v_lines
    FROM public.journal_entry_lines l
    JOIN public.journal_entries e ON e.id = l.journal_entry_id
    WHERE e.company_id = '22222222-2222-2222-2222-222222222222';
  IF v_lines <> 7 THEN
    RAISE EXCEPTION 'upgrade: expected 7 journal entry lines after migration, found %', v_lines;
  END IF;

  -- 4. The ledger still balances. This is the assertion that catches a
  --    migration which retypes, rescales or rounds a money column.
  SELECT COALESCE(sum(l.debit_amount), 0), COALESCE(sum(l.credit_amount), 0)
    INTO v_debits, v_credits
    FROM public.journal_entry_lines l
    JOIN public.journal_entries e ON e.id = l.journal_entry_id
    WHERE e.company_id = '22222222-2222-2222-2222-222222222222';
  IF v_debits <> v_credits THEN
    RAISE EXCEPTION 'upgrade: ledger no longer balances after migration (debits %, credits %)',
      v_debits, v_credits;
  END IF;
  IF v_debits <> 20623.45 THEN
    RAISE EXCEPTION 'upgrade: total debits changed from 20623.45 to %', v_debits;
  END IF;

  -- 5. The öre survived exactly. Money is NUMERIC and must not drift.
  SELECT l.debit_amount INTO v_ore
    FROM public.journal_entry_lines l
    WHERE l.journal_entry_id = '44444444-4444-4444-4444-444444444403'
      AND l.account_number = '6570';
  IF v_ore IS DISTINCT FROM 123.45 THEN
    RAISE EXCEPTION 'upgrade: öre-level amount drifted from 123.45 to %', v_ore;
  END IF;

  -- 6. Voucher numbers are intact and still sequential from 1.
  SELECT max(voucher_number) INTO v_max_voucher
    FROM public.journal_entries
    WHERE company_id = '22222222-2222-2222-2222-222222222222';
  IF v_max_voucher <> 3 THEN
    RAISE EXCEPTION 'upgrade: highest voucher number changed to %, expected 3', v_max_voucher;
  END IF;

  RAISE NOTICE 'upgrade-path assertions passed: % entries, % lines, balanced at %',
    v_entries, v_lines, v_debits;
END $$;

-- Agent proposals (pending_operations), seeded two decided and three
-- waiting. What any migration keeps:
--   * every seeded proposal is still there, and a decided one exactly as the
--     decision left it (status, resolved_at, updated_at): pending_operations_
--     immutability refuses every change, and a migration must not go around it;
--   * a waiting one whose status a migration did not change keeps its
--     updated_at (the stuck-approval sweep reads it): a backfill switches
--     pending_operations_updated_at off around its UPDATE, as 20261117192101 does;
--   * a proposal's number, once it has one, is its place among its company's
--     proposals in creation order (ties by id), fixed here as seeded: 1 to 5.
--     A waiting one has its number; a decided one may have none (proposals
--     decided before 20261117192101 were left as they were);
--   * the next proposal staged comes after all five.
DO $$
DECLARE
  v_row     record;
  v_next    INT;
  v_counted INT;
BEGIN
  FOR v_row IN
    SELECT seeded.*, p.id AS found_id, p.status AS now_status, p.resolved_at AS now_resolved_at,
           p.updated_at AS now_updated_at, p.operation_number
      FROM (VALUES
        ('55555555-5555-5555-5555-555555555501'::uuid, 1, 'committed', '2026-05-04 09:00:00+00'::timestamptz, '2026-05-04 09:00:00+00'::timestamptz),
        ('55555555-5555-5555-5555-555555555502'::uuid, 2, 'pending',   NULL::timestamptz,                     '2026-05-05 08:00:00+00'::timestamptz),
        ('55555555-5555-5555-5555-555555555503'::uuid, 3, 'rejected',  '2026-05-06 10:00:00+00'::timestamptz, '2026-05-06 10:00:00+00'::timestamptz),
        ('55555555-5555-5555-5555-555555555504'::uuid, 4, 'pending',   NULL::timestamptz,                     '2026-05-07 08:00:00+00'::timestamptz),
        ('55555555-5555-5555-5555-555555555505'::uuid, 5, 'pending',   NULL::timestamptz,                     '2026-05-07 08:00:00+00'::timestamptz)
      ) AS seeded(id, place, status, resolved_at, updated_at)
      LEFT JOIN public.pending_operations p ON p.id = seeded.id
  LOOP
    IF v_row.found_id IS NULL THEN
      RAISE EXCEPTION 'upgrade: seeded proposal % disappeared in a migration', v_row.id;
    END IF;

    IF v_row.status IN ('committed', 'rejected')
       AND (v_row.now_status IS DISTINCT FROM v_row.status
            OR v_row.now_resolved_at IS DISTINCT FROM v_row.resolved_at
            OR v_row.now_updated_at IS DISTINCT FROM v_row.updated_at) THEN
      RAISE EXCEPTION 'upgrade: decided proposal % changed in a migration (status %, resolved_at %, updated_at %)',
        v_row.id, v_row.now_status, v_row.now_resolved_at, v_row.now_updated_at;
    END IF;

    IF v_row.status = 'pending' AND v_row.now_status = 'pending'
       AND v_row.now_updated_at IS DISTINCT FROM v_row.updated_at THEN
      RAISE EXCEPTION 'upgrade: a migration made waiting proposal % look edited (updated_at %); switch pending_operations_updated_at off around a backfill, as 20261117192101 does',
        v_row.id, v_row.now_updated_at;
    END IF;

    IF v_row.operation_number IS DISTINCT FROM v_row.place
       AND NOT (v_row.status IN ('committed', 'rejected') AND v_row.operation_number IS NULL) THEN
      RAISE EXCEPTION 'upgrade: proposal % (seeded %) has number %, expected its place %',
        v_row.id, v_row.status, v_row.operation_number, v_row.place;
    END IF;
  END LOOP;

  -- 5 when the seed predates numbering (the migration counted the five), 0
  -- when the base already numbers at insert (the trigger made the counter).
  SELECT existing_count INTO v_counted
    FROM public.pending_operation_sequences
    WHERE company_id = '22222222-2222-2222-2222-222222222222';
  IF v_counted IS NULL OR v_counted NOT IN (0, 5) THEN
    RAISE EXCEPTION 'upgrade: numbering began with % proposals counted for the seeded company, expected 5 (or 0 when they were numbered at insert)', v_counted;
  END IF;

  INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, params)
  VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
          'create_customer', 'Skapa kund: Uppgraderingskund AB', '{}'::jsonb)
  RETURNING operation_number INTO v_next;
  IF v_next IS DISTINCT FROM 6 THEN
    RAISE EXCEPTION 'upgrade: the next proposal got number %, expected 6', v_next;
  END IF;

  RAISE NOTICE 'upgrade-path assertions passed: 5 proposals as seeded and numbered by creation order, next is %', v_next;
END $$;
