-- Phase 1A — Foundation for multi-tx ↔ multi-voucher matching.
--
-- This migration scaffolds three pieces of schema that later phases (the
-- match_batch_allocate and bulk_book_transactions RPCs, the new transactions
-- inbox UI) build on. No RPC is added here — RPCs land in a follow-up
-- migration to keep review small.
--
-- 1. transaction_voucher_links
--    Junction table for N-tx → 1-JE flows (samlingsverifikation, bulk-book,
--    "link N bank lines to an existing day-summary verifikat"). The 1:1
--    case continues to use transactions.journal_entry_id; this junction is
--    additive. Sum(allocated_amount) per JE must match the JE's net 19xx
--    side within rounding tolerance — enforced by RPC business logic, not
--    a DB constraint (a partial allocation is legitimate before the second
--    bank line lands).
--
-- 2. block_contradictory_invoice_denorm trigger
--    transactions.invoice_id / supplier_invoice_id are denormalized pointers
--    that only carry meaning for the 1:1 case. After multi-match,
--    invoice_payments / supplier_invoice_payments are the source of truth.
--    This trigger refuses to set the denorm column to an invoice id that
--    already conflicts with a payment row, preventing the table from
--    silently lying after a multi-match.
--
-- 3. is_transaction_booked(uuid) SQL helper
--    Single source of truth for "is this tx anchored to a verifikat?". A tx
--    is booked when (a) transactions.journal_entry_id is set, or (b) any
--    invoice_payments row references it, or (c) any
--    supplier_invoice_payments row references it, or (d) any
--    transaction_voucher_links row references it. Used by inbox filters
--    and MCP list_uncategorized_transactions so the predicate stays
--    consistent across surfaces.

-- ─────────────────────────────────────────────────────────────────
-- 1. transaction_voucher_links: N-tx → 1-JE junction
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.transaction_voucher_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES public.companies ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES public.transactions ON DELETE CASCADE,
  -- ON DELETE CASCADE so delete_last_voucher (which permits removing the last
  -- draft / final voucher in a series, see 20260509103736 + 20260528120000)
  -- transparently strips the link rows. The txs themselves remain but become
  -- "unbooked" via is_transaction_booked() and re-surface in the inbox for
  -- re-booking — the desired behaviour after voucher deletion.
  journal_entry_id UUID NOT NULL REFERENCES public.journal_entries ON DELETE CASCADE,
  -- Signed amount in the transaction's own currency. Positive when the tx
  -- credits the JE's 19xx side (deposit), negative for debits (payment).
  -- Sum across all rows pointing at a given JE must equal the JE's net 19xx
  -- side within rounding tolerance — enforced by RPC business logic.
  allocated_amount NUMERIC(15,2) NOT NULL,
  -- bank_line  = ordinary settlement leg (default)
  -- clearing   = clearing-account leg (e.g. card/Swish day-summary clearing)
  -- other      = future use
  role TEXT NOT NULL DEFAULT 'bank_line',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT transaction_voucher_links_role_check
    CHECK (role IN ('bank_line', 'clearing', 'other')),
  CONSTRAINT transaction_voucher_links_tx_je_unique
    UNIQUE (transaction_id, journal_entry_id)
);

CREATE INDEX IF NOT EXISTS idx_transaction_voucher_links_company_id
  ON public.transaction_voucher_links (company_id);
CREATE INDEX IF NOT EXISTS idx_transaction_voucher_links_transaction_id
  ON public.transaction_voucher_links (transaction_id);
CREATE INDEX IF NOT EXISTS idx_transaction_voucher_links_journal_entry_id
  ON public.transaction_voucher_links (journal_entry_id);

ALTER TABLE public.transaction_voucher_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "transaction_voucher_links_select" ON public.transaction_voucher_links
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "transaction_voucher_links_insert" ON public.transaction_voucher_links
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "transaction_voucher_links_update" ON public.transaction_voucher_links
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "transaction_voucher_links_delete" ON public.transaction_voucher_links
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER transaction_voucher_links_updated_at
  BEFORE UPDATE ON public.transaction_voucher_links
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.transaction_voucher_links IS
  'N-tx → 1-JE junction. Use when one verifikat aggregates multiple bank lines (samlingsverifikation, bulk-book). The 1:1 case continues to use transactions.journal_entry_id; this junction is additive. is_transaction_booked() consults both.';

-- ─────────────────────────────────────────────────────────────────
-- 2. block_contradictory_invoice_denorm
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.block_contradictory_invoice_denorm()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  conflicting_invoice_id UUID;
  conflicting_supplier_invoice_id UUID;
BEGIN
  -- transactions.invoice_id must not contradict the invoice_payments table.
  IF NEW.invoice_id IS NOT NULL THEN
    SELECT ip.invoice_id INTO conflicting_invoice_id
    FROM public.invoice_payments ip
    WHERE ip.transaction_id = NEW.id
      AND ip.invoice_id <> NEW.invoice_id
    LIMIT 1;
    IF conflicting_invoice_id IS NOT NULL THEN
      RAISE EXCEPTION
        'transactions.invoice_id=% contradicts invoice_payments(invoice_id=%) for tx %',
        NEW.invoice_id, conflicting_invoice_id, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Same for supplier_invoice_id.
  IF NEW.supplier_invoice_id IS NOT NULL THEN
    SELECT sip.supplier_invoice_id INTO conflicting_supplier_invoice_id
    FROM public.supplier_invoice_payments sip
    WHERE sip.transaction_id = NEW.id
      AND sip.supplier_invoice_id <> NEW.supplier_invoice_id
    LIMIT 1;
    IF conflicting_supplier_invoice_id IS NOT NULL THEN
      RAISE EXCEPTION
        'transactions.supplier_invoice_id=% contradicts supplier_invoice_payments(supplier_invoice_id=%) for tx %',
        NEW.supplier_invoice_id, conflicting_supplier_invoice_id, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- BEFORE INSERT OR UPDATE so an INSERT carrying both invoice_id and a pre-
-- existing payment row (unusual but possible via direct DB insert) also gets
-- caught. The UPDATE path is the common one (the match endpoints set
-- invoice_id after inserting the payment row).
CREATE TRIGGER trg_block_contradictory_invoice_denorm
  BEFORE INSERT OR UPDATE OF invoice_id, supplier_invoice_id
  ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.block_contradictory_invoice_denorm();

COMMENT ON COLUMN public.transactions.invoice_id IS
  'Denormalized link for the 1:1 tx → invoice case. NULL when the tx settles multiple invoices (truth lives in invoice_payments). Guarded by trg_block_contradictory_invoice_denorm.';
COMMENT ON COLUMN public.transactions.supplier_invoice_id IS
  'Denormalized link for the 1:1 tx → supplier_invoice case. NULL when the tx settles multiple supplier invoices (truth lives in supplier_invoice_payments). Guarded by trg_block_contradictory_invoice_denorm.';

-- ─────────────────────────────────────────────────────────────────
-- 3. is_transaction_booked(uuid)
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_transaction_booked(p_transaction_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM public.transactions t
      WHERE t.id = p_transaction_id
        AND t.journal_entry_id IS NOT NULL
    )
    OR EXISTS (
      SELECT 1 FROM public.invoice_payments ip
      WHERE ip.transaction_id = p_transaction_id
    )
    OR EXISTS (
      SELECT 1 FROM public.supplier_invoice_payments sip
      WHERE sip.transaction_id = p_transaction_id
    )
    OR EXISTS (
      SELECT 1 FROM public.transaction_voucher_links tvl
      WHERE tvl.transaction_id = p_transaction_id
    );
$$;

COMMENT ON FUNCTION public.is_transaction_booked(UUID) IS
  'Returns true if the transaction is anchored to ANY verifikat — directly via journal_entry_id, indirectly via a payment row, or via the transaction_voucher_links junction. Single source of truth for "is this booked?" used by inbox filters, reconciliation status, and MCP list_uncategorized_transactions.';

NOTIFY pgrst, 'reload schema';
