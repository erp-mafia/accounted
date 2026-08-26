-- Migration: skattekonto_rules.requires_employer
--
-- The 'avdragen skatt,personalskatt,a-skatt' seed rule maps unconditionally
-- to 2710 (Personalskatt) for every entity type. For an aktiebolag that is
-- always right: a personalskatt line on the company's skattekonto implies
-- payroll. For an enskild firma WITHOUT registered employees it is wrong:
-- the EF's skattekonto is the owner's personal account, and "Avdragen skatt"
-- there is almost always A-skatt an outside employer withheld from the
-- owner's personal salary, not an affarshandelse of the firm. Crediting 2710
-- would fabricate a payroll liability the firm never had.
--
-- The distinguishing signal is dynamic per company (does it actually employ
-- anyone?), which the static counter_account_ef column cannot express. So the
-- gate is data-driven: rules flagged requires_employer only apply to an
-- enskild firma when company_settings.employer_registered is true (the same
-- signal that gates AGI reminders, 20260717151000). An AB is unaffected; an
-- employer-registered EF keeps 2710. The code gate lives in
-- extensions/general/skatteverket/lib/skattekonto-booking.ts.
--
-- Follows the 20260817120100 precedent: update the NULL-company system seed
-- row AND any per-company clones of the same pattern.

ALTER TABLE public.skattekonto_rules
  ADD COLUMN IF NOT EXISTS requires_employer BOOLEAN NOT NULL DEFAULT false;

UPDATE public.skattekonto_rules
SET requires_employer = true
WHERE pattern = 'avdragen skatt,personalskatt,a-skatt'
  AND requires_employer IS DISTINCT FROM true;

NOTIFY pgrst, 'reload schema';
