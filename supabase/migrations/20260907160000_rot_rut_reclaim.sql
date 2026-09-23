-- ROT/RUT: Skatteverkets avslag becomes a fordran on the customer.
--
-- Under fakturamodellen the deduction is booked as a fordran on Skatteverket
-- (1513) when the invoice is issued. When Skatteverket refuses an ärende (in
-- full or in part) that fordran is not gone: the buyer owes the refused share
-- (HUSFL 2009:194; swedish-invoice-compliance section 8: "SKV denies: Debit
-- 1510, Credit 1513, re-invoice customer"). Until now the request was only
-- marked rejected/partially_paid and the refused kronor stayed on 1513 forever
-- while the invoice read as paid.
--
-- This migration adds the state for the reclaim voucher that moves the refused
-- share back onto the customer and reopens the invoice:
--
--   invoices.deduction_reclaimed_total       what Skatteverket refused and the
--                                            customer must now pay (invoice
--                                            currency, always SEK for ROT/RUT)
--   rot_rut_payout_requests.reclaim_journal_entry_id / reclaimed_at
--                                            the voucher (one per begäran)
--   rot_rut_payout_request_items.reclaimed_amount
--                                            per-invoice refused share
--   journal_entries.source_type 'rot_rut_reclaim'
--
-- The invoice document itself stays as issued: deduction_total keeps the
-- deduction the customer was granted on paper, and the customer share is
-- total - deduction_total + deduction_reclaimed_total (lib/invoices/
-- customer-share.ts; the INSERT guard below is its SQL twin and gains the
-- same term so the two definitions cannot drift).

-- 1. invoices.deduction_reclaimed_total -------------------------------------

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS deduction_reclaimed_total NUMERIC(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.invoices.deduction_reclaimed_total IS
  'ROT/RUT share Skatteverket refused and moved back onto the customer (debit 1510 / credit 1513, source_type rot_rut_reclaim). Customer share = total - deduction_total + deduction_reclaimed_total.';

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_deduction_reclaimed_total_check;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_deduction_reclaimed_total_check
  CHECK (
    deduction_reclaimed_total >= 0
    AND deduction_reclaimed_total <= COALESCE(deduction_total, 0)
  ) NOT VALID;
ALTER TABLE public.invoices
  VALIDATE CONSTRAINT invoices_deduction_reclaimed_total_check;

-- The INSERT guard from 20260817191708 is the SQL twin of
-- invoiceCustomerShare(): same formula, now with the reclaimed term.
CREATE OR REPLACE FUNCTION public.invoices_derive_remaining_amount()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(NEW.remaining_amount, 0) = 0
     AND NEW.credited_invoice_id IS NULL
     AND COALESCE(NEW.document_type, 'invoice') = 'invoice'
     AND COALESCE(NEW.total, 0) > 0
     AND COALESCE(NEW.status, 'draft') NOT IN ('paid', 'cancelled', 'credited')
  THEN
    NEW.remaining_amount := GREATEST(
      0,
      ROUND((
        NEW.total
        - COALESCE(NEW.paid_amount, 0)
        - COALESCE(NEW.deduction_total, 0)
        + COALESCE(NEW.deduction_reclaimed_total, 0)
      )::numeric, 2)
    );
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.invoices_derive_remaining_amount() IS
  'BEFORE INSERT guard: an unpaid real invoice inserted with remaining_amount NULL/0 gets total - paid_amount - deduction_total + deduction_reclaimed_total, so the NOT NULL DEFAULT 0 can never read as "settled".';

-- 2. Request + item reclaim state -------------------------------------------

ALTER TABLE public.rot_rut_payout_requests
  ADD COLUMN IF NOT EXISTS reclaim_journal_entry_id uuid NULL
    REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reclaimed_at timestamptz NULL;

COMMENT ON COLUMN public.rot_rut_payout_requests.reclaim_journal_entry_id IS
  'Voucher that moved the refused share of this begäran from 1513 back onto the customers (1510). One per begäran; NULL until booked.';

ALTER TABLE public.rot_rut_payout_request_items
  ADD COLUMN IF NOT EXISTS reclaimed_amount NUMERIC(12,2) NULL
    CHECK (reclaimed_amount >= 0);

COMMENT ON COLUMN public.rot_rut_payout_request_items.reclaimed_amount IS
  'The refused share (requested_amount - decided_amount) booked back onto this invoice by the reclaim voucher.';

-- 3. journal_entries.source_type: add 'rot_rut_reclaim' ---------------------
-- Same expansion pattern as 20260904170000: full list preserved, new value
-- appended. TS (JournalEntrySourceType) and Zod (JournalEntrySourceTypeSchema)
-- gain the value in the same change.

ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_check;

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN (
    'manual', 'bank_transaction', 'invoice_created',
    'invoice_paid', 'invoice_cash_payment', 'credit_note', 'salary_payment',
    'opening_balance', 'year_end',
    'storno', 'correction', 'import', 'system',
    'inbox_item',
    'supplier_invoice_registered', 'supplier_invoice_paid',
    'supplier_invoice_cash_payment', 'supplier_credit_note',
    'currency_revaluation',
    'supplier_invoice_privately_paid',
    'reminder_fee',
    'accrual',
    'result_appropriation',
    'rot_rut_payout',
    'vat_settlement',
    'stripe_payout',
    'webshop_order',
    'expense_claim',
    'expense_payout',
    'rot_rut_reclaim'
  )) NOT VALID;

ALTER TABLE public.journal_entries
  VALIDATE CONSTRAINT journal_entries_source_type_check;

-- 4. One live reclaim voucher per begäran -----------------------------------
-- Same race guard as journal_entries_rot_rut_payout_live_unique
-- (20260904021000): two concurrent reclaims must not both debit 1510 for the
-- same refused share. draft included so the loser fails at the draft insert.
-- pg-test: tests/pg/rot-rut-reclaim.pg.test.ts

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_rot_rut_reclaim_live_unique
  ON public.journal_entries (company_id, source_id)
  WHERE source_type = 'rot_rut_reclaim'
    AND source_id IS NOT NULL
    AND status IN ('draft', 'posted');

NOTIFY pgrst, 'reload schema';
