-- pg-test: covered-by tests/pg/bank-transaction-parts.pg.test.ts
-- The Bankgirot split of a bank row. A bankgiro deposit is one row on the
-- statement; Open Payments' enrichment delivers it with one part per payer
-- (name, organisationsnummer, OCR reference, invoice numbers, amount), and a
-- payout likewise per payee. The parts are stored here, one row per part in
-- the bank's order, so the person (or an agent) can settle every invoice
-- behind the row in one go through the batch allocation
-- (match_batch_allocate) instead of guessing the split by hand.
--
-- The parts never change the parent: transactions.amount, date and text stay
-- the bank's row, and the parts always sum to it. Each part may carry the
-- open invoice ingest suggests for it (suggested_invoice_id for a deposit,
-- suggested_supplier_invoice_id for a payout, never both) with the reason
-- (lib/transactions/part-suggestions.ts). A suggestion books nothing: the
-- batch allocation the person confirms does. A deleted invoice leaves the
-- part without a suggestion; a deleted transaction takes its parts with it.
--
-- Written by ingest (lib/transactions/ingest.ts, storeTransactionParts) with
-- the client the sync runs under, so the write policies mirror transactions'
-- own: a writing member of the active company, or the service role.

CREATE TABLE public.bank_transaction_parts (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                    uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  transaction_id                uuid NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  -- The bank's order, from 1.
  seq                           integer NOT NULL CHECK (seq >= 1),
  -- Signed like the parent: a deposit's parts are positive.
  amount                        numeric(14,2) NOT NULL,
  currency                      char(3) NOT NULL,
  counterparty_name             text,
  -- Digits only (10 digits; a 12-digit form drops the 16 prefix).
  counterparty_org_number       text,
  -- Bankgiro, plusgiro, BBAN or IBAN as the bank gives it.
  counterparty_account          text,
  -- The structured reference (OCR first).
  reference                     text,
  -- referredDocumentInformation[].number, deduped.
  invoice_numbers               text[] NOT NULL DEFAULT '{}',
  -- The unstructured remittance information, joined.
  message                       text,
  -- The alias row's transactionId or entryReference at the bank.
  provider_part_id              text,
  suggested_invoice_id          uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  suggested_supplier_invoice_id uuid REFERENCES public.supplier_invoices(id) ON DELETE SET NULL,
  suggestion_reason             text CHECK (suggestion_reason IS NULL OR suggestion_reason IN ('ocr_exact', 'invoice_number', 'amount_only')),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, seq),
  -- A part pays one kind of invoice: a deposit a customer invoice, a payout a supplier invoice.
  CHECK (suggested_invoice_id IS NULL OR suggested_supplier_invoice_id IS NULL)
);

COMMENT ON TABLE public.bank_transaction_parts IS
  'The Bankgirot split of a bank transaction (Open Payments enrichment): one row per payer or payee with amount, reference and the open invoice ingest suggests. Räkenskapsinformation beside the row it explains; never changes the parent amount.';
COMMENT ON COLUMN public.bank_transaction_parts.seq IS
  'Position in the bank''s order, from 1; unique per transaction.';
COMMENT ON COLUMN public.bank_transaction_parts.amount IS
  'The part''s amount, signed like the parent transaction. The parts of a row sum to its amount.';
COMMENT ON COLUMN public.bank_transaction_parts.reference IS
  'The structured payment reference the payer quoted (OCR first), as the bank gives it.';
COMMENT ON COLUMN public.bank_transaction_parts.invoice_numbers IS
  'Invoice numbers the payer named (referredDocumentInformation), deduped; empty when none.';
COMMENT ON COLUMN public.bank_transaction_parts.suggested_invoice_id IS
  'The open customer invoice ingest suggests this part pays (a deposit). A suggestion only: the batch allocation books it.';
COMMENT ON COLUMN public.bank_transaction_parts.suggested_supplier_invoice_id IS
  'The open supplier invoice ingest suggests this part pays (a payout). A suggestion only: the batch allocation books it.';
COMMENT ON COLUMN public.bank_transaction_parts.suggestion_reason IS
  'Why the invoice was suggested: ocr_exact (the reference matched), invoice_number (the payer named the invoice), amount_only (the counterparty''s one open invoice for this amount).';

CREATE INDEX bank_transaction_parts_company_transaction
  ON public.bank_transaction_parts (company_id, transaction_id);

CREATE TRIGGER update_bank_transaction_parts_updated_at
  BEFORE UPDATE ON public.bank_transaction_parts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.bank_transaction_parts ENABLE ROW LEVEL SECURITY;

-- Members of the company read its parts (transactions_select); writes follow
-- transactions_insert/update/delete: the active company and a writing role.
CREATE POLICY bank_transaction_parts_select ON public.bank_transaction_parts
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY bank_transaction_parts_insert ON public.bank_transaction_parts
  FOR INSERT WITH CHECK (company_id = public.current_active_company_id() AND public.current_user_can_write());

CREATE POLICY bank_transaction_parts_update ON public.bank_transaction_parts
  FOR UPDATE USING (company_id = public.current_active_company_id() AND public.current_user_can_write());

CREATE POLICY bank_transaction_parts_delete ON public.bank_transaction_parts
  FOR DELETE USING (company_id = public.current_active_company_id() AND public.current_user_can_write());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bank_transaction_parts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bank_transaction_parts TO service_role;
-- no-grant: anon on public.bank_transaction_parts (company bookkeeping data; no public surface reads it)

NOTIFY pgrst, 'reload schema';
