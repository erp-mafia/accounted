-- Migration: atomic set_cash_account_primary RPC
--
-- Why this exists: lib/cash-accounts/service.ts#setPrimary() previously did two
-- separate UPDATEs (clear old primary, then set new primary). Between the two
-- round-trips no row carries is_primary = true. If skattekonto-booking runs
-- in that window and encounters a rule whose counter_account is '__PRIMARY_SEK__',
-- getPrimary() returns null and the booking either falls back to '1930'
-- (potentially wrong) or fails outright.
--
-- This RPC wraps both updates in a single BEGIN ... COMMIT so the
-- intermediate "no primary" state is invisible to concurrent readers.
-- SECURITY INVOKER so RLS still scopes which rows the caller may touch.
--
-- Compliance: addresses the P1 "Non-atomic setPrimary" review finding.

CREATE OR REPLACE FUNCTION public.set_cash_account_primary(
  p_company_id uuid,
  p_cash_account_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  -- Guard: refuse to set primary on an account that doesn't exist or that
  -- belongs to a different company. RLS covers the second case but we want a
  -- clean error rather than a no-op silent UPDATE.
  IF NOT EXISTS (
    SELECT 1 FROM public.cash_accounts
    WHERE id = p_cash_account_id AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'cash_account not found for company';
  END IF;

  -- Both updates execute in the same statement-level transaction. The partial
  -- unique index idx_cash_accounts_one_primary_per_company is deferred to
  -- transaction commit only if explicitly deferred; UPDATE order matters and
  -- the index is non-deferrable today. Postgres still evaluates uniqueness
  -- at statement boundaries within the function body, so we clear first.
  UPDATE public.cash_accounts
  SET is_primary = false
  WHERE company_id = p_company_id
    AND is_primary = true
    AND id <> p_cash_account_id;

  UPDATE public.cash_accounts
  SET is_primary = true
  WHERE company_id = p_company_id
    AND id = p_cash_account_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_cash_account_primary(uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
