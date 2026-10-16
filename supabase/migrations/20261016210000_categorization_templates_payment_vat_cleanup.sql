-- crm#1275: learned counterpart templates that put moms on a payment that never
-- carries any. Data only, no schema change.
--
-- (a) A payment to Skatteverket is booked on the skattekonto by rule
--     (lib/bookkeeping/skatteverket-payment.ts, leadWithSkattekonto in
--     lib/transactions/propose.ts), and templates learned from one are no
--     longer offered for it. Those that teach moms or a cost account on money
--     going out to Skatteverket are switched off, the same write as
--     "Ta bort mall" (categorization_templates_sync_mode moves them to
--     paused), so the Mallar page stops showing them as habits. Money in from
--     Skatteverket (a ROT/RUT payout, a sale under kontantmetoden) is left
--     alone: its credit leg is not a bank ledger.
--
-- (b) A correction kept the old moms when the corrected pair books none
--     (insertOrUpdateTemplate, fixed in the same change): a template moved from
--     a cost with 25 % to 1630 or 2440 kept the 25 %. Every row this matched on
--     production had exactly that history in audit_log. The moms is cleared on
--     corrected single-pair templates whose pair is a bank ledger against an
--     account a bank payment never carries input VAT on: the skattekonto
--     (1630, 2012), the owner (2013, 2018, 2393, 2893), a payable being settled
--     (2440, 2890) and the tax liabilities (2510, 2650, 2710, 2731). The pair
--     itself is what the person booked and stays.

UPDATE public.categorization_templates
SET is_active = false
WHERE is_active
  AND credit_account ~ '^19'
  AND (
    counterparty_name ~* '(^|[^[:alpha:]])skatteverket'
    OR counterparty_name ~* '^skv( |$)'
    OR array_to_string(counterparty_aliases, ' ') ~* '(^|[^[:alpha:]])skatteverket'
  )
  AND (
    vat_treatment IN ('standard_25', 'reduced_12', 'reduced_6', 'reverse_charge')
    OR debit_account ~ '^[3-8][0-9]{3}$'
  );

UPDATE public.categorization_templates
SET vat_treatment = NULL,
    vat_account = NULL
WHERE is_active
  AND corrections > 0
  AND line_pattern IS NULL
  AND vat_treatment IN ('standard_25', 'reduced_12', 'reduced_6', 'reverse_charge')
  AND (
    (credit_account ~ '^19' AND debit_account IN (
      '1630', '2012', '2013', '2018', '2393', '2440', '2510', '2650', '2710', '2731', '2890', '2893'
    ))
    OR (debit_account ~ '^19' AND credit_account IN (
      '1630', '2012', '2013', '2018', '2393', '2440', '2510', '2650', '2710', '2731', '2890', '2893'
    ))
  );
