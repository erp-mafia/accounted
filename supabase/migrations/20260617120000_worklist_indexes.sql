-- Worklist (Att göra) badge counts run on every dashboard render via the
-- layout, so the two hottest predicates get purpose-built indexes:
--
-- 1. Unbooked bank transactions (lib/worklist countUnbookedTransactions):
--    company_id WHERE is_business IS NULL AND is_ignored = false. The
--    existing idx_transactions_company_id scans every row of the company;
--    this partial index holds only the (small, shrinking) inbox set.
--
-- 2. invoice_inbox_items is only indexed by user_id (from before the
--    multi-tenant refactor), but every core read — inbox-available, the
--    worklist count — filters by company_id.

CREATE INDEX IF NOT EXISTS idx_transactions_company_unbooked
  ON public.transactions (company_id)
  WHERE is_business IS NULL AND is_ignored = false;

CREATE INDEX IF NOT EXISTS idx_invoice_inbox_items_company_created
  ON public.invoice_inbox_items (company_id, created_at DESC);

NOTIFY pgrst, 'reload schema';
