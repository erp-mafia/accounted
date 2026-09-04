-- Per-invoice payee: which of the company's bank accounts this invoice tells
-- the customer to pay to.
--
-- payment_cash_account_id: the account chosen on the invoice (NULL = the
--   company's default for the invoice currency, invoice_payee_defaults).
--   ON DELETE SET NULL: the snapshot below is what an issued invoice prints,
--   so losing the reference never changes a sent document.
-- payment_details: the payee fields as they were when the invoice was
--   written and last refreshed at issue (send / mark-sent / Peppol). Same
--   shape as company_settings.invoice_payment_accounts entries. Issued
--   invoices render from this column; a later edit of the account changes
--   new invoices only. NULL on invoices that never chose an account: they
--   keep resolving the default per currency as before.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS payment_cash_account_id uuid,
  ADD COLUMN IF NOT EXISTS payment_details jsonb
    CHECK (payment_details IS NULL OR jsonb_typeof(payment_details) = 'object');

-- Same-company proof in the constraint itself (the composite target
-- cash_accounts(id, company_id) exists since 20260904010000): a direct
-- PostgREST write cannot attach another tenant's account. SET NULL is scoped
-- to the account column (PG15 column list); company_id must never be nulled.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_payment_cash_account_same_company') THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_payment_cash_account_same_company
        FOREIGN KEY (payment_cash_account_id, company_id)
        REFERENCES public.cash_accounts(id, company_id)
        ON DELETE SET NULL (payment_cash_account_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_invoices_payment_cash_account
  ON public.invoices (company_id, payment_cash_account_id)
  WHERE payment_cash_account_id IS NOT NULL;

COMMENT ON COLUMN public.invoices.payment_cash_account_id IS
  'Bank account (cash_accounts) this invoice asks the customer to pay to. NULL = the per-currency default. Editable while draft only.';
COMMENT ON COLUMN public.invoices.payment_details IS
  'Payee fields frozen for this invoice (bankgiro, plusgiro, clearing/account, IBAN, BIC, Swish, ...). Written when an account is chosen and refreshed at issue; issued invoices print from here.';

NOTIFY pgrst, 'reload schema';
