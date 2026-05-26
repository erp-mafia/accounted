-- Migration: fix arbetsgivaravgifter mapping 2731 -> 2730
--
-- Why this exists: the initial seed in 20260519100000_skattekonto_rules.sql
-- routed the AGI / arbetsgivaravgifter / sociala avgifter SKV pattern to 2731
-- (Avräkning för arbetsgivaravgifter / accrued liability). The Swedish payroll
-- skill (BAS-praxis) is unambiguous:
--   * 7510 Lagstadgade sociala avgifter (kostnad) → debited monthly together
--     with 2730 Lagstadgade sociala avgifter (skuld) on the credit side.
--   * 2730 is the redovisningskonto (the running clearing account) that gets
--     debited when SKV draws the amount from the skattekonto.
--   * 2731 is the period-end accrual posting target (interimsskuld), used
--     for the year-end semesterlöneskuld / accrued-but-not-paid leg.
--
-- Routing the AGI payment-clearing leg to 2731 leaves a permanent unexplained
-- balance on 2730 after each AGI month closes because the accrual leg never
-- gets cleared. Per swedish-payroll the correct counter-account for the
-- skattekonto AGI debit is 2730.
--
-- Compliance: addresses the Swedish accounting compliance review finding
-- "Arbetsgivaravgifter mapped to 2731, not 2730".

UPDATE public.skattekonto_rules
SET counter_account = '2730',
    updated_at = now()
WHERE company_id IS NULL
  AND counter_account = '2731'
  AND pattern = 'arbetsgivaravgift,sociala avgifter,agi';

NOTIFY pgrst, 'reload schema';
