-- Customer-level invoice delivery metadata carried by provider migrations.
-- NULL means the provider/user has not configured the field; an empty array
-- is an explicit "no copy recipients" choice and must survive re-syncs.
ALTER TABLE public.customers
  ADD COLUMN contact_person text,
  ADD COLUMN invoice_email_cc_addresses text[],
  ADD COLUMN invoice_email_bcc_addresses text[];

ALTER TABLE public.customers
  ADD CONSTRAINT customers_contact_person_length_check
    CHECK (contact_person IS NULL OR char_length(contact_person) <= 200),
  ADD CONSTRAINT customers_invoice_email_copy_recipient_limit_check
    CHECK (
      cardinality(COALESCE(invoice_email_cc_addresses, '{}'::text[]))
      + cardinality(COALESCE(invoice_email_bcc_addresses, '{}'::text[]))
      <= 19
    );

COMMENT ON COLUMN public.customers.contact_person IS
  'Customer contact/reference person used by provider migrations and invoicing.';
COMMENT ON COLUMN public.customers.invoice_email_cc_addresses IS
  'Customer-specific invoice CC recipients. NULL means unconfigured; empty means explicitly none.';
COMMENT ON COLUMN public.customers.invoice_email_bcc_addresses IS
  'Customer-specific invoice BCC recipients. NULL means unconfigured; empty means explicitly none.';

NOTIFY pgrst, 'reload schema';
