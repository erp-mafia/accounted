-- One-off BAS96 -> BAS2025 chart-of-accounts remap for Krister Sundling.
-- Run from the Supabase Studio SQL editor (Project Settings -> SQL Editor).
-- Equivalent of scripts/remap-krister-bas96-to-bas2025.ts but executed
-- entirely server-side, so it doesn't need the DB password.
--
-- Before running:
--   1. Take a Supabase backup (Database -> Backups -> Create backup).
--   2. Read this entire file. The identity check is at line ~50.
--   3. Make sure no fiscal period is closed/locked (the script aborts if so).
--
-- Safety:
--   * Identity is hard-coded (ks@sundlingwarn.com + company name contains "sundling").
--   * The whole DO block is one transaction. Any RAISE EXCEPTION rolls back.
--   * Grand debit/credit invariant is checked at the end -- mismatch -> rollback.
--   * Only Krister's company_id is written to. Every UPDATE/INSERT/DELETE filters by it.
--
-- After running, watch the "Notices" panel below the editor for progress and the
-- final summary. If the DO block errors out, the whole transaction rolls back.

BEGIN;

DO $remap$
DECLARE
  -- ────────────────────────────────────────────────────────────────
  -- Hard-coded identity (no override). Aborts if either doesn't match.
  -- ────────────────────────────────────────────────────────────────
  v_expected_email     constant text := 'ks@sundlingwarn.com';
  v_expected_fragment  constant text := 'cesu';  -- Krister's holding company: CeSu Invest AB

  v_user_id     uuid;
  v_user_email  text;
  v_company_id  uuid;
  v_company_name text;
  v_owner_count int;

  -- counters
  v_inserted_accounts int := 0;
  v_updated_lines     bigint := 0;
  v_deleted_accounts  int := 0;
  v_locked_periods    int;

  v_old_id     uuid;
  v_target_id  uuid;
  v_line_count bigint;

  -- invariants
  v_debit_before  numeric;
  v_credit_before numeric;
  v_debit_after   numeric;
  v_credit_after  numeric;

  m record;  -- mapping iterator
BEGIN
  PERFORM set_config('gnubok.allow_delete', 'true', true);

  -- ────────────────────────────────────────────────────────────────
  -- 1. Resolve user
  -- ────────────────────────────────────────────────────────────────
  SELECT id, email INTO v_user_id, v_user_email
  FROM auth.users
  WHERE LOWER(email) = LOWER(v_expected_email);

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No auth.users row for email %', v_expected_email;
  END IF;

  -- ────────────────────────────────────────────────────────────────
  -- 2. Resolve company (owner/admin role)
  -- ────────────────────────────────────────────────────────────────
  SELECT COUNT(*) INTO v_owner_count
  FROM public.company_members
  WHERE user_id = v_user_id AND role IN ('owner', 'admin');

  IF v_owner_count = 0 THEN
    RAISE EXCEPTION 'User % owns/admins no companies', v_user_id;
  ELSIF v_owner_count > 1 THEN
    RAISE EXCEPTION
      'User % owns/admins % companies -- this script supports exactly one. '
      'Add a WHERE c.id = ''<uuid>'' filter below to pick one explicitly.',
      v_user_id, v_owner_count;
  END IF;

  SELECT c.id, c.name INTO v_company_id, v_company_name
  FROM public.companies c
  JOIN public.company_members cm ON cm.company_id = c.id
  WHERE cm.user_id = v_user_id AND cm.role IN ('owner', 'admin');

  -- ────────────────────────────────────────────────────────────────
  -- 3. Identity assertions (hard checks; no override)
  -- ────────────────────────────────────────────────────────────────
  IF LOWER(v_user_email) <> LOWER(v_expected_email) THEN
    RAISE EXCEPTION 'Identity check FAILED: email % != expected %', v_user_email, v_expected_email;
  END IF;

  IF POSITION(LOWER(v_expected_fragment) IN LOWER(v_company_name)) = 0 THEN
    RAISE EXCEPTION 'Identity check FAILED: company "%" does not contain "%"',
      v_company_name, v_expected_fragment;
  END IF;

  RAISE NOTICE 'Resolved user   : % (%)', v_user_email, v_user_id;
  RAISE NOTICE 'Resolved company: % (%)', v_company_name, v_company_id;

  -- ────────────────────────────────────────────────────────────────
  -- 4. Period lock check (bypass GUC does NOT unlock periods)
  -- ────────────────────────────────────────────────────────────────
  SELECT COUNT(*) INTO v_locked_periods
  FROM public.fiscal_periods
  WHERE company_id = v_company_id AND (is_closed = true OR locked_at IS NOT NULL);

  IF v_locked_periods > 0 THEN
    RAISE EXCEPTION 'Refusing to run: % closed/locked fiscal periods exist for this company',
      v_locked_periods;
  END IF;

  -- ────────────────────────────────────────────────────────────────
  -- 5. Pre-flight grand totals (invariant)
  -- ────────────────────────────────────────────────────────────────
  SELECT COALESCE(SUM(l.debit_amount), 0), COALESCE(SUM(l.credit_amount), 0)
  INTO v_debit_before, v_credit_before
  FROM public.journal_entry_lines l
  JOIN public.journal_entries je ON je.id = l.journal_entry_id
  WHERE je.company_id = v_company_id;

  RAISE NOTICE 'Pre-flight totals: debit=% credit=%', v_debit_before, v_credit_before;

  -- ────────────────────────────────────────────────────────────────
  -- 5b. Rename every source account to a __mig__ prefix so target lookups
  -- can never collide with an empty source row (handles the 1360 swap:
  -- old 1360 -> 1760 AND old 1630 -> new 1360 in the same run).
  -- ────────────────────────────────────────────────────────────────
  UPDATE public.chart_of_accounts
  SET account_number = '__mig__' || account_number
  WHERE company_id = v_company_id
    AND account_number IN (
      '1040','1050','1051','1052','1053','1055','1056','1060','1061',
      '1210','1360','1623','1624','1625','1626','1627','1628','1629',
      '1630','1631','1632','2210','2211','2330','2480','2510','2690',
      '2864','2991','2992','2997','2999'
    );

  -- ────────────────────────────────────────────────────────────────
  -- 6. Iterate mappings: INSERT target if missing, move lines, count.
  -- ────────────────────────────────────────────────────────────────
  FOR m IN
    SELECT * FROM (VALUES
      -- Bank och likvida medel
      ('1040', '1930', 'Företagskonto',                                       1, 'asset',     'debit',  '19'),
      ('1050', '1940', 'Likviditetskonto',                                    1, 'asset',     'debit',  '19'),
      ('1051', '1941', 'Valutakonto GBP',                                     1, 'asset',     'debit',  '19'),
      ('1052', '1942', 'Valutakonto EUR',                                     1, 'asset',     'debit',  '19'),
      ('1053', '1943', 'Fasträntekonto',                                      1, 'asset',     'debit',  '19'),
      ('1055', '1944', 'Sparkonto SBAB',                                      1, 'asset',     'debit',  '19'),
      -- Värdepapper / placeringar
      ('1056', '1361', 'Depå Carnegie',                                       1, 'asset',     'debit',  '13'),
      ('1060', '1385', 'Kapitalförsäkring (Avanza)',                          1, 'asset',     'debit',  '13'),
      ('1061', '1386', 'Kapitalförsäkring (Movestic)',                        1, 'asset',     'debit',  '13'),
      ('1210', '1510', 'Kundfordringar',                                      1, 'asset',     'debit',  '15'),
      ('1360', '1760', 'Upplupna ränteintäkter',                              1, 'asset',     'debit',  '17'),
      ('1623', '1330', 'Andelar i intresseföretag',                           1, 'asset',     'debit',  '13'),
      ('1624', '1311', 'Andelar i dotterföretag — Divigen',                  1, 'asset',     'debit',  '13'),
      ('1625', '1350', 'Andelar i andra företag',                             1, 'asset',     'debit',  '13'),
      ('1626', '1351', 'Andelar i andra utländska företag',                   1, 'asset',     'debit',  '13'),
      ('1627', '1352', 'Andelar — Impilo',                                   1, 'asset',     'debit',  '13'),
      ('1628', '1353', 'Andelar — Röko',                                     1, 'asset',     'debit',  '13'),
      ('1629', '1354', 'Andelar — Altor V',                                  1, 'asset',     'debit',  '13'),
      ('1630', '1360', 'Aktiefonder (HB Microcap)',                           1, 'asset',     'debit',  '13'),
      ('1631', '1355', 'Andelar — Altor VI',                                 1, 'asset',     'debit',  '13'),
      ('1632', '1356', 'Andelar — Impilo Orphan',                            1, 'asset',     'debit',  '13'),
      -- Skatt och moms (2210 + 2211 merged into 1630 Skattekonto)
      ('2210', '1630', 'Skattekonto',                                         1, 'asset',     'debit',  '16'),
      ('2211', '1630', 'Skattekonto',                                         1, 'asset',     'debit',  '16'),
      ('2330', '2941', 'Upplupna lagstadgade soc. avgifter',                  2, 'liability', 'credit', '29'),
      ('2480', '2650', 'Redovisningskonto för moms',                          2, 'liability', 'credit', '26'),
      ('2510', '2710', 'Personalens källskatt',                               2, 'liability', 'credit', '27'),
      -- Övriga skulder och reserver
      ('2690', '2890', 'Övriga kortfristiga skulder',                         2, 'liability', 'credit', '28'),
      ('2864', '2126', 'Periodiseringsfond avsatt vid taxering 2026',         2, 'equity',    'credit', '21'),
      -- Eget kapital
      ('2991', '2081', 'Aktiekapital',                                        2, 'equity',    'credit', '20'),
      ('2992', '2086', 'Reservfond',                                          2, 'equity',    'credit', '20'),
      ('2997', '2091', 'Balanserat resultat',                                 2, 'equity',    'credit', '20'),
      ('2999', '2099', 'Årets resultat',                                      2, 'equity',    'credit', '20')
    ) AS t(old_number, new_number, new_name, account_class, account_type, normal_balance, account_group)
  LOOP
    -- Find existing old account (now under the __mig__ prefix)
    SELECT id INTO v_old_id
    FROM public.chart_of_accounts
    WHERE company_id = v_company_id AND account_number = '__mig__' || m.old_number;

    IF v_old_id IS NULL THEN
      RAISE NOTICE '  skip %: old account not in chart (already migrated?)', m.old_number;
      CONTINUE;
    END IF;

    -- Find existing target account, or INSERT it
    SELECT id INTO v_target_id
    FROM public.chart_of_accounts
    WHERE company_id = v_company_id AND account_number = m.new_number;

    IF v_target_id IS NULL THEN
      INSERT INTO public.chart_of_accounts
        (user_id, company_id, account_number, account_name, account_class,
         account_group, account_type, normal_balance, plan_type, is_active, is_system_account)
      VALUES
        (v_user_id, v_company_id, m.new_number, m.new_name, m.account_class,
         m.account_group, m.account_type, m.normal_balance, 'full_bas', true, false)
      RETURNING id INTO v_target_id;
      v_inserted_accounts := v_inserted_accounts + 1;
      RAISE NOTICE '  insert account %  %', m.new_number, m.new_name;
    END IF;

    -- Idempotent no-op
    IF v_target_id = v_old_id THEN
      CONTINUE;
    END IF;

    -- Move lines old -> target (scoped by parent journal_entries.company_id)
    WITH moved AS (
      UPDATE public.journal_entry_lines l
      SET account_id = v_target_id, account_number = m.new_number
      FROM public.journal_entries je
      WHERE l.journal_entry_id = je.id
        AND je.company_id = v_company_id
        AND l.account_id = v_old_id
      RETURNING l.id
    )
    SELECT COUNT(*) INTO v_line_count FROM moved;
    v_updated_lines := v_updated_lines + v_line_count;

    RAISE NOTICE '  remap % -> % (% lines moved)', m.old_number, m.new_number, v_line_count;
  END LOOP;

  -- ────────────────────────────────────────────────────────────────
  -- 7. (skipped) account_balances was dropped in migration
  -- 20240101000027_drop_unused_module_tables.sql -- no cache to clean.
  -- ────────────────────────────────────────────────────────────────

  -- ────────────────────────────────────────────────────────────────
  -- 8. Delete the __mig__-prefixed source rows now that they have no lines.
  -- Safety: refuses to delete if any line still references one.
  -- ────────────────────────────────────────────────────────────────
  FOR m IN
    SELECT id, account_number
    FROM public.chart_of_accounts
    WHERE company_id = v_company_id
      AND LEFT(account_number, 7) = '__mig__'
  LOOP
    SELECT COUNT(*) INTO v_line_count
    FROM public.journal_entry_lines l
    JOIN public.journal_entries je ON je.id = l.journal_entry_id
    WHERE l.account_id = m.id AND je.company_id = v_company_id;

    IF v_line_count <> 0 THEN
      RAISE EXCEPTION 'Refusing to delete migrate-source account % (%) -- % lines still reference it',
        m.account_number, m.id, v_line_count;
    END IF;

    DELETE FROM public.chart_of_accounts WHERE id = m.id AND company_id = v_company_id;
    v_deleted_accounts := v_deleted_accounts + 1;
  END LOOP;

  -- ────────────────────────────────────────────────────────────────
  -- 9. Post-flight invariant check
  -- ────────────────────────────────────────────────────────────────
  SELECT COALESCE(SUM(l.debit_amount), 0), COALESCE(SUM(l.credit_amount), 0)
  INTO v_debit_after, v_credit_after
  FROM public.journal_entry_lines l
  JOIN public.journal_entries je ON je.id = l.journal_entry_id
  WHERE je.company_id = v_company_id;

  IF v_debit_before <> v_debit_after OR v_credit_before <> v_credit_after THEN
    RAISE EXCEPTION
      'INVARIANT BROKEN: grand debit/credit totals diverged. '
      'Before D=% C=%, After D=% C=%. Rolling back.',
      v_debit_before, v_credit_before, v_debit_after, v_credit_after;
  END IF;

  RAISE NOTICE '─────────────────────────────────────────';
  RAISE NOTICE 'Done.';
  RAISE NOTICE '  Inserted accounts : %', v_inserted_accounts;
  RAISE NOTICE '  Updated lines     : %', v_updated_lines;
  RAISE NOTICE '  Deleted accounts  : %', v_deleted_accounts;
  RAISE NOTICE '  Grand totals OK   : debit=% credit=%', v_debit_after, v_credit_after;
  RAISE NOTICE '─────────────────────────────────────────';
END
$remap$;

-- Change the next line to ROLLBACK for a dry run, COMMIT to apply.
COMMIT;
