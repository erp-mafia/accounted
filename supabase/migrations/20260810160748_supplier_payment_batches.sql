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
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Composite-FK target so items can enforce company agreement with their
  -- batch. Trivially unique (id is the PK).
  CONSTRAINT uq_supplier_payment_batches_id_company UNIQUE (id, company_id)
);

-- Composite-FK target on the invoice side, same reasoning as above.
CREATE UNIQUE INDEX uq_supplier_invoices_id_company
  ON public.supplier_invoices (id, company_id);

CREATE TABLE public.supplier_payment_batch_items (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  batch_id            uuid NOT NULL,
  company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- RESTRICT: a batch item documents a payment instruction possibly already
  -- handed to a bank; the invoice behind it must not vanish. The supplier
  -- invoice DELETE route pre-checks and returns a friendly error.
  supplier_invoice_id uuid NOT NULL,
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
  -- Composite FKs: company_id must agree with BOTH parents, so a user who
  -- belongs to two companies can never cross-link a batch in one company to
  -- an invoice in another (plain per-column FKs would allow it).
  CONSTRAINT fk_supplier_payment_batch_items_batch
    FOREIGN KEY (batch_id, company_id)
    REFERENCES public.supplier_payment_batches (id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_supplier_payment_batch_items_invoice
    FOREIGN KEY (supplier_invoice_id, company_id)
    REFERENCES public.supplier_invoices (id, company_id) ON DELETE RESTRICT,
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

-- The RLS UPDATE policy cannot compare OLD and NEW, so column-level
-- immutability is a trigger: a batch is a snapshot a bank file regenerates
-- from, and rewriting msg_id/amounts/debtor after creation would break the
-- byte-identical re-download contract. Only lifecycle (created -> cancelled,
-- with its who/when) and download metadata may change.
CREATE OR REPLACE FUNCTION public.enforce_supplier_payment_batch_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.format IS DISTINCT FROM OLD.format
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
     OR NEW.item_count IS DISTINCT FROM OLD.item_count
     OR NEW.msg_id IS DISTINCT FROM OLD.msg_id
     OR NEW.debtor_snapshot IS DISTINCT FROM OLD.debtor_snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'supplier_payment_batches are immutable snapshots: only lifecycle and download metadata may change';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'created' AND NEW.status = 'cancelled') THEN
    RAISE EXCEPTION 'supplier_payment_batches: the only status transition is created -> cancelled';
  END IF;
  -- Cancellation metadata is audit data: it may only be written as part of
  -- the created -> cancelled transition. Exception: cancelled_by may become
  -- NULL at any time, because the FK's ON DELETE SET NULL fires this same
  -- trigger when the cancelling user's account is deleted.
  IF NOT (OLD.status = 'created' AND NEW.status = 'cancelled') THEN
    IF NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at THEN
      RAISE EXCEPTION 'supplier_payment_batches: cancelled_at may only be set by the created -> cancelled transition';
    END IF;
    IF NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by AND NEW.cancelled_by IS NOT NULL THEN
      RAISE EXCEPTION 'supplier_payment_batches: cancelled_by may only be set by the created -> cancelled transition';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_supplier_payment_batch_immutability
  BEFORE UPDATE ON public.supplier_payment_batches
  FOR EACH ROW EXECUTE FUNCTION public.enforce_supplier_payment_batch_immutability();

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
