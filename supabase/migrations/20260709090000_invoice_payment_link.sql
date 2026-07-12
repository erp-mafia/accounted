-- Optional online payment link on customer invoices (manual MVP).
--
-- The user creates a payment link in their PSP dashboard (e.g. a Stripe
-- Payment Link), pastes it onto the invoice, and it renders as a
-- "Betala online" button in the invoice email and as a QR code + link on
-- the PDF. There is no PSP integration server-side: the column is a plain
-- URL. Validation (https-only, length cap) lives in the API schema
-- (lib/api/schemas.ts). Derived documents (credit notes, proforma
-- conversions, recurring-schedule invoices) intentionally do NOT copy this
-- column: a pasted link encodes one specific amount for one specific
-- invoice, and carrying it over would silently point at the wrong amount.
alter table public.invoices
  add column if not exists payment_link_url text;

comment on column public.invoices.payment_link_url is
  'Optional https link where the customer can pay this invoice online (pasted by the user, e.g. a Stripe Payment Link). Rendered in the invoice email and on the PDF. Never copied to derived documents.';
