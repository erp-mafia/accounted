-- Migration: skattekonto rule for "Kvittning av utbetalning för rot- och rutarbeten"
--
-- Why this exists: when Skatteverket decides a rot/rut begäran while the
-- company owes tax, the payout never reaches the bank: it is set off on the
-- skattekonto, which shows a credit "Kvittning av utbetalning för rot- och
-- rutarbeten". That text contains "utbetalning", so the generic seed rule
-- 'utbetalning,återbetalning' (20260519100000, __PRIMARY_SEK__) booked it as a
-- bank movement: Debit 1630 / Credit 1930. No money moved on the bank, so the
-- bank account drifted from the bank statement, and the rot/rut receivable the
-- invoice booked on 1513 (fakturamodellen) stayed open (crm#1255).
--
-- The kvittning is the payout itself, received on the skattekonto instead of
-- the bank: swedish-invoice-compliance (references/invoice-rules.md, ROT/RUT)
-- books Skatteverket's payout Debit 1930 / Credit 1513, so the set-off is
-- Debit 1630 / Credit 1513. 1513 is the account the invoice flow books
-- Skatteverket's share on (account role rot_rut_receivable, under
-- fakturamodellen and, at the customer's payment, under kontantmetoden too).
--
-- Priority 5 sorts it ahead of the in-/utbetalning seeds (10), so the generic
-- rule no longer catches the text. A company's own rule below 5 still wins.
-- The pattern is the set-off's own wording only: "Preliminär skattereduktion
-- för rot/rut/grön teknik" (a private buyer's line) and a plain "Utbetalning"
-- or "Återsänd utbetalning från bank" do not match it and keep their rules.
--
-- Scope: system seed only (company_id IS NULL), no existing row is touched.
-- Rows already booked against 1930 are not repaired here: posted verifikat
-- are corrected by the company (storno or rättelse), never by a migration.

INSERT INTO public.skattekonto_rules (
  company_id, priority, pattern, company_type, counter_account, counter_account_ef, label
)
SELECT NULL, 5,
       'kvittning av utbetalning för rot,kvittning av utbetalning för rut',
       'all', '1513', NULL, 'Rot/rut-utbetalning kvittad på skattekontot'
WHERE NOT EXISTS (
  SELECT 1 FROM public.skattekonto_rules
  WHERE company_id IS NULL
    AND pattern = 'kvittning av utbetalning för rot,kvittning av utbetalning för rut'
);

NOTIFY pgrst, 'reload schema';
