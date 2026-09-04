-- Behandlingshistorik for the per-bankkonto verifikationsserie.
--
-- cash_accounts.voucher_series (20260902121420) takes precedence over the
-- company-wide default_voucher_series_per_source_type map, which is already
-- audited and reported as a behandlingsregel (BFNAR 2013:2 p. 9.16 second
-- paragraph: changes that affect how bokföringsposter are processed, and when
-- they were introduced). The override must leave the same dated trace.
--
-- UPDATE only, and only when the series itself changes: cash_accounts rows are
-- created and touched by bank sync (balances, names, enabled flags) many times
-- a day, and none of that is a behandlingsregel. Same WHEN pattern as the
-- categorization_templates learning filter in 20260901103000.
DROP TRIGGER IF EXISTS audit_cash_accounts_voucher_series ON public.cash_accounts;
CREATE TRIGGER audit_cash_accounts_voucher_series
  AFTER UPDATE ON public.cash_accounts
  FOR EACH ROW
  WHEN (OLD.voucher_series IS DISTINCT FROM NEW.voucher_series)
  EXECUTE FUNCTION public.write_audit_log();
