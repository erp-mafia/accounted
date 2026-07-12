-- Stripe payment link automation on invoices.
--
-- stripe_payment_link_id: the plink_... id of the auto-created Stripe Payment
-- Link (NULL for manually pasted links). Presence marks provenance, drives
-- deactivation on credit/paid, and is the deterministic matching key when a
-- checkout.session.completed event points back at the invoice
-- (session.payment_link == this id).
--
-- payment_link_auto: per-invoice opt-out for the automation. When TRUE (the
-- default) and the company has an active Stripe connection, sending the
-- invoice creates a Payment Link and fills payment_link_url. A manually
-- pasted payment_link_url always wins (the hook only fires when the column
-- is NULL). Like payment_link_url itself, neither column is copied to
-- derived documents (credit notes, proforma conversions, recurring copies).

alter table public.invoices
  add column if not exists stripe_payment_link_id text,
  add column if not exists payment_link_auto boolean not null default true;

comment on column public.invoices.stripe_payment_link_id is
  'Stripe Payment Link id (plink_...) when the link was auto-created via the Stripe extension. NULL for manual links.';
comment on column public.invoices.payment_link_auto is
  'Create a Stripe Payment Link automatically on send (when connected and payment_link_url is empty).';

NOTIFY pgrst, 'reload schema';
