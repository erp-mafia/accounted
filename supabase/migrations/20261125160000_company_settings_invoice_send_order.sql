-- The order the invoice editor tries the ways of sending an invoice in:
-- peppol, kivra, billo and email, each at most once. Null means no order has
-- been chosen, and the editor keeps its own default.
--
-- Read by lib/invoices/send-order.ts (defaultChannelByOrder).

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS invoice_send_order text[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'company_settings_invoice_send_order_check'
      AND conrelid = 'public.company_settings'::regclass
  ) THEN
    ALTER TABLE public.company_settings
      ADD CONSTRAINT company_settings_invoice_send_order_check
      CHECK (invoice_send_order <@ ARRAY['peppol', 'kivra', 'billo', 'email']::text[]);
  END IF;
END
$$;

COMMENT ON COLUMN public.company_settings.invoice_send_order IS
  'The ways invoices go out, in the order the editor tries them (peppol, kivra, billo, email). Null = no order chosen.';

NOTIFY pgrst, 'reload schema';
