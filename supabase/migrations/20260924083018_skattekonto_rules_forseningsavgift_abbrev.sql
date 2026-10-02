-- Make the förseningsavgift rule actually fire on Skatteverket's own wording.
--
-- Two things kept it from ever matching a real statement row:
--
-- 1. Skatteverket writes the fee abbreviated. A skattekontoutdrag row reads
--    "Förs.avgift moms/arbetsgivardeklaration 251112", which does not contain
--    the string "förseningsavgift". Rule matching is a plain lowercase
--    substring test (src/extensions/general/skatteverket/lib/
--    skattekonto-booking.ts), so the rule never saw its own case. Both the
--    compact "förs.avgift" and the spaced "förs. avgift" / "förs avgift"
--    spellings are added.
--
-- 2. A fee row always names the tax it belongs to. That same text DOES
--    contain "moms", and the mervärdesskatt rule sits at priority 20 while
--    the fee rule sat at 25. First match by ascending priority wins, so even
--    with the abbreviation added the fee would have been booked to 2650
--    "Redovisningskonto för moms". A fee is not the tax it is a fee for, so
--    the fee rule has to outrank the tax-type rules: priority 15, between the
--    payment rules (10) and the tax types (20).
--
-- The effect is a wrong account on a posted verifikat: förseningsavgift and
-- skattetillägg are ej avdragsgilla (6992), and booking them on 2650 both
-- understates the cost and corrupts the VAT settlement account. Observed on a
-- real statement where 2 of 24 rows were affected.
--
-- System rows only (company_id IS NULL). No UI, API or MCP path writes
-- company-scoped skattekonto_rules; such a row can only come from a direct
-- insert, and this migration leaves any such row as it is.

UPDATE public.skattekonto_rules
SET pattern  = 'skattetillägg,förseningsavgift,förs.avgift,förs. avgift,förs avgift',
    priority = 15
WHERE company_id IS NULL
  AND counter_account = '6992'
  AND pattern LIKE '%förseningsavgift%';
