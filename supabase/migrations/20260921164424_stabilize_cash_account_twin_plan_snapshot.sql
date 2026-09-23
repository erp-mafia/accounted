-- A review contains both a fingerprint and its proposed groups. All reads
-- must use the same snapshot, even if configuration changes during planning.
-- The volatile executor invokes this only after acquiring its mutation locks.
ALTER FUNCTION public.plan_cash_account_twins(uuid) STABLE;

NOTIFY pgrst, 'reload schema';
