-- replace_period_opening_balance_link: accept the acting user from the
-- service role, the shape undo_sie_import (20260727121000) and
-- undo_bank_file_import (20260820071500) already use.
--
-- The bug. The owner/admin gate (20260528120500) resolves the caller with
-- auth.uid(). The v1 door (POST /fiscal-periods/{id}/opening-balances/correct)
-- and the MCP staged correct_opening_balances run correctOpeningBalances
-- (src/lib/import/opening-balance/service.ts) on the cookieless service-role
-- client, where auth.uid() is NULL: the gate matched nobody and raised on
-- every call, after the corrected IB was booked and the old one stornoed,
-- and the compensation then stornoed the corrected IB as well. The year was
-- left with no live IB. Only the dashboard (a cookie session) worked.
--
-- The fix: p_user_id names the user the door authenticated and is honored
-- ONLY when the caller holds the service role (auth.uid() NULL there); every
-- other caller is pinned to its own auth.uid() whatever it passes, so a
-- signed-in PostgREST caller cannot name an owner and walk through the gate.
-- The role required is unchanged: owner or admin of p_company_id, now with
-- the explicit 42501 errcode. The posted-entry check and the two-step around
-- enforce_opening_balance_immutability are byte-for-byte the 20260528120500
-- body.
--
-- The 3-argument signature is dropped first so PostgREST resolves one
-- unambiguous overload (same as 20260624120000 for undo_sie_import). A
-- caller that sends only the three original arguments still matches through
-- the default and resolves the role from its own auth.uid(), as before.
--
-- Privileges: the function had only the Supabase default grants (PUBLIC and
-- anon included). The gate fails closed for anon, but there is no reason to
-- leave the entry point callable: PUBLIC and anon are revoked and the two
-- legitimate callers granted, as for the peers.
--
-- pg-test: tests/pg/replace-period-opening-balance-link-service-actor.pg.test.ts

DROP FUNCTION IF EXISTS public.replace_period_opening_balance_link(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.replace_period_opening_balance_link(
  p_company_id uuid,
  p_period_id uuid,
  p_new_entry_id uuid,
  p_user_id uuid DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid;
  v_caller_role text;
BEGIN
  -- Actor resolution. p_user_id is an assertion by the caller, so it is
  -- honored ONLY for the service role (the cookieless server client, where
  -- auth.uid() is NULL). Any other caller is pinned to its own auth.uid().
  -- Same guard as undo_bank_file_import (20260820071500).
  IF auth.role() = 'service_role' THEN
    v_actor := COALESCE(p_user_id, auth.uid());
  ELSE
    v_actor := auth.uid();
  END IF;

  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = v_actor;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Insufficient role to relink opening balance'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM journal_entries
  WHERE id = p_new_entry_id
    AND company_id = p_company_id
    AND fiscal_period_id = p_period_id
    AND status = 'posted';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'New opening balance entry % is not a posted entry in period %', p_new_entry_id, p_period_id;
  END IF;

  UPDATE fiscal_periods
  SET opening_balances_set = false
  WHERE id = p_period_id
    AND company_id = p_company_id;

  UPDATE fiscal_periods
  SET opening_balance_entry_id = p_new_entry_id,
      opening_balances_set     = true
  WHERE id = p_period_id
    AND company_id = p_company_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.replace_period_opening_balance_link(uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_period_opening_balance_link(uuid, uuid, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.replace_period_opening_balance_link(uuid, uuid, uuid, uuid) IS
  'Repoints fiscal_periods.opening_balance_entry_id to a posted IB verifikat of the same company and year (the storno-based IB correction). Requires the actor to be an owner or admin of p_company_id; p_user_id is honored only for service_role callers, every other caller resolves from its own auth.uid(). Raises 42501 otherwise. Not callable by anon.';

NOTIFY pgrst, 'reload schema';
