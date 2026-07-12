-- Clarify scope after a real misbooking (see PR #985 / DECISIONS.md
-- 2026-07-11): this column only seeds the manual mark-paid "betald med
-- privata medel" dialog's default account picker. It must NEVER be read to
-- resolve the settlement account for a real matched bank transaction: that
-- comes from transactions.cash_account_id -> cash_accounts.ledger_account
-- (see lib/bookkeeping/settlement-account.ts). Reusing this sticky,
-- company-wide value for a real payment previously misbooked a genuine bank
-- payment to 2893 (skuld till aktieägare) once an unrelated private-funds
-- payment had set it.
COMMENT ON COLUMN company_settings.last_supplier_payment_account IS
  'Default account seed for the manual mark-paid "betald med privata medel" picker only. Never read to resolve the settlement account for a matched bank transaction (use cash_accounts.ledger_account via cash_account_id instead).';

NOTIFY pgrst, 'reload schema';
