-- Structured transaction-method metadata on bank/feed transactions.
--
-- Until now the payment channel lived only inside the description string
-- ("Vercel Jul Överföring via internet", "ANTHROPIC* CLAUDE SUB SAN FRANCISCO
-- Kortköp/uttag"): the PSD2 remittance array is joined into one string at
-- conversion, and the ISO 20022 transaction-type codes Enable Banking sends
-- (bank_transaction_code / proprietary_bank_transaction_code) were mapped in
-- TS and dropped at INSERT (dev_docs/data_quality_master.md, Appendix B,
-- "Layer-A capture"). This migration promotes the channel to queryable columns
-- so downstream logic can branch on it (a card purchase implies a physical
-- receipt exists; an e-invoice or Bankgiro payment implies a supplier invoice)
-- and the UI can show a clean title with the method as structured detail.
--
-- transaction_method is a closed vocabulary describing HOW the money moved
-- (the payment rail), not what it was for. NULL = not classifiable from the
-- source data. The raw code columns preserve the provider evidence verbatim
-- so classification can be re-derived or refined later without re-fetching.

-- ===== 1. Columns =====

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS transaction_method text NULL,
  ADD COLUMN IF NOT EXISTS bank_transaction_code text NULL,
  ADD COLUMN IF NOT EXISTS proprietary_bank_transaction_code text NULL;

-- ===== 2. Closed vocabulary =====

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_transaction_method_check;
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_transaction_method_check
  CHECK (transaction_method IS NULL OR transaction_method IN (
    'card',
    'transfer',
    'bankgiro',
    'plusgiro',
    'swish',
    'autogiro',
    'e_invoice',
    'international',
    'deposit',
    'withdrawal',
    'salary',
    'fee',
    'interest',
    'adjustment'
  ));

-- ===== 3. Column documentation =====

COMMENT ON COLUMN public.transactions.transaction_method IS
  'Payment rail the transaction moved on (card, transfer, bankgiro, swish, ...). Classified at ingest from the source''s structured type codes, the Swedish channel phrase in the bank description, or the MCC; NULL when unclassifiable. Mirrored by the TransactionMethod union in types/index.ts and classifyTransactionMethod() in lib/transactions/transaction-method.ts.';
COMMENT ON COLUMN public.transactions.bank_transaction_code IS
  'ISO 20022 bank transaction code from PSD2 (e.g. PMNT-CCRD-POSD), verbatim from Enable Banking. Evidence for transaction_method; previously dropped at insert.';
COMMENT ON COLUMN public.transactions.proprietary_bank_transaction_code IS
  'ASPSP-proprietary transaction code from PSD2, verbatim. Evidence for transaction_method; format varies per bank.';

-- ===== 4. Reload PostgREST schema cache =====

NOTIFY pgrst, 'reload schema';
