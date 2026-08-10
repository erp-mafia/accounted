-- Supplier payment batches (betalfil for leverantorsfakturor).
--
-- A batch is a snapshot of payment instructions handed to the user's bank as a
-- pain.001 file. The file regenerates deterministically from these rows alone
-- (msg_id stored at creation, CreDtTm derived from created_at), so a
-- re-download is byte-identical and bank-side duplicate detection works; a new
-- batch gets a new msg_id. This closes, for supplier payments, the
-- no-regeneration-guard hazard documented for the salary payment files
-- (DECISIONS.md 2026-07-26).
--
-- Generating a file moves no money and books nothing: settlement stays in the
-- existing mark-paid / bank-match flows. Batch settlement progress is derived
-- at read time by joining items to live supplier_invoices; it is never stored.
--
-- format allows 'bg_lb' at the DB level so a future LB or pain.001.001.09
-- addition needs no migration; the v1 API accepts only 'pain001'.

CREATE TABLE public.supplier_payment_batches (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  format            text NOT NULL CHECK (format IN ('pain001', 'bg_lb')),
  status            text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'cancelled')),
  currency          text NOT NULL DEFAULT 'SEK',
  total_amount      numeric NOT NULL CHECK (total_amount > 0),
  item_count        integer NOT NULL CHECK (item_count > 0),
  -- pain.001 MsgId, derived from the batch id at creation (Max35Text). Stored
  -- so regeneration never recomputes it differently.
  msg_id            text NOT NULL,
  -- Debtor snapshot at creation: {name, org_number, iban, bic}. Later changes
  -- to company_settings never mutate an existing batch.
  debtor_snapshot   jsonb NOT NULL,
  file_generated_at timestamptz,
  download_count    integer NOT NULL DEFAULT 0,
  cancelled_at      timestamptz,
  cancelled_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.supplier_payment_batch_items (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  batch_id            uuid NOT NULL REFERENCES public.supplier_payment_batches(id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- RESTRICT: a batch item documents a payment instruction possibly already
  -- handed to a bank; the invoice behind it must not vanish. The supplier
  -- invoice DELETE route pre-checks and returns a friendly error.
  supplier_invoice_id uuid NOT NULL REFERENCES public.supplier_invoices(id) ON DELETE RESTRICT,
  amount              numeric NOT NULL CHECK (amount > 0),
  payment_date        date NOT NULL,
  -- Payee and reference snapshot at creation; supplier edits after batch
  -- creation never change what the generated file says.
  payee_type          text NOT NULL CHECK (payee_type IN ('bankgiro', 'plusgiro', 'bank_account')),
  payee_bankgiro      text,
  payee_plusgiro      text,
  payee_clearing      text,
  payee_account       text,
  payee_name          text NOT NULL,
  reference_type      text NOT NULL CHECK (reference_type IN ('ocr', 'invoice_number')),
  reference           text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_supplier_payment_batch_invoice UNIQUE (batch_id, supplier_invoice_id),
  CONSTRAINT supplier_payment_batch_items_payee_fields_match CHECK (
    (payee_type = 'bankgiro' AND payee_bankgiro IS NOT NULL)
    OR (payee_type = 'plusgiro' AND payee_plusgiro IS NOT NULL)
    OR (payee_type = 'bank_account' AND payee_clearing IS NOT NULL AND payee_account IS NOT NULL)
  )
);

ALTER TABLE public.supplier_payment_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_payment_batch_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company supplier_payment_batches"
  ON public.supplier_payment_batches FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company supplier_payment_batches"
  ON public.supplier_payment_batches FOR INSERT
  WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company supplier_payment_batches"
  ON public.supplier_payment_batches FOR UPDATE
  USING (company_id IN (SELECT user_company_ids()));
-- No DELETE policy on batches: a batch documents a payment instruction that
-- may already sit at the bank. Lifecycle ends at status 'cancelled'.

CREATE POLICY "view own-company supplier_payment_batch_items"
  ON public.supplier_payment_batch_items FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company supplier_payment_batch_items"
  ON public.supplier_payment_batch_items FOR INSERT
  WITH CHECK (company_id IN (SELECT user_company_ids()));
-- No UPDATE or DELETE policies on items: rows are immutable snapshots. The
-- only removal path is the batch CASCADE.

CREATE INDEX idx_supplier_payment_batches_company_created
  ON public.supplier_payment_batches (company_id, created_at DESC);
CREATE INDEX idx_supplier_payment_batches_company_status
  ON public.supplier_payment_batches (company_id, status);
CREATE INDEX idx_supplier_payment_batch_items_batch_id
  ON public.supplier_payment_batch_items (batch_id);
CREATE INDEX idx_supplier_payment_batch_items_supplier_invoice_id
  ON public.supplier_payment_batch_items (supplier_invoice_id);
CREATE INDEX idx_supplier_payment_batch_items_company_id
  ON public.supplier_payment_batch_items (company_id);

CREATE TRIGGER set_updated_at_supplier_payment_batches
  BEFORE UPDATE ON public.supplier_payment_batches
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_supplier_payment_batches
  AFTER INSERT OR UPDATE OR DELETE ON public.supplier_payment_batches
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TRIGGER audit_supplier_payment_batch_items
  AFTER INSERT OR UPDATE OR DELETE ON public.supplier_payment_batch_items
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

NOTIFY pgrst, 'reload schema';
