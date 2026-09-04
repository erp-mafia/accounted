-- Migration: rot_rut_payout_transaction_match
-- Adds potential_rot_rut_payout_request_id to transactions: a match SUGGESTION
-- (never a hard link) pointing at the open ROT/RUT begäran whose payout the
-- bank row appears to be. Mirrors potential_supplier_invoice_id
-- (20260225100248). The confirmed link is transactions.journal_entry_id =
-- rot_rut_payout_requests.settlement_journal_entry_id, written by the
-- match-rot-rut-payout route; this column only carries the hint until then.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS potential_rot_rut_payout_request_id UUID
  REFERENCES public.rot_rut_payout_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_potential_rot_rut_payout_request
  ON public.transactions(potential_rot_rut_payout_request_id)
  WHERE potential_rot_rut_payout_request_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
