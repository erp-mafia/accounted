-- The company's switch for booking an incoming payment against its customer
-- invoice without a person (crm#2226).
--
-- When true, a bank row that names one open customer invoice by its OCR or
-- invoice number in the reference field, in the invoice's own currency and
-- for at most what is left on it, is booked on arrival through the same
-- function a person's match uses (lib/invoices/customer-payment-auto-book.ts).
-- A Bankgirot deposit whose every part names its invoice that way is booked
-- as one samlingsverifikat. Everything else stays a suggestion. The booking
-- is committed as the system actor, so the verifikat says it was booked by
-- Accounted, and reversing it opens the invoice and the bank row again.
--
-- Default false: nothing changes for a company until it is switched on.
-- Audited by the existing company_settings trigger and labelled in the
-- behandlingshistorik (BFNAR 2013:2 p. 9.16: a change to how bokföringsposter
-- are processed).
--
-- The code is live a few minutes before this runs: the switch reads as off
-- without the column (42703).

SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS auto_book_customer_payments boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.company_settings.auto_book_customer_payments IS
  'When true: an incoming bank payment that names one open customer invoice by its OCR or invoice number, in the invoice''s currency and for at most its remaining amount, is booked against it on arrival without a person (crm#2226). Default false.';

NOTIFY pgrst, 'reload schema';
