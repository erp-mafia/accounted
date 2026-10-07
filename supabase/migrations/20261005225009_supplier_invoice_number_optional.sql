-- A supplier invoice may lack the supplier's own invoice number (crm#1039).
--
-- supplier_invoices.supplier_invoice_number is the number the SUPPLIER printed
-- on its invoice. Some supplier documents carry none: a förenklad faktura
-- (ML 17 kap 26-28 §§ needs no löpnummer), a receipt, an autogiro notice.
-- On 2026-09-23 the provider import started to store such an invoice with a
-- NULL number instead of a stand-in (the provider's record id or an invented
-- text), but the column kept the NOT NULL it got in 20240101000025, so every
-- such record failed its INSERT with SQLSTATE 23502 and never reached the
-- leverantörsreskontra.
--
-- The buyer's own identification of the invoice is unchanged: the verifikat
-- number (BFL 5 kap 7 §) and arrival_number (the leverantörsreskontra's
-- löpnummer, NOT NULL and unique per company) still identify every invoice.
-- Numbering the invoice is the seller's duty (ML 17 kap 24 § p. 2).
--
-- Uniqueness for real numbers is unchanged:
-- idx_supplier_invoices_company_supplier_number (20260423121000) is partial on
-- supplier_invoice_number IS NOT NULL, so number-less invoices never collide
-- with each other or with numbered ones.
--
-- A missing number has one form only: NULL. An empty or whitespace-only
-- string would count as a real number in that index, so two number-less
-- invoices from one supplier would collide on it. The CHECK keeps such
-- strings out. Production held none on 2026-10-05 (14 561 rows), so the
-- constraint is added validated. Numbers with surrounding whitespace stay as
-- stored: the CHECK refuses only a value with no visible character.

ALTER TABLE public.supplier_invoices
  ALTER COLUMN supplier_invoice_number DROP NOT NULL;

ALTER TABLE public.supplier_invoices
  ADD CONSTRAINT supplier_invoices_number_not_blank
  CHECK (supplier_invoice_number IS NULL OR supplier_invoice_number ~ '[^[:space:]]');

COMMENT ON COLUMN public.supplier_invoices.supplier_invoice_number IS
  'The supplier''s own invoice number as printed on its invoice; NULL when the document carries none, never a stand-in. Unique per company and supplier among live invoices (idx_supplier_invoices_company_supplier_number).';

NOTIFY pgrst, 'reload schema';
