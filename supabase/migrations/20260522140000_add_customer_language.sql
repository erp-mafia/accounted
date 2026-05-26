-- Add language preference per customer.
--
-- Drives the locale of the customer-facing invoice PDF and email when this
-- customer is invoiced. Defaults to Swedish, matching the existing behavior.
-- Adding more locales is a follow-up migration so we never end up with an
-- orphan value the templates don't have translations for.
--
-- Per-customer (not per-invoice) because the user shouldn't have to pick a
-- language every time they bill the same recipient — set it once on the
-- customer record and every future invoice + email honors it.

ALTER TABLE public.customers
  ADD COLUMN language TEXT NOT NULL DEFAULT 'sv'
  CHECK (language IN ('sv', 'en'));

NOTIFY pgrst, 'reload schema';
