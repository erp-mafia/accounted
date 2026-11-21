-- Migration: skattekonto rule for "Slutlig skatt"
--
-- Why this exists: when the slutskattebesked is registered, Skatteverket
-- charges the skattekonto "Slutlig skatt" and credits back the year's
-- preliminärskatt ("Beslut … Debiterad preliminärskatt", which the
-- preliminärskatt seed already books). No seed matched "Slutlig skatt", so
-- the row could not be booked from the skattekonto view: in production 432 of
-- 745 such rows stand unbooked, and the year's tax provision on 2512 was never
-- cleared from the books.
--
-- The counter-account follows swedish-daily-bookkeeping (skattekonto and
-- owner, F-skatt and slutlig skatt in an AB): in an aktiebolag (and any form
-- that books its income tax) the slutlig skatt settles the provision booked
-- at bokslut, Debit 2512 Beräknad inkomstskatt / Credit 1630. In an enskild
-- firma the tax is the owner's own and is booked as an eget uttag,
-- Debit 2013 / Credit 1630, as the preliminärskatt seed does since
-- 20260817120100. A difference between the provision and the assessed tax is
-- left on 2512 for the company to move to 8920; a särskild löneskatt included
-- in the slutlig skatt (2514) likewise. The pattern also matches "Omräkning
-- slutlig skatt", which adjusts the same assessment.
--
-- Priority 20, beside the other tax seeds: no other seed's pattern is a
-- substring of the text, and a penalty row ("Skattetillägg …") still meets the
-- penalty seed (15) first. A company's own rule below 20 still wins.
--
-- Scope: system seed only (company_id IS NULL); no existing row is touched.
-- Rows already booked elsewhere are not repaired here: posted verifikat are
-- corrected by the company (storno or rättelse), never by a migration.

INSERT INTO public.skattekonto_rules (
  company_id, priority, pattern, company_type, counter_account, counter_account_ef, label
)
SELECT NULL, 20, 'slutlig skatt', 'all', '2512', '2013', 'Slutlig skatt'
WHERE NOT EXISTS (
  SELECT 1 FROM public.skattekonto_rules
  WHERE company_id IS NULL
    AND pattern = 'slutlig skatt'
);

NOTIFY pgrst, 'reload schema';
