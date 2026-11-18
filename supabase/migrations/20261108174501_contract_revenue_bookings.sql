-- =============================================================================
-- Pågående arbeten (K3 kapitel 23): what each verifikat was computed from, and
-- an adjustment that moves only what the register itself booked.
--
-- pg-test: tests/pg/contract-revenue.pg.test.ts
--
-- WHY
-- ---
-- The register (20261027180109_contract_revenue.sql, behind
-- NEXT_PUBLIC_CONTRACT_REVENUE_ENABLED) booked the
-- difference between its positions and the WHOLE balance of 1620, 2450, 2290,
-- 1471 and 2431. 2290 Övriga avsättningar holds other provisions too, and a
-- company that booked pågående arbeten by hand before has them on 1620/2450:
-- the next booking reversed both. Its uppdrag figures could also be
-- overwritten or deleted after the verifikat posted, so nothing showed what a
-- posted verifikat was computed from (BFL 5 kap. 7 §, 7 kap. 1 §). And the
-- adjustment account stayed pinned by any posted line on it, not only the
-- register's, while no app user could ever release it.
--
-- WHAT CHANGES
-- ------------
-- 1. public.contract_revenue_bookings: one row per posted adjustment, written
--    only by commit_contract_revenue in the voucher's transaction: the method,
--    the accounts, every uppdrag's figures as stated for the balansdag, the
--    positions, the target balances and what the register held before.
--    Immutable; removed only with its verifikat by a destructive path that
--    sets gnubok.allow_delete (tenant teardown, the last-voucher delete).
-- 2. contract_revenue_entry_ids: the register's verifikat (its bookings, their
--    stornos and their rättelse verifikat, transitively);
--    contract_revenue_register_balances: what those hold per account on a
--    day, so the adjustment is the register's target less that and a manual
--    posting or another provision on the same accounts is never moved; and
--    contract_revenue_account_in_use: an account with posted lines outside
--    them.
-- 3. commit_contract_revenue: commits a year_end draft and records the
--    booking in one transaction, for a K3 year only (K3 kapitel 23; the year's
--    framework, fiscal_year_framework), under the saved method and account,
--    and only while the register still holds what the caller computed from:
--    a double click or a concurrent booking is refused, never posted twice.
-- 4. The adjustment account: a settings row names one that carries no posted
--    line outside the register's verifikat; the momskod pin holds on the
--    settings' account and on every account a booking took the adjustment
--    on; the settings row can be changed or deleted by a writing member,
--    which releases an account no booking used.
-- 5. behandlingshistorik_sources reads contract_revenue_settings (the method
--    and the account are behandlingsregler, BFNAR 2013:2 punkt 9.16).
--
-- No posted entry is touched.
-- =============================================================================

-- =============================================================================
-- 1. contract_revenue_bookings
-- =============================================================================

CREATE TABLE public.contract_revenue_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- CASCADE only for the destructive paths (tenant teardown, the last-voucher
  -- delete): a posted verifikat and its year are never deleted otherwise, and
  -- the guard below refuses a direct delete.
  fiscal_period_id uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  journal_entry_id uuid NOT NULL UNIQUE REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  balansdag date NOT NULL,
  method text NOT NULL CHECK (method IN ('successiv', 'fardigstallande')),
  revenue_account text NOT NULL CHECK (revenue_account ~ '^3[0-7][0-9]{2}$'),
  -- The account per role (revenueAdjustment, accruedRevenue, billedInAdvance,
  -- lossExpense, lossProvision, wipCosts, wipCostsChange, wipBilling).
  accounts jsonb NOT NULL CHECK (jsonb_typeof(accounts) = 'object'),
  -- Every uppdrag as stated for the balansdag, and its computed position.
  contracts jsonb NOT NULL CHECK (jsonb_typeof(contracts) = 'array'),
  positions jsonb NOT NULL CHECK (jsonb_typeof(positions) = 'array'),
  -- The register's balance per position account (debit positive) after the
  -- verifikat, and before it: the verifikat books the difference.
  targets jsonb NOT NULL CHECK (jsonb_typeof(targets) = 'object'),
  held_before jsonb NOT NULL CHECK (jsonb_typeof(held_before) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.contract_revenue_bookings IS
  'What a posted pågående-arbeten verifikat (K3 kapitel 23) was computed from: the method, the accounts, each uppdrag as stated for the balansdag, the positions and the target balances. Written only by commit_contract_revenue in the voucher transaction; immutable (BFL 7 kap.).';

CREATE INDEX idx_contract_revenue_bookings_company ON public.contract_revenue_bookings (company_id);
CREATE INDEX idx_contract_revenue_bookings_period ON public.contract_revenue_bookings (fiscal_period_id);

ALTER TABLE public.contract_revenue_bookings ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contract_revenue_bookings TO service_role;
-- Read-only to sessions: commit_contract_revenue (SECURITY DEFINER) is the only writer.
GRANT SELECT ON TABLE public.contract_revenue_bookings TO authenticated;

CREATE POLICY contract_revenue_bookings_select ON public.contract_revenue_bookings
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER contract_revenue_bookings_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.contract_revenue_bookings
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

CREATE FUNCTION public.guard_contract_revenue_bookings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'A contract revenue booking is never updated: reverse its verifikat (storno) and book again'
      USING ERRCODE = '23514';
  END IF;
  -- The destructive paths remove the booking with its verifikat.
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Cannot delete a posted contract revenue booking (id=%)', OLD.id
    USING ERRCODE = '23514',
          HINT = 'Reverse the verifikat (storno). The booking is räkenskapsinformation (BFL 7 kap.).';
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_contract_revenue_bookings() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER guard_contract_revenue_bookings
  BEFORE UPDATE OR DELETE ON public.contract_revenue_bookings
  FOR EACH ROW EXECUTE FUNCTION public.guard_contract_revenue_bookings();

-- =============================================================================
-- 2. The register's verifikat and what they hold
-- =============================================================================

-- The register's verifikat: each booked adjustment, and every storno or
-- rättelse verifikat made of one (reverses_id, correction_of_id),
-- transitively. A storno nets its original out; a rättelse replaces it, so
-- the register counts the corrected lines instead of booking the original
-- amount again. Invoker rights: a session sees its own companies' rows.
CREATE FUNCTION public.contract_revenue_entry_ids(p_company_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  WITH RECURSIVE family(id) AS (
    SELECT b.journal_entry_id
      FROM public.contract_revenue_bookings b
     WHERE b.company_id = p_company_id
    UNION
    SELECT e.id
      FROM public.journal_entries e
      JOIN family f ON e.reverses_id = f.id OR e.correction_of_id = f.id
     WHERE e.company_id = p_company_id
       AND e.status IN ('posted', 'reversed')
  )
  SELECT f.id FROM family f
$function$;

REVOKE ALL ON FUNCTION public.contract_revenue_entry_ids(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contract_revenue_entry_ids(uuid) TO authenticated, service_role;

-- Whether an account carries a posted line outside the register's verifikat:
-- in use for something else, so not one the adjustment may take. The
-- settings trigger refuses such an account and the app asks first, before it
-- pins the account's momssats.
CREATE FUNCTION public.contract_revenue_account_in_use(p_company_id uuid, p_account text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.journal_entry_lines l
      JOIN public.journal_entries e ON e.id = l.journal_entry_id
     WHERE e.company_id = p_company_id
       AND e.status IN ('posted', 'reversed')
       AND l.account_number = p_account
       AND e.id NOT IN (SELECT r.id FROM public.contract_revenue_entry_ids(p_company_id) AS r(id))
  )
$function$;

REVOKE ALL ON FUNCTION public.contract_revenue_account_in_use(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contract_revenue_account_in_use(uuid, text) TO authenticated, service_role;

-- What the register's verifikat hold per account on a day (debit positive).
CREATE FUNCTION public.contract_revenue_register_balances(p_company_id uuid, p_as_of date)
RETURNS TABLE(account_number text, balance numeric)
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT l.account_number::text, sum(l.debit_amount - l.credit_amount)::numeric
    FROM public.journal_entries e
    JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
   WHERE e.id IN (SELECT r.id FROM public.contract_revenue_entry_ids(p_company_id) AS r(id))
     AND e.company_id = p_company_id
     AND e.status IN ('posted', 'reversed')
     AND e.entry_date <= p_as_of
   GROUP BY l.account_number
$function$;

REVOKE ALL ON FUNCTION public.contract_revenue_register_balances(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contract_revenue_register_balances(uuid, date) TO authenticated, service_role;

COMMENT ON FUNCTION public.contract_revenue_register_balances(uuid, date) IS
  'What the pågående-arbeten register''s own verifikat (contract_revenue_entry_ids) hold per account on a day, debit positive: the base the next adjustment is computed from, so balances the register did not book are never moved.';

-- =============================================================================
-- 3. commit_contract_revenue
-- =============================================================================
-- Commits the year's pågående-arbeten adjustment, a year_end draft dated the
-- balansdag built by lib/bokslut/pagaende-arbeten, and records what it was
-- computed from (p_booking: method, accounts, contracts, positions, targets),
-- in one transaction. Refused:
--   * outside a K3 year (K3 kapitel 23 is the rule booked here);
--   * in a closed or locked year, or behind the company lock date;
--   * under a method or account other than the saved settings;
--   * while a later year's booking stands (it was computed on top of this
--     year's balance);
--   * with a line on an account outside p_booking.accounts;
--   * when the register's balance before the draft plus the draft's change
--     differs from the target on any position account: the register changed
--     since the caller computed (a double click, a concurrent booking).

CREATE FUNCTION public.commit_contract_revenue(
  p_company_id uuid,
  p_entry_id uuid,
  p_fiscal_period_id uuid,
  p_booking jsonb,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS TABLE(voucher_number integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_period_end date;
  v_period_closed boolean;
  v_period_locked_at timestamptz;
  v_company_lock_date date;
  v_settings_method text;
  v_settings_account text;
  v_accounts text[];
  v_held jsonb;
  v_voucher_number integer;
BEGIN
  -- Who may post: commit_journal_entry's own rule, asked before any work.
  IF (public.jwt_caller_is_end_user()
      OR current_setting('role', true) IN ('authenticated', 'anon')
      OR auth.uid() IS NOT NULL)
     AND NOT public.caller_can_write_company(p_company_id) THEN
    RAISE EXCEPTION 'unauthorized contract revenue posting for company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  IF p_booking IS NULL
     OR jsonb_typeof(p_booking) <> 'object'
     OR coalesce(p_booking ->> 'method', '') NOT IN ('successiv', 'fardigstallande')
     OR jsonb_typeof(p_booking -> 'accounts') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_booking -> 'contracts') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_booking -> 'positions') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_booking -> 'targets') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid contract revenue booking' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
       SELECT 1 FROM jsonb_each(p_booking -> 'accounts') a
        WHERE jsonb_typeof(a.value) <> 'string' OR (a.value #>> '{}') !~ '^[0-9]{4}$'
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_each(p_booking -> 'targets') t
        WHERE jsonb_typeof(t.value) <> 'number'
     )
     OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_booking -> 'targets'))
     OR coalesce(p_booking -> 'accounts' ->> 'revenueAdjustment', '') = '' THEN
    RAISE EXCEPTION 'Invalid contract revenue booking accounts' USING ERRCODE = '22023';
  END IF;

  v_accounts := ARRAY(SELECT a.value FROM jsonb_each_text(p_booking -> 'accounts') a);

  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_booking -> 'targets') k(account)
     WHERE NOT (k.account = ANY (v_accounts))
  ) THEN
    RAISE EXCEPTION 'A contract revenue target names an account outside the booking''s accounts'
      USING ERRCODE = '22023';
  END IF;

  -- Serialises the company's postings like every other posting.
  PERFORM public.lock_cash_account_company(p_company_id);

  SELECT fp.period_end, fp.is_closed, fp.locked_at
    INTO v_period_end, v_period_closed, v_period_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.id = p_fiscal_period_id
     AND fp.company_id = p_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fiscal period not found: %', p_fiscal_period_id USING ERRCODE = 'P0002';
  END IF;

  IF v_period_closed OR v_period_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot post contract revenue in a locked or closed fiscal period'
      USING ERRCODE = '23514';
  END IF;

  SELECT cs.bookkeeping_locked_through
    INTO v_company_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF v_company_lock_date IS NOT NULL AND v_period_end <= v_company_lock_date THEN
    RAISE EXCEPTION 'Bookkeeping is locked through %', v_company_lock_date
      USING ERRCODE = '23514';
  END IF;

  -- K3 years only: the year decides, not the company's latest framework.
  IF public.fiscal_year_framework(p_company_id, p_fiscal_period_id) IS DISTINCT FROM 'k3' THEN
    RAISE EXCEPTION 'CONTRACT_REVENUE_NOT_K3' USING ERRCODE = 'PT409',
      HINT = 'Pågående arbeten are booked here under K3 kapitel 23, in a fiscal year reported under K3.';
  END IF;

  -- A later year booked from the register stands on this year's balance:
  -- booking this year now would leave that year's positions off by the
  -- change. That later verifikat is reversed (storno) first. Any of the
  -- register's verifikat counts (a booking, or the rättelse verifikat that
  -- replaced one), except a storno, which only nets out what it reverses.
  IF EXISTS (
    SELECT 1
      FROM public.journal_entries je
     WHERE je.id IN (SELECT r.id FROM public.contract_revenue_entry_ids(p_company_id) AS r(id))
       AND je.company_id = p_company_id
       AND je.status = 'posted'
       AND je.reverses_id IS NULL
       AND je.entry_date > v_period_end
  ) THEN
    RAISE EXCEPTION 'CONTRACT_REVENUE_LATER_YEAR_BOOKED' USING ERRCODE = 'PT409',
      HINT = 'A later fiscal year''s pågående arbeten are booked; reverse that verifikat before booking an earlier year.';
  END IF;

  SELECT s.method, s.revenue_account
    INTO v_settings_method, v_settings_account
    FROM public.contract_revenue_settings s
   WHERE s.company_id = p_company_id
   FOR SHARE;

  IF NOT FOUND
     OR v_settings_method IS DISTINCT FROM p_booking ->> 'method'
     OR v_settings_account IS DISTINCT FROM p_booking -> 'accounts' ->> 'revenueAdjustment' THEN
    RAISE EXCEPTION 'CONTRACT_REVENUE_STALE' USING ERRCODE = 'PT409',
      HINT = 'The method or the account changed since the adjustment was computed.';
  END IF;

  PERFORM 1
     FROM public.journal_entries je
    WHERE je.id = p_entry_id
      AND je.company_id = p_company_id
      AND je.fiscal_period_id = p_fiscal_period_id
      AND je.entry_date = v_period_end
      AND je.status = 'draft'
      AND je.source_type = 'year_end'
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Valid contract revenue draft not found: %', p_entry_id USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.journal_entry_lines l
     WHERE l.journal_entry_id = p_entry_id
       AND NOT (l.account_number = ANY (v_accounts))
  ) THEN
    RAISE EXCEPTION 'The contract revenue draft books an account outside the booking''s accounts'
      USING ERRCODE = '23514';
  END IF;

  -- What the register held before this draft, per target account.
  SELECT coalesce(jsonb_object_agg(t.account, coalesce(h.balance, 0)), '{}'::jsonb)
    INTO v_held
    FROM jsonb_object_keys(p_booking -> 'targets') t(account)
    LEFT JOIN public.contract_revenue_register_balances(p_company_id, v_period_end) h
      ON h.account_number = t.account;

  IF EXISTS (
    SELECT 1
      FROM jsonb_each(p_booking -> 'targets') t
     WHERE abs(
             (v_held ->> t.key)::numeric
             + coalesce((
                 SELECT sum(l.debit_amount - l.credit_amount)
                   FROM public.journal_entry_lines l
                  WHERE l.journal_entry_id = p_entry_id
                    AND l.account_number = t.key
               ), 0)
             - (t.value #>> '{}')::numeric
           ) > 0.005
  ) THEN
    RAISE EXCEPTION 'CONTRACT_REVENUE_STALE' USING ERRCODE = 'PT409',
      HINT = 'The register''s verifikat changed since the adjustment was computed.';
  END IF;

  SELECT committed.voucher_number
    INTO v_voucher_number
    FROM public.commit_journal_entry(
      p_company_id,
      p_entry_id,
      'user_accept',
      NULL,
      p_actor_type,
      p_actor_label
    ) AS committed;

  INSERT INTO public.contract_revenue_bookings (
    company_id, fiscal_period_id, journal_entry_id, balansdag, method, revenue_account,
    accounts, contracts, positions, targets, held_before
  ) VALUES (
    p_company_id, p_fiscal_period_id, p_entry_id, v_period_end, v_settings_method, v_settings_account,
    p_booking -> 'accounts', p_booking -> 'contracts', p_booking -> 'positions', p_booking -> 'targets', v_held
  );

  RETURN QUERY SELECT v_voucher_number;
END;
$function$;

REVOKE ALL ON FUNCTION public.commit_contract_revenue(uuid, uuid, uuid, jsonb, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commit_contract_revenue(uuid, uuid, uuid, jsonb, text, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.commit_contract_revenue(uuid, uuid, uuid, jsonb, text, text) IS
  'Atomically posts the year''s pågående-arbeten adjustment (K3 kapitel 23) and records what it was computed from in contract_revenue_bookings. K3 years only; refused when the register changed since the caller computed. Voucher numbering is delegated to commit_journal_entry.';

-- =============================================================================
-- 4. The adjustment account
-- =============================================================================

-- A settings row names an account that is pinned outside the momsdeklaration
-- and that carries no posted line outside the register's verifikat: an
-- account in use for something else would mix the two, and the pin would
-- hold that other use too. Moving the settings is always allowed; an
-- account a booking took the adjustment on stays pinned (below).
CREATE OR REPLACE FUNCTION public.enforce_contract_revenue_account()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts c
    WHERE c.company_id = NEW.company_id
      AND c.account_number = NEW.revenue_account
      AND c.default_vat_treatment IS NULL
      AND c.vat_box IS NULL
      AND c.default_vat_rate = 0
  ) THEN
    RAISE EXCEPTION 'Konto % ska finnas i kontoplanen utan momskod och momsruta och med momssats 0 för att ta upparbetade intäkter', NEW.revenue_account
      USING ERRCODE = 'check_violation';
  END IF;
  -- Only a newly named account: an upsert fires the INSERT trigger on its
  -- proposed row even when it updates, so a re-save of the account the
  -- settings already name (a method change) is not a new choice.
  IF (
       (TG_OP = 'INSERT' AND NOT EXISTS (
          SELECT 1 FROM public.contract_revenue_settings s
          WHERE s.company_id = NEW.company_id
            AND s.revenue_account = NEW.revenue_account))
       OR (TG_OP = 'UPDATE' AND NEW.revenue_account IS DISTINCT FROM OLD.revenue_account)
     )
     AND public.contract_revenue_account_in_use(NEW.company_id, NEW.revenue_account) THEN
    RAISE EXCEPTION 'CONTRACT_REVENUE_ACCOUNT_IN_USE' USING ERRCODE = 'PT409',
      HINT = 'The account carries posted lines outside the pågående-arbeten register; choose an account used only for it.';
  END IF;
  RETURN NEW;
END;
$$;

-- The pin: no momskod, no momsruta and momssats 0 on the settings' account
-- and on every account a posted booking took the adjustment on, so an
-- earlier year's adjustment never reaches a re-run declaration through a
-- later momskod. The position and cost accounts (1620, 2450, 2290, 6330 ...)
-- are no ruta's and stay free to edit. An account no booking used is
-- released when the settings move or are deleted. A save that leaves the
-- momskod, momsruta and momssats as they were is never refused.
CREATE OR REPLACE FUNCTION public.keep_contract_revenue_account_outside_vat()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.default_vat_treatment IS NULL AND NEW.vat_box IS NULL AND NEW.default_vat_rate IS NOT DISTINCT FROM 0 THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.account_number IS NOT DISTINCT FROM OLD.account_number
     AND NEW.default_vat_treatment IS NOT DISTINCT FROM OLD.default_vat_treatment
     AND NEW.vat_box IS NOT DISTINCT FROM OLD.vat_box
     AND NEW.default_vat_rate IS NOT DISTINCT FROM OLD.default_vat_rate THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.contract_revenue_settings s
       WHERE s.company_id = NEW.company_id
         AND s.revenue_account = NEW.account_number
     )
     OR EXISTS (
       SELECT 1 FROM public.contract_revenue_bookings b
       WHERE b.company_id = NEW.company_id
         AND b.revenue_account = NEW.account_number
     ) THEN
    RAISE EXCEPTION 'Konto % tar upparbetade intäkter och står utanför momsdeklarationen: momskod och momsruta ska vara tomma och momssatsen 0', NEW.account_number
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- A writing member may stop using the register: the settings row goes, and
-- with it the pin on an account no booking took the adjustment on.
GRANT DELETE ON TABLE public.contract_revenue_settings TO authenticated;

CREATE POLICY "delete own-company contract_revenue_settings"
  ON public.contract_revenue_settings FOR DELETE USING (
    company_id IN (SELECT user_company_ids()) AND public.caller_can_write_company(company_id)
  );

-- =============================================================================
-- 5. behandlingshistorik_sources: contract_revenue_settings is audited
-- =============================================================================

CREATE OR REPLACE FUNCTION public.behandlingshistorik_sources(
  p_company_id uuid,
  p_period_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_fiscal_year boolean
)
RETURNS TABLE (entries json, audit json, audit_outside json, rattelse json)
LANGUAGE plpgsql
STABLE
SET search_path TO ''
SET plan_cache_mode TO 'force_custom_plan'
AS $$
DECLARE
  v_logged_before boolean := false;
  v_logged_after boolean := false;
  v_audit json;
  v_audit_outside json := '[]';
  v_created_inside uuid[];
  v_reversal_refs text[];
  v_guard_states jsonb[];
  v_rattelse json;
  v_rattelse_refs text[];
  v_entry_refs text[] := '{}';
  v_entries json;
BEGIN
  SELECT coalesce(json_agg(a), '[]'::json),
         array_agg(a.new_state->>'reversed_by_id')
           FILTER (WHERE a.action = 'REVERSE' AND a.table_name = 'journal_entries'),
         array_agg(a.new_state) FILTER (WHERE a.action = 'GUARD_BYPASSED')
    INTO v_audit, v_reversal_refs, v_guard_states
    FROM public.audit_log a
   WHERE a.company_id = p_company_id
     AND a.created_at >= p_from
     AND a.created_at <= p_to
     AND (a.table_name = ANY (ARRAY[
            'journal_entries', 'chart_of_accounts', 'company_settings', 'fiscal_periods',
            'api_keys', 'dimensions', 'dimension_values', 'account_dimension_rules',
            'accrual_schedules', 'document_attachments', 'mapping_rules',
            'categorization_templates', 'booking_template_library', 'sie_imports',
            'sie_import_chunks', 'bank_file_imports', 'cash_accounts',
            'invoice_payee_defaults', 'mail_connections', 'collection_connections',
            'service_accounts', 'company_capability_config', 'company_grants',
            'company_grant_settings', 'company_attest_policies', 'company_attest_limits',
            'booking_review_rules', 'employees', 'skattekonto_transactions',
            'contract_revenue_settings'])
          OR a.action = ANY (ARRAY[
            'SECURITY_EVENT', 'INTEGRITY_FAILURE', 'RETENTION_BLOCK',
            'DOCUMENT_DELETE_BLOCKED', 'GUARD_BYPASSED']))
     AND NOT coalesce(
           (a.table_name = 'journal_entries' AND a.action IN ('INSERT', 'COMMIT'))
           OR (a.table_name = 'journal_entries' AND a.action = 'UPDATE'
               AND coalesce(a.old_state->>'status', '') NOT IN ('posted', 'reversed')
               AND coalesce(a.new_state->>'status', '') NOT IN ('posted', 'reversed'))
           OR (a.table_name = 'document_attachments' AND a.action IN ('INSERT', 'UPDATE')),
           false);

  -- Fiscal-year mode, outside the window: rows about the period's verifikat
  -- (a storno or bokslut after year end), bypassed guards naming one (dated
  -- when overridden, which can be after year end), and the receipts of the
  -- SIE chunks that imported them (an older year can be imported today). The
  -- three can meet on a row, so they are made distinct.
  IF p_fiscal_year THEN
    v_logged_before := EXISTS (
      SELECT 1 FROM public.audit_log b WHERE b.company_id = p_company_id AND b.created_at < p_from);
    v_logged_after := EXISTS (
      SELECT 1 FROM public.audit_log b WHERE b.company_id = p_company_id AND b.created_at > p_to);
    IF v_logged_before THEN
      SELECT array_agg(a.record_id)
        INTO v_created_inside
        FROM public.audit_log a
       WHERE a.company_id = p_company_id
         AND a.created_at >= p_from + interval '1 day'
         AND a.created_at <= p_to
         AND a.table_name = 'journal_entries'
         AND a.action = 'INSERT';
    END IF;

    WITH period_entries AS MATERIALIZED (
      SELECT e.id, e.import_batch_id,
             NOT EXISTS (
               SELECT 1 FROM unnest(coalesce(v_created_inside, '{}'::uuid[])) AS c(id) WHERE c.id = e.id
             ) AS may_predate_window
        FROM public.journal_entries e
       WHERE e.company_id = p_company_id
         AND e.fiscal_period_id = p_period_id
    ),
    outside_window AS (
      SELECT a.*
        FROM period_entries pe
       CROSS JOIN LATERAL (
         SELECT a.*
           FROM public.audit_log a
          WHERE a.table_name = 'journal_entries'
            AND a.record_id = pe.id
            AND a.company_id = p_company_id
            AND (a.created_at < p_from OR a.created_at > p_to)
            AND NOT coalesce(
                  a.action IN ('INSERT', 'COMMIT')
                  OR (a.action = 'UPDATE'
                      AND coalesce(a.old_state->>'status', '') NOT IN ('posted', 'reversed')
                      AND coalesce(a.new_state->>'status', '') NOT IN ('posted', 'reversed')),
                  false)
       ) a
       WHERE v_logged_after OR (v_logged_before AND pe.may_predate_window)
      UNION ALL
      SELECT a.*
        FROM public.audit_log a
       WHERE a.company_id = p_company_id
         AND a.action = 'GUARD_BYPASSED'
         AND (a.created_at < p_from OR a.created_at > p_to)
         AND a.new_state->>'journal_entry_id' IN (SELECT pe.id::text FROM period_entries pe)
      UNION ALL
      SELECT a.*
        FROM public.audit_log a
       WHERE a.company_id = p_company_id
         AND a.table_name = 'sie_import_chunks'
         AND (a.created_at < p_from OR a.created_at > p_to)
         AND a.new_state->>'import_id' IN (
               SELECT pe.import_batch_id::text FROM period_entries pe WHERE pe.import_batch_id IS NOT NULL)
    )
    SELECT coalesce(json_agg(o), '[]'::json)
      INTO v_audit_outside
      FROM (SELECT DISTINCT ON (w.id) w.* FROM outside_window w ORDER BY w.id) o;
  END IF;

  SELECT coalesce(json_agg(r), '[]'::json), array_agg(r.journal_entry_id::text)
    INTO v_rattelse, v_rattelse_refs
    FROM public.journal_entry_rattelse_log r
   WHERE r.company_id = p_company_id
     AND ((r.created_at >= p_from AND r.created_at <= p_to)
          OR (p_fiscal_year AND r.journal_entry_id IN (
                SELECT e.id FROM public.journal_entries e
                 WHERE e.company_id = p_company_id
                   AND e.fiscal_period_id = p_period_id)));

  IF NOT p_fiscal_year THEN
    v_entry_refs := coalesce(v_reversal_refs, '{}') || coalesce(v_rattelse_refs, '{}') || ARRAY(
      SELECT s->>'journal_entry_id'
        FROM unnest(coalesce(v_guard_states, '{}')) s
      UNION ALL
      SELECT c->>'journal_entry_id'
        FROM unnest(coalesce(v_guard_states, '{}')) s
       CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(s->'candidates') = 'array' THEN s->'candidates' ELSE '[]'::jsonb END) c
       WHERE jsonb_typeof(c) = 'object'
    );
  END IF;

  SELECT coalesce(json_agg(t), '[]'::json)
    INTO v_entries
    FROM (
      SELECT e.id, e.voucher_series, e.voucher_number, e.entry_date, e.description, e.source_type,
             e.status, e.committed_at, e.user_id, e.committed_actor_type, e.committed_actor_label,
             e.commit_method, e.reverses_id, e.correction_of_id, e.import_batch_id,
             e.committed_auth_role, e.committed_auth_uid
        FROM public.journal_entries e
       WHERE e.company_id = p_company_id
         AND e.fiscal_period_id = p_period_id
         AND (p_fiscal_year
              OR (e.committed_at >= p_from AND e.committed_at < p_to + interval '1 millisecond')
              OR e.id::text = ANY (v_entry_refs))
    ) t;

  RETURN QUERY SELECT v_entries, v_audit, v_audit_outside, v_rattelse;
END;
$$;

REVOKE ALL ON FUNCTION public.behandlingshistorik_sources(uuid, uuid, timestamptz, timestamptz, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.behandlingshistorik_sources(uuid, uuid, timestamptz, timestamptz, boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
