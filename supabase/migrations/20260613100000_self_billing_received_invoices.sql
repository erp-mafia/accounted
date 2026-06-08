-- Self-billing received (mottagna självfakturor) — ML 17 kap 15§
--
-- A self-billing invoice we RECEIVE is a SALE for us (we are the seller); our
-- customer issues the invoice document on our behalf. For our books it is an
-- ordinary customer invoice: it books revenue + OUTPUT VAT and we remain
-- responsible for reporting that VAT. We model it as a flag on `invoices` so we
-- reuse the whole customer-invoice stack (booking, AR ledger, VAT declaration,
-- payment matching) instead of duplicating it on the supplier side (which would
-- book the VAT on the wrong side entirely).
--
-- Two things must differ from a normal customer invoice:
--   1. The invoice number belongs to the CUSTOMER's series, not ours. We must
--      not consume our own löpnummerserie (BFL 5 kap 6§). The counterparty's
--      number lives in external_invoice_number; invoice_number stays NULL.
--   2. There is no send step — the document is received, so it is booked on
--      registration.
--
-- Idempotent (IF NOT EXISTS / DROP-then-ADD) so it is safe to apply to a
-- preview/staging branch ahead of the repo sync without colliding.

-- 1. Self-billing metadata --------------------------------------------------
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS is_self_billed             boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS external_invoice_number    text,
  ADD COLUMN IF NOT EXISTS self_billing_agreement_ref text,
  ADD COLUMN IF NOT EXISTS received_date              date;

COMMENT ON COLUMN public.invoices.is_self_billed IS
  'True when this row is a self-billing invoice we received (ML 17 kap 15§). The counterparty issued it; for us it is a sale booked with output VAT.';
COMMENT ON COLUMN public.invoices.external_invoice_number IS
  'The invoice number assigned by the customer (issuer) on a received self-billing invoice. Our own invoice_number stays NULL so we never touch our löpnummerserie.';
COMMENT ON COLUMN public.invoices.self_billing_agreement_ref IS
  'Reference to the self-billing agreement (avtal i förväg) required by ML 17 kap 15§ p.1.';

-- 2. journal_entry_id -------------------------------------------------------
-- Referenced by the send / mark-sent / mark-paid routes
-- (invoices.update({ journal_entry_id }) and mark-paid's "already booked"
-- detection) but never created by any migration, so those writes silently
-- no-op on every database. Adding it here (IF NOT EXISTS — no-op where it was
-- patched in by hand) makes the linkage real, and lets mark-paid recognise an
-- already-booked self-billing sale and clear 1510 instead of re-recognising
-- revenue (which would double-count under kontantmetoden).
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS journal_entry_id uuid
    REFERENCES public.journal_entries(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_journal_entry_id
  ON public.invoices (journal_entry_id) WHERE journal_entry_id IS NOT NULL;

-- 3. Numbering integrity ----------------------------------------------------
-- A self-billed row carries the counterparty's number in external_invoice_number
-- and never one from our own series in invoice_number.
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_self_billed_numbering;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_self_billed_numbering CHECK (
    NOT is_self_billed
    OR (external_invoice_number IS NOT NULL AND invoice_number IS NULL)
  );

-- 4. Loosen the sent-requires-number rule -----------------------------------
-- 20260427150000 added: status IN ('draft','cancelled') OR invoice_number IS NOT NULL.
-- A received self-billing invoice is 'sent' (booked, awaiting/with payment) yet
-- legitimately has a NULL own number — its löpnummer is the customer's
-- external_invoice_number, guaranteed present by invoices_self_billed_numbering.
-- This preserves the ML 17 kap 24§ intent (every non-draft invoice carries a
-- number, ours or the counterparty's).
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_sent_requires_number;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_sent_requires_number CHECK (
    status IN ('draft', 'cancelled')
    OR invoice_number IS NOT NULL
    OR is_self_billed
  );

-- 5. Reporting / list filter ------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_invoices_self_billed
  ON public.invoices (company_id, is_self_billed) WHERE is_self_billed;

NOTIFY pgrst, 'reload schema';
