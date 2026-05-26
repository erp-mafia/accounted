-- Migration: seed default 1930 SEK cash_account for every company
--
-- Why this exists: the cash_accounts backfill in 20260519110000_cash_accounts.sql
-- only seeded rows from existing bank_connections. Companies that haven't
-- connected a bank via PSD2 yet, or that do their books from SIE imports + manual
-- entries only, end up with zero cash_accounts rows. Combined with the
-- ownership check on /api/reconciliation/bank/{run,unmatched-entries,status},
-- that means reconciliation became unreachable for those companies the moment we
-- removed the '1930' bypass.
--
-- Two paths covered:
--   1. Backfill — insert (company_id, '1930', 'SEK', is_primary=true if no other
--      primary exists) for every company missing a 1930 row. Idempotent via
--      the (company_id, ledger_account) unique constraint.
--   2. Forward-fill — extend public.create_company_with_owner() to seed the
--      same default row at company creation. Source 'manual' so it's clear
--      this isn't a PSD2-backed account; the user can re-map or remove it via
--      AccountPicker once a PSD2 connection is established.
--
-- Compliance: removes the last hidden bypass in the reconciliation routes that
-- the PR review (ASVS V8.2.1, ISO 27001:2022 A.8.3, SOC 2 CC6.6) flagged as
-- inconsistent authorization across cash accounts.

-- 1. Backfill: every company without a 1930 row gets one.
INSERT INTO public.cash_accounts (
  company_id, ledger_account, currency, name, enabled, is_primary, source
)
SELECT
  c.id,
  '1930',
  'SEK',
  'Företagskonto (SEK)',
  true,
  -- Only flag as primary if no other primary exists for this company.
  NOT EXISTS (
    SELECT 1 FROM public.cash_accounts ca2
    WHERE ca2.company_id = c.id AND ca2.is_primary = true
  ),
  'manual'
FROM public.companies c
WHERE NOT EXISTS (
  SELECT 1 FROM public.cash_accounts ca
  WHERE ca.company_id = c.id AND ca.ledger_account = '1930'
)
ON CONFLICT (company_id, ledger_account) DO NOTHING;

-- 2. Forward-fill: bake the seed into company creation so the reconciliation
--    ownership check is always satisfiable.
CREATE OR REPLACE FUNCTION public.create_company_with_owner(
  p_name text,
  p_entity_type text,
  p_set_active boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_company_id uuid;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_entity_type NOT IN ('enskild_firma', 'aktiebolag') THEN
    RAISE EXCEPTION 'Invalid entity_type: %', p_entity_type;
  END IF;

  INSERT INTO public.companies (name, entity_type, created_by)
  VALUES (p_name, p_entity_type, v_user_id)
  RETURNING id INTO v_company_id;

  INSERT INTO public.company_members (company_id, user_id, role)
  VALUES (v_company_id, v_user_id, 'owner');

  -- Seed default 1930 SEK cash account so reconciliation routes work before
  -- any PSD2 connection is established. is_primary so the __PRIMARY_SEK__
  -- sentinel in skattekonto-booking resolves on day one.
  INSERT INTO public.cash_accounts (
    company_id, ledger_account, currency, name, enabled, is_primary, source
  )
  VALUES (
    v_company_id, '1930', 'SEK', 'Företagskonto (SEK)', true, true, 'manual'
  )
  ON CONFLICT (company_id, ledger_account) DO NOTHING;

  IF p_set_active THEN
    INSERT INTO public.user_preferences (user_id, active_company_id)
    VALUES (v_user_id, v_company_id)
    ON CONFLICT (user_id)
    DO UPDATE SET active_company_id = EXCLUDED.active_company_id;
  END IF;

  RETURN v_company_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_company_with_owner(text, text, boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';
