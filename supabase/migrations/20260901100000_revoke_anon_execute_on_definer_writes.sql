-- P0 security fix: SECURITY DEFINER write RPCs were EXECUTE-able by `anon`.
--
-- State before this migration (verified against production 2026-09-01):
--
--   * Supabase's bootstrap runs
--       ALTER DEFAULT PRIVILEGES IN SCHEMA public
--         GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
--     so every function this repo has ever shipped came out of CREATE with
--     proacl {=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X}.
--     The leading `=X/postgres` is the grant to PUBLIC, and anon is a member of
--     PUBLIC: revoking from anon alone leaves has_function_privilege('anon', ...)
--     TRUE. Every REVOKE below therefore names PUBLIC first. Same trap as
--     20260727120000 (replace_sie_import), which is the precedent for this file.
--
--   * PostgREST exposes every public function as POST /rest/v1/rpc/<name>, and
--     the anon key is public by design, so these eight were unauthenticated
--     cross-tenant primitives:
--
--       sync_team_to_company(uuid,uuid)          INSERTs into company_members,
--                                                the table user_company_ids()
--                                                and every RLS policy read. No
--                                                auth check of any kind.
--       claim_due_webhook_deliveries(int,tstz)   RETURNS every tenant's webhook
--                                                payload bodies and flips the
--                                                rows to in_flight. No auth
--                                                check; p_now is caller-supplied
--                                                so backoff does not limit it.
--       generate_delivery_note_number(uuid)      UPDATEs company_settings for an
--                                                arbitrary company. No auth check.
--       generate_article_number(uuid,uuid)       UPDATEs company_settings and
--                                                articles. No auth check.
--       check_and_increment_inbox_quota(uuid,integer,integer)
--                                                INSERTs and UPDATEs
--                                                inbox_rate_counters for an
--                                                arbitrary company. No auth
--                                                check, so any caller can run
--                                                another tenant's minute and
--                                                day intake quota to the cap
--                                                and stall their receipt
--                                                intake until the window
--                                                rolls.
--       generate_invoice_number(uuid,uuid,text)  UPDATEs company_settings and
--                                                invoices (guard bypassed, below).
--       peek_next_invoice_number(uuid,text)      Leaks another tenant's
--                                                invoice_prefix and next number.
--       get_next_arrival_number(uuid)            Leaks another tenant's
--                                                ankomstnummer series.
--
--   * The last three DID carry a guard, and it did not hold:
--
--       IF auth.uid() IS NOT NULL AND NOT EXISTS (membership) THEN RAISE
--
--     auth.uid() resolves the JWT `sub` claim. The anon key's JWT carries no
--     `sub`, so auth.uid() is NULL for role anon and the guard short-circuits
--     straight into the trusted branch. A NULL-trusted guard is safe ONLY once
--     anon has lost EXECUTE: it is the second layer, never the first, and it
--     was never the reason those functions were safe.
--
-- What this migration does:
--
--   1. Revokes EXECUTE from PUBLIC and anon on all eight, plus from
--      authenticated on the two that have no user-session caller.
--   2. Re-grants EXECUTE to authenticated on the six the app genuinely calls
--      on the user's session client (the five numbering RPCs plus the inbox
--      intake limiter), after replacing the NULL-trusted guard with a
--      fail-closed one, or adding one where there was none (see the guard
--      comment in generate_invoice_number below for the exact trust rule).
--   3. Revokes every grant on public.create_invoice_with_items(jsonb,jsonb),
--      a prod-only leftover that no migration in this repo ever created,
--      nothing calls, and that raises 23502 on every call anyway. It is
--      revoked rather than dropped: see section 3.
--   4. Sweeps the rest: every remaining SECURITY DEFINER, non-trigger function
--      in public whose body writes loses EXECUTE from PUBLIC and anon.
--      authenticated and service_role keep the explicit grants they already
--      hold (verified: all 20 anon-callable definer writers carry an explicit
--      `authenticated=X` entry, so revoking PUBLIC takes nothing away from a
--      signed-in caller). The sweep is what stops this class from recurring on
--      the next function that ships, and it is the same predicate
--      tests/pg/definer-function-grants.pg.test.ts asserts on.
--
-- service_role keeps EXECUTE throughout: the API-key, MCP and cron paths run on
-- createServiceClientNoCookies(), and pg_cron runs as postgres.
--
-- Callers verified by grep before revoking (repo at 5f81c0638):
--   * sync_team_to_company: no TypeScript caller at all. The only callers are
--     create_company_with_owner, create_company_for_user and
--     create_company_for_brand_signup, all SECURITY DEFINER owned by postgres,
--     so the nested EXECUTE check passes as the owner. No re-grant.
--   * claim_due_webhook_deliveries: lib/webhooks/dispatcher.ts is the sole
--     caller, reached only from app/api/webhooks/dispatch/cron/route.ts and
--     lib/webhooks/dispatch-kick.ts, both on createServiceClientNoCookies().
--     No re-grant.
--   * generate_invoice_number: lib/invoices/ensure-invoice-number.ts, on the
--     route's session client (app/api/invoices/route.ts and the finalize/send/
--     convert/mark-sent routes). Re-granted.
--   * peek_next_invoice_number: app/api/invoices/next-number/route.ts, session
--     client. Re-granted.
--   * get_next_arrival_number: app/api/supplier-invoices/route.ts, the credit
--     routes, lib/pending-operations/commit.ts and the invoice-inbox extension;
--     session client on the app routes, service client on the /api/v1 and MCP
--     paths. Re-granted.
--   * generate_delivery_note_number: app/api/invoices/route.ts (session client)
--     and app/api/v1/companies/[companyId]/invoices/route.ts (service client).
--     Re-granted.
--   * generate_article_number: lib/articles/ensure-article-number.ts, from
--     app/api/articles/route.ts, app/api/import/articles/execute/route.ts and
--     lib/pending-operations/commit.ts. Re-granted.
--   * check_and_increment_inbox_quota: lib/rate-limits/inbox.ts, called from
--     extensions/general/invoice-inbox/index.ts on the user's session client
--     (ctx.supabase) at /upload, /upload/create, /items/:id/extracted-data,
--     /items/:id/retry-extraction, /inbox/domain and /inbox/domain/verify, and
--     on a service-role client at /inbound (createServiceRoleClient built with
--     SUPABASE_SERVICE_ROLE_KEY); whatsapp-inbox's lib/process-inbound.ts
--     forwards the createServiceClientNoCookies() client its webhook-kick and
--     sweep callers create. Both shapes are live, so this one keeps
--     authenticated EXECUTE and gets the in-body guard rather than a blanket
--     revoke. Re-granted. The TypeScript helper fails open on RPC error, so a
--     refusal degrades to "this request was not counted", never a 500 for a
--     real user; the cross-tenant write is what the guard stops.
--
-- Not touched on purpose: public._backfill_remaining_20260817. It is 337 rows
-- of pre-backfill invoice remaining/paid/deduction state, i.e. financial
-- rollback data, already locked down by 20260825170000. Dropping it is a
-- separate founder decision, not part of a security revoke.
--
-- pg-test: tests/pg/definer-function-grants.pg.test.ts

-- ---------------------------------------------------------------------------
-- 1. No user-session caller: revoke outright, service_role only.
-- ---------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION public.sync_team_to_company(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_team_to_company(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.sync_team_to_company(uuid, uuid) IS
  'Copies team_members into company_members for a newly created company. Has no authorization check of its own, so it is callable only from the SECURITY DEFINER company-creation RPCs (which do check) and from service_role. Not callable by anon or authenticated.';

REVOKE EXECUTE ON FUNCTION public.claim_due_webhook_deliveries(integer, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_webhook_deliveries(integer, timestamptz) TO service_role;

COMMENT ON FUNCTION public.claim_due_webhook_deliveries(integer, timestamptz) IS
  'Claims due automation_webhooks deliveries across all tenants for the cron sender (FOR UPDATE SKIP LOCKED). Returns raw payload bodies, so it is service_role only. Not callable by anon or authenticated.';

-- ---------------------------------------------------------------------------
-- 2. The six RPCs the app calls on the user's session client: the five
--    numbering ones and the inbox intake limiter.
--    Fail-closed guard first, then least-privilege grants.
--
--    Bodies below are the production definitions verbatim (pg_get_functiondef,
--    2026-09-01) with the guard block replaced or added. search_path is
--    restated per function because CREATE OR REPLACE drops every setting
--    attached via ALTER FUNCTION ... SET, and peek_next_invoice_number restates
--    STABLE for the same reason.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.generate_invoice_number(
  p_company_id uuid,
  p_invoice_id uuid,
  p_document_type text DEFAULT 'invoice'
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_existing text;
  v_prefix text;
  v_number integer;
  v_final text;
  v_trusted boolean;
BEGIN
  -- Fail-closed authorization gate. A caller is trusted without a membership
  -- row only when it has no auth.uid() AND is one of:
  --   * service_role: the cookieless server client (API-key, MCP, cron routes)
  --     and, in tests, runAsServiceRole().
  --   * a direct database connection that is not PostgREST: psql, pg_cron and
  --     the pg-real harness, all of which could bypass the function anyway.
  -- Everything reaching this function over PostgREST presents a role claim, so
  -- an anon-key caller lands in the membership check with a NULL auth.uid(),
  -- finds no row and is refused. The old shape (`IF auth.uid() IS NOT NULL AND
  -- NOT EXISTS ...`) trusted exactly that caller. This is defense in depth on
  -- top of the REVOKE below, not a replacement for it.
  --
  -- COALESCE, not a bare `auth.role() = 'service_role'`: with no role claim
  -- that comparison is NULL, the OR keeps it NULL, and `IF NOT NULL AND ...`
  -- is not TRUE, so the RAISE would be skipped. The gate has to stay strictly
  -- two-valued or it fails open on the caller it exists to stop.
  v_trusted := auth.uid() IS NULL
    AND (
      COALESCE(auth.role(), '') = 'service_role'
      OR (auth.role() IS NULL AND session_user <> 'authenticator')
    );

  IF NOT v_trusted AND NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = auth.uid() AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  SELECT invoice_number INTO v_existing
  FROM public.invoices
  WHERE id = p_invoice_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found in company %', p_invoice_id, p_company_id;
  END IF;

  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  UPDATE public.company_settings
  SET next_invoice_number = next_invoice_number + 1,
      updated_at = now()
  WHERE company_id = p_company_id
  RETURNING invoice_prefix, next_invoice_number - 1
  INTO v_prefix, v_number;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'Company settings not found for company %', p_company_id;
  END IF;

  v_final := CASE
    WHEN p_document_type = 'proforma' THEN 'PF-'
    ELSE COALESCE(v_prefix, '')
  END || LPAD(v_number::text, GREATEST(3, length(v_number::text)), '0');

  UPDATE public.invoices
  SET invoice_number = v_final
  WHERE id = p_invoice_id AND company_id = p_company_id;

  RETURN v_final;
END;
$function$;

CREATE OR REPLACE FUNCTION public.peek_next_invoice_number(
  p_company_id uuid,
  p_document_type text DEFAULT 'invoice'
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_prefix text;
  v_number integer;
  v_trusted boolean;
BEGIN
  -- Same fail-closed rule as generate_invoice_number; see the comment there.
  v_trusted := auth.uid() IS NULL
    AND (
      COALESCE(auth.role(), '') = 'service_role'
      OR (auth.role() IS NULL AND session_user <> 'authenticator')
    );

  IF NOT v_trusted AND NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = auth.uid() AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  SELECT invoice_prefix, next_invoice_number INTO v_prefix, v_number
  FROM public.company_settings
  WHERE company_id = p_company_id;

  IF v_number IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN CASE
           WHEN p_document_type = 'proforma' THEN 'PF-'
           ELSE COALESCE(v_prefix, '')
         END || LPAD(v_number::text, GREATEST(3, length(v_number::text)), '0');
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_next_arrival_number(p_company_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_floor integer;
  v_next integer;
  v_trusted boolean;
BEGIN
  -- Same fail-closed rule as generate_invoice_number; see the comment there.
  v_trusted := auth.uid() IS NULL
    AND (
      COALESCE(auth.role(), '') = 'service_role'
      OR (auth.role() IS NULL AND session_user <> 'authenticator')
    );

  IF NOT v_trusted AND NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = auth.uid() AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Configured start floor (defaults to 1 for every company; NULL only if the
  -- settings row is missing, in which case COALESCE keeps the old behavior).
  SELECT COALESCE(next_arrival_number, 1) INTO v_floor
  FROM public.company_settings
  WHERE company_id = p_company_id;

  SELECT GREATEST(COALESCE(MAX(arrival_number), 0) + 1, COALESCE(v_floor, 1))
  INTO v_next
  FROM public.supplier_invoices
  WHERE company_id = p_company_id;

  RETURN v_next;
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_delivery_note_number(p_company_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
DECLARE
  v_number INTEGER;
  v_year TEXT;
  v_trusted boolean;
BEGIN
  -- New gate: this function had no authorization check at all, so a caller
  -- holding only the anon key could burn another tenant's delivery-note
  -- series. Same fail-closed rule as generate_invoice_number.
  v_trusted := auth.uid() IS NULL
    AND (
      COALESCE(auth.role(), '') = 'service_role'
      OR (auth.role() IS NULL AND session_user <> 'authenticator')
    );

  IF NOT v_trusted AND NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = auth.uid() AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.company_settings
  SET next_delivery_note_number = next_delivery_note_number + 1,
      updated_at = now()
  WHERE company_id = p_company_id
  RETURNING next_delivery_note_number - 1
  INTO v_number;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'Company settings not found for company %', p_company_id;
  END IF;

  v_year := EXTRACT(YEAR FROM CURRENT_DATE)::TEXT;
  RETURN 'FS-' || v_year || LPAD(v_number::TEXT, 3, '0');
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_article_number(
  p_company_id uuid,
  p_article_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
DECLARE
  v_existing text;
  v_number integer;
  v_final text;
  v_trusted boolean;
BEGIN
  -- New gate: this function had no authorization check at all. Same
  -- fail-closed rule as generate_invoice_number.
  v_trusted := auth.uid() IS NULL
    AND (
      COALESCE(auth.role(), '') = 'service_role'
      OR (auth.role() IS NULL AND session_user <> 'authenticator')
    );

  IF NOT v_trusted AND NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = auth.uid() AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  SELECT article_number INTO v_existing
  FROM public.articles
  WHERE id = p_article_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Article % not found in company %', p_article_id, p_company_id;
  END IF;

  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  UPDATE public.company_settings
  SET next_article_number = next_article_number + 1,
      updated_at = now()
  WHERE company_id = p_company_id
  RETURNING next_article_number - 1
  INTO v_number;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'Company settings not found for company %', p_company_id;
  END IF;

  v_final := v_number::text;

  UPDATE public.articles
  SET article_number = v_final
  WHERE id = p_article_id AND company_id = p_company_id;

  RETURN v_final;
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_and_increment_inbox_quota(
  p_company_id uuid,
  p_minute_max integer,
  p_day_max integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
DECLARE
  v_minute_key   text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI');
  v_day_key      text := to_char(now() AT TIME ZONE 'Europe/Stockholm', 'YYYY-MM-DD');
  v_minute_count integer;
  v_day_count    integer;
  v_trusted      boolean;
BEGIN
  -- New gate: this function had no authorization check at all, and it keeps
  -- authenticated EXECUTE because both a session client and a service client
  -- call it (see the caller list at the top of this file). The REVOKE alone
  -- therefore stops only the anon key: without this guard any signed-in user
  -- could still run any other tenant's intake quota to the cap. Same
  -- fail-closed rule as generate_invoice_number.
  v_trusted := auth.uid() IS NULL
    AND (
      COALESCE(auth.role(), '') = 'service_role'
      OR (auth.role() IS NULL AND session_user <> 'authenticator')
    );

  IF NOT v_trusted AND NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = auth.uid() AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.inbox_rate_counters (company_id, window_kind, window_key, count)
  VALUES (p_company_id, 'minute', v_minute_key, 1)
  ON CONFLICT (company_id, window_kind, window_key)
  DO UPDATE SET count = inbox_rate_counters.count + 1, updated_at = now()
  RETURNING count INTO v_minute_count;

  IF v_minute_count > p_minute_max THEN
    UPDATE public.inbox_rate_counters
      SET count = count - 1
      WHERE company_id = p_company_id
        AND window_kind = 'minute'
        AND window_key = v_minute_key;
    RETURN jsonb_build_object('ok', false, 'scope', 'minute', 'retry_after_sec', 60);
  END IF;

  INSERT INTO public.inbox_rate_counters (company_id, window_kind, window_key, count)
  VALUES (p_company_id, 'day', v_day_key, 1)
  ON CONFLICT (company_id, window_kind, window_key)
  DO UPDATE SET count = inbox_rate_counters.count + 1, updated_at = now()
  RETURNING count INTO v_day_count;

  IF v_day_count > p_day_max THEN
    UPDATE public.inbox_rate_counters
      SET count = count - 1
      WHERE company_id = p_company_id
        AND window_kind = 'day'
        AND window_key = v_day_key;
    UPDATE public.inbox_rate_counters
      SET count = count - 1
      WHERE company_id = p_company_id
        AND window_kind = 'minute'
        AND window_key = v_minute_key;
    RETURN jsonb_build_object('ok', false, 'scope', 'day', 'retry_after_sec', 3600);
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.generate_invoice_number(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_invoice_number(uuid, uuid, text)
  TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.peek_next_invoice_number(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.peek_next_invoice_number(uuid, text)
  TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.get_next_arrival_number(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_next_arrival_number(uuid)
  TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.generate_delivery_note_number(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_delivery_note_number(uuid)
  TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.generate_article_number(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_article_number(uuid, uuid)
  TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.check_and_increment_inbox_quota(uuid, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_and_increment_inbox_quota(uuid, integer, integer)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.generate_invoice_number(uuid, uuid, text) IS
  'Allocates and persists the next invoice number for p_company_id. Requires the caller to be a member of the company; only a service_role or direct database connection with no auth.uid() is trusted without one. Raises 42501 otherwise. Not callable by anon.';

COMMENT ON FUNCTION public.peek_next_invoice_number(uuid, text) IS
  'Previews the next invoice number without consuming it. Requires the caller to be a member of p_company_id; only a service_role or direct database connection with no auth.uid() is trusted without one. Raises 42501 otherwise. Not callable by anon.';

COMMENT ON FUNCTION public.get_next_arrival_number(uuid) IS
  'Returns the next ankomstnummer for p_company_id. Requires the caller to be a member of the company; only a service_role or direct database connection with no auth.uid() is trusted without one. Raises 42501 otherwise. Not callable by anon.';

COMMENT ON FUNCTION public.generate_delivery_note_number(uuid) IS
  'Allocates the next delivery-note number for p_company_id. Requires the caller to be a member of the company; only a service_role or direct database connection with no auth.uid() is trusted without one. Raises 42501 otherwise. Not callable by anon.';

COMMENT ON FUNCTION public.generate_article_number(uuid, uuid) IS
  'Assigns the next article number to p_article_id. Requires the caller to be a member of p_company_id; only a service_role or direct database connection with no auth.uid() is trusted without one. Raises 42501 otherwise. Not callable by anon.';

COMMENT ON FUNCTION public.check_and_increment_inbox_quota(uuid, integer, integer) IS
  'Atomic per-company minute and day quota for document-inbox intake. Requires the caller to be a member of p_company_id; only a service_role or direct database connection with no auth.uid() is trusted without one (the inbound email and WhatsApp paths). Raises 42501 otherwise. Not callable by anon.';

-- ---------------------------------------------------------------------------
-- 3. Lock down public.create_invoice_with_items(jsonb, jsonb): dead on arrival.
--
--    Prod-only leftover. No migration in this repo ever created it (see the
--    note at 20260304191528_set_search_path_on_functions.sql:9), and nothing
--    reaches it: no TypeScript caller, and no other function body, view,
--    policy, column default or pg_depend entry references it (read-only sweep
--    of pg_proc.prosrc, pg_views, pg_policies, information_schema.columns and
--    pg_depend, 2026-09-01). pg_stat_statements has no record of a call since
--    its last reset.
--
--    It is also non-functional, and has been since the multi-tenant refactor:
--    it INSERTs into public.invoices without company_id, which is NOT NULL, so
--    every call raises 23502 before a row is written.
--
--    We REVOKE rather than DROP. The revoke closes the security hole in full
--    (it is the same treatment section 4 gives every other definer writer),
--    and a DROP would be an irreversible schema deletion against production
--    for a function that is already inert. Removing it is cleanup, not
--    security, so it is left as a separate decision. If that decision is
--    taken, the DROP belongs in its own migration where it can be reviewed
--    and reverted on its own terms.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  -- to_regprocedure returns NULL instead of raising when the signature does not
  -- exist, which is the case for any database built from supabase/migrations/
  -- alone: locally and in CI this block is a no-op, and only prod has the
  -- function to lock down.
  IF to_regprocedure('public.create_invoice_with_items(jsonb, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.create_invoice_with_items(jsonb, jsonb)
      FROM PUBLIC, anon, authenticated;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Sweep every other SECURITY DEFINER writer in public.
--
--    These are functions with legitimate authenticated or service_role callers
--    (create_company_with_owner, delete_last_voucher, seed_chart_of_accounts,
--    validate_and_increment_api_key, ...). None of them has an anon-key call
--    path: every call site resolves either the user's session client or
--    createServiceClientNoCookies(). They lose PUBLIC and anon only; the
--    explicit authenticated and service_role grants they already carry are
--    untouched, so no application path changes.
--
--    Done as a loop rather than a hand list because a hand list is exactly how
--    the three guarded numbering RPCs were wrongly declared safe. The predicate
--    is duplicated in tests/pg/definer-function-grants.pg.test.ts, which fails
--    CI when a future migration ships another anon-callable definer writer.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
       AND p.prorettype <> 'trigger'::regtype
       AND (p.prosrc ~* '\minsert\s+into\s'
            OR p.prosrc ~* '\mupdate\s+[a-z_"]'
            OR p.prosrc ~* '\mdelete\s+from\s')
       AND has_function_privilege('anon', p.oid, 'EXECUTE')
     ORDER BY 1
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    RAISE NOTICE 'revoked PUBLIC/anon EXECUTE on %', r.sig;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
