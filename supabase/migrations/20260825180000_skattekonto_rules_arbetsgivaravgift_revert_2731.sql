-- Migration: revert arbetsgivaravgifter mapping 2730 -> 2731 (issue #1870)
--
-- Why this exists: 20260519160000_skattekonto_rules_arbetsgivaravgift_2730.sql
-- moved the AGI / arbetsgivaravgifter / sociala avgifter system seed from 2731
-- to 2730, citing a compliance review finding. That change was based on an
-- incorrect premise and split the liability across two accounts:
--
--   * The salary module credits 2731 when a salary run is booked
--     (SALARY_ACCOUNTS.AVGIFTER_LIABILITY in lib/salary/account-mapping.ts),
--     and the whole-krona / ore-residual logic is built around 2731.
--   * The skattekonto AGI draw debited 2730 after that migration, so for any
--     company using both subsystems the two legs never meet: 2731 accumulates
--     credits, 2730 accumulates debits, and only the 27-group sum is correct.
--     SRU code is 7231 for both, so SRU/INK2 and the balance sheet hide it;
--     only an account-level huvudbok reconciliation exposes the drift.
--
-- The old migration's rationale ("2731 is the period-end accrual posting
-- target / interimsskuld") contradicts BAS 2026 itself: 2731 Avrakning
-- lagstadgade sociala avgifter is "arbetsgivaravgifter redovisade men annu
-- inte inbetalda till Skatteverket", which is exactly the salary module's
-- monthly credit. The accrual account is 2940 Upplupna lagstadgade sociala
-- och andra avgifter, which the salary module already uses for the vacation
-- accrual leg (VACATION_AVGIFTER_LIABILITY). Booking directly on the group
-- account 2730 is a legitimate simplification, but the two subsystems must
-- agree on one account, and 2731 matches both BAS praxis and the existing
-- salary bookings.
--
-- NOTE for future compliance reviews: do not flip this back to 2730 without
-- also changing SALARY_ACCOUNTS.AVGIFTER_LIABILITY and migrating existing
-- 2731 balances; a one-sided change reintroduces issue #1870.
--
-- Scope: system seed only (company_id IS NULL). Per-company override rules
-- have lower priority numbers and are untouched. Historical entries booked
-- against 2730 since 2026-05-19 are NOT repaired here; affected companies
-- clear the offset with a reclass verifikat (debit 2731 / credit 2730).

UPDATE public.skattekonto_rules
SET counter_account = '2731',
    updated_at = now()
WHERE company_id IS NULL
  AND counter_account = '2730'
  AND pattern = 'arbetsgivaravgift,sociala avgifter,agi';

NOTIFY pgrst, 'reload schema';
