-- Behandlingshistorik for cash_accounts.enabled and .is_primary, and an atomic
-- "make primary" for the user action (desk crm#59).
--
-- 1. Why these two columns are logged now
--
-- 20260902124513 audits cash_accounts.voucher_series and says of the rest:
-- "cash_accounts rows are created and touched by bank sync (balances, names,
-- enabled flags) many times a day, and none of that is a behandlingsregel".
-- That file stays as shipped. The position on `enabled` (and on `is_primary`,
-- which it did not mention) changes here, because both decide how LATER
-- transactions are booked without anyone choosing an account:
--
--   - enabled: resolveSettlementAccount() (lib/bookkeeping/settlement-account.ts)
--     books the bank leg of a transaction with no cash_account_id on the
--     company's one ENABLED account in that currency, and on 1930 when there
--     are zero or several. Turning an account off or on moves that leg.
--   - is_primary: the skattekonto __PRIMARY_SEK__ counter account, and the
--     account that owns transactions with no cash_account_id in reconciliation.
--
-- BFNAR 2013:2 p. 9.16 (BFL 5 kap 11 §) asks the behandlingshistorik to show
-- changes to the system that affect processing, behandlingsregler such as
-- automatkonteringar, with dates. A flag that redirects an automatic account
-- choice is that kind of change. Until this PR only the bank picker and system
-- merges wrote the two flags; PATCH /api/cash-accounts/[id] and
-- POST /api/cash-accounts/[id]/primary now let a user change them, so who and
-- when has to be on record.
--
-- The 20260902124513 concern was volume. It does not apply to this trigger:
-- WHEN ... IS DISTINCT FROM fires on a real flip only, never on the balance
-- and name churn of a sync that rewrites the same value.
--
-- 2. Mechanism: the existing one
--
-- Same table (public.audit_log, immutable), same row shape as
-- write_audit_log() (action UPDATE, table_name, record_id, full old/new
-- state), so lib/reports/behandlingshistorik.ts renders it through the
-- cash_accounts branch it already has. One trigger on the columns rather than
-- logging per route: it also covers the PSD2 picker, the twin heal and any
-- later caller.
--
-- It is a function of its own only for the actor. write_audit_log() labels a
-- row actor_type 'user' unless gnubok.actor_type says otherwise, so a
-- service-role write (bank sync, Stripe sync, re-enable on ingest: auth.uid()
-- IS NULL) would be logged as a user with no user id. Here that case is
-- explicit: actor_type 'system', user_id NULL. A user-initiated change carries
-- auth.uid(). An actor type set by the caller (api_key, cron, ...) still wins.
-- Changing write_audit_log()'s default for every audited table was the
-- alternative; out of scope and not needed for this.

CREATE OR REPLACE FUNCTION public.audit_cash_account_routing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  -- Same teardown guard as write_audit_log() (20260807130000).
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    old_state, new_state, description, actor_type, actor_label
  )
  VALUES (
    v_user_id, NEW.company_id, 'UPDATE', TG_TABLE_NAME, NEW.id, v_user_id,
    to_jsonb(OLD), to_jsonb(NEW), 'Updated cash_accounts record',
    COALESCE(
      nullif(current_setting('gnubok.actor_type', true), ''),
      CASE WHEN v_user_id IS NULL THEN 'system' ELSE 'user' END
    ),
    nullif(current_setting('gnubok.actor_label', true), '')
  );
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.audit_cash_account_routing() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS audit_cash_accounts_routing ON public.cash_accounts;
CREATE TRIGGER audit_cash_accounts_routing
  AFTER UPDATE ON public.cash_accounts
  FOR EACH ROW
  WHEN (OLD.enabled IS DISTINCT FROM NEW.enabled OR OLD.is_primary IS DISTINCT FROM NEW.is_primary)
  EXECUTE FUNCTION public.audit_cash_account_routing();

-- 3. make_cash_account_primary: the user action, check and swap in one
--    transaction
--
-- set_cash_account_primary (20260519154800) checks only that the row exists,
-- so the eligibility rule lived in TypeScript and a disable that committed
-- between that read and the swap left a disabled primary for a moment.
--
-- The rule is NOT added to set_cash_account_primary itself: that function is
-- how the PSD2 sync (upsertFromPsd2) and the twin heal carry the flag onto the
-- row a merge keeps, and that row may be disabled or non-SEK (38 primaries in
-- prod on 2026-09-21: 30 disabled, 8 non-SEK, all from the bank side). With
-- the rule inside, those transfers would raise and a company would end up with
-- no primary. It stays byte-identical; "carry the flag" and "choose a primary"
-- are different operations with different rules.
--
-- FOR UPDATE on the target makes it atomic against the toggle: setEnabled()'s
-- UPDATE of the same row waits for this transaction and then re-evaluates its
-- own predicate (is_primary = false), so it no longer matches; a disable that
-- committed first is seen here and refused.
--
-- Owner/admin is checked here as well as in the route, the way
-- cash_accounts_payee_admin_only does it: the function is callable through
-- PostgREST, and the primary decides where automatic bookings land. The
-- service role (auth.uid() IS NULL) passes.
--
-- Mirrored for the UI by primaryIneligibleReason() in
-- lib/cash-accounts/primary.ts; tests/pg/cash-accounts-routing-audit.pg.test.ts
-- holds the two rule sets together.
CREATE OR REPLACE FUNCTION public.make_cash_account_primary(
  p_company_id uuid,
  p_cash_account_id uuid
)
RETURNS public.cash_accounts
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_row public.cash_accounts;
BEGIN
  SELECT * INTO v_row
    FROM public.cash_accounts
   WHERE id = p_cash_account_id AND company_id = p_company_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF auth.uid() IS NOT NULL AND NOT public.user_is_company_admin(p_company_id) THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_PRIMARY_ADMIN_ONLY: only owner or admin may choose the primary bank account'
      USING ERRCODE = '42501';
  END IF;

  -- Order and reason tokens match primaryIneligibleReason().
  IF NOT v_row.enabled THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_PRIMARY_INELIGIBLE: disabled' USING ERRCODE = '23514';
  END IF;
  IF upper(COALESCE(v_row.currency, '')) <> 'SEK' THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_PRIMARY_INELIGIBLE: not_sek' USING ERRCODE = '23514';
  END IF;
  IF v_row.ledger_account !~ '^19[2-9]\d$' THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_PRIMARY_INELIGIBLE: not_bank_account' USING ERRCODE = '23514';
  END IF;

  IF v_row.is_primary THEN
    RETURN v_row;
  END IF;

  -- Clear first: idx_cash_accounts_one_primary_per_company is not deferrable.
  UPDATE public.cash_accounts
     SET is_primary = false
   WHERE company_id = p_company_id AND is_primary AND id <> p_cash_account_id;

  UPDATE public.cash_accounts
     SET is_primary = true
   WHERE id = p_cash_account_id AND company_id = p_company_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.make_cash_account_primary(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.make_cash_account_primary(uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
