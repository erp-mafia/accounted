-- Attest levels for supplier invoices: a limit per person and two attesters
-- from an amount (#135). Builds on 20261028214917 (#124), where the attest
-- marker became the attest service's to set.
--
-- A company wants the controller to attest supplier invoices, the CEO to
-- attest above an amount and an external bookkeeper only to read. Until now
-- the policy had one amount from which attest is required and one list of
-- attesters, all with the same authority.
--
-- 1. company_attest_limits: a limit in SEK per person (null = no limit; no
--    row = no limit), with a scope: supplier_invoice now, booking_review
--    reserved for the review step of one-click booking. Owners and admins
--    write it, members read it, and every change is in audit_log and
--    behandlingshistorik (audit_company_attest_limits).
-- 2. company_attest_policies.two_step_from_sek: from this amount two
--    different attesters must approve. The rules, in any order of approval:
--      below it, one approval by an attester whose limit covers the amount;
--      at or above it, two different attesters, at least one of them with a
--      covering limit.
--    Under mode 'all' every eligible attester still approves, and one of
--    them must cover the amount. Levels are on when two_step_from_sek is set
--    or an attester has a limit; then an attest through an API key or an
--    agent's key is capped by the lower of the person's limit and the key's
--    unattended ceiling.
-- 3. supplier_invoice_attestations.step / limit_sek / amount_sek: what an
--    approval was judged on, kept with it: its place in the round, the limit
--    that applied (through a key: the lower of the person's and the key's)
--    and the invoice's SEK total at the time.
-- 4. supplier_invoice_attest_ruling: the rules in SQL, read only. The same
--    rules as src/lib/supplier-invoices/attest-policy.ts (ruleOnApproval),
--    which the pages, the dry runs and the worklist read; the pg test
--    asserts the two agree case by case, as company-grants does for
--    grant_names_counterparty.
-- 5. attest_supplier_invoice: the one writer of an approval. It locks the
--    invoice, applies the ruling, records the approval with its snapshot and
--    sets approved_at only when the policy is met (or when no policy governs
--    the invoice, as before). SECURITY DEFINER, so its write of the marker
--    passes guard_supplier_invoice_attest_marker: a signed-in session calls
--    it as itself, from the app; the service role names the attester (the
--    mail's link, v1, an approved agent operation). Concurrent approvals of
--    one invoice wait for each other on the row lock, so the last one sees
--    every other and the marker is set once.
-- 6. save_company_attest_policy: the policy and its limits in one
--    transaction, so a save never leaves new attesters with old limits.
--    SECURITY INVOKER: a session is held to the admin-only RLS policies.
-- 7. behandlingshistorik_sources: the function of 20261028214917, unchanged
--    but for company_attest_limits in the audited tables (AUDITED_TABLES in
--    src/lib/reports/behandlingshistorik.ts).
--
-- Payments are unchanged: they read approved_at, which is set exactly when
-- the policy is met. Rejections are unchanged (attest-service.ts): whoever
-- may approve may reject, whatever their limit.
--
-- pg-test: tests/pg/supplier-invoice-attest-levels.pg.test.ts

-- 1. Limits per person ---------------------------------------------------------
CREATE TABLE public.company_attest_limits (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- The person the limit is for (an attester under the policy).
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope           text NOT NULL DEFAULT 'supplier_invoice'
                  CONSTRAINT company_attest_limits_scope_check CHECK (scope IN ('supplier_invoice', 'booking_review')),
  -- The highest amount in SEK the person attests on their own; NULL = no limit.
  max_amount_sek  numeric(14,2)
                  CONSTRAINT company_attest_limits_max_amount_check CHECK (max_amount_sek IS NULL OR max_amount_sek > 0),
  updated_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_attest_limits_one_per_scope UNIQUE (company_id, user_id, scope)
);

COMMENT ON TABLE public.company_attest_limits IS
  'Attest limits per person, in SEK: supplier_invoice (the attest policy for supplier invoices) and booking_review (reserved). No row or a NULL limit = no limit. Owners and admins write it; save_company_attest_policy writes the supplier_invoice rows with the policy.';
COMMENT ON COLUMN public.company_attest_limits.max_amount_sek IS
  'The highest invoice total in SEK the person''s approval covers. NULL = no limit. Under a two-step policy an approval above it may still be the second one, beside an attester whose limit covers the amount.';

CREATE INDEX company_attest_limits_company ON public.company_attest_limits (company_id, scope);

CREATE TRIGGER company_attest_limits_updated_at
  BEFORE UPDATE ON public.company_attest_limits
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.company_attest_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_attest_limits_select_member" ON public.company_attest_limits
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "company_attest_limits_insert_admin" ON public.company_attest_limits
  FOR INSERT WITH CHECK (public.user_is_company_admin(company_id));
CREATE POLICY "company_attest_limits_update_admin" ON public.company_attest_limits
  FOR UPDATE USING (public.user_is_company_admin(company_id)) WITH CHECK (public.user_is_company_admin(company_id));
CREATE POLICY "company_attest_limits_delete_admin" ON public.company_attest_limits
  FOR DELETE USING (public.user_is_company_admin(company_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.company_attest_limits TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.company_attest_limits TO service_role;
-- no-grant: anon on public.company_attest_limits (company configuration, members only)

-- Every change of a limit in audit_log, as the person who made it: the
-- session's user, else the person a service-role save names
-- (save_company_attest_policy sets gnubok.attest_limit_actor), else the
-- row's updated_by. write_audit_log() would log the row's user_id, which
-- here is the attester, not who changed the limit.
CREATE FUNCTION public.audit_company_attest_limits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.company_attest_limits := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  v_user_id uuid := coalesce(
    auth.uid(),
    nullif(current_setting('gnubok.attest_limit_actor', true), '')::uuid,
    v_row.updated_by
  );
BEGIN
  -- Sandbox teardown deletes the company itself (see write_audit_log), and
  -- a row that goes with its company has no company left to log against.
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
     OR (TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id)) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description, actor_type, actor_label)
  VALUES (
    v_user_id, v_row.company_id, TG_OP, TG_TABLE_NAME, v_row.id, v_user_id,
    CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END,
    CASE TG_OP WHEN 'INSERT' THEN 'Set attest limit' WHEN 'UPDATE' THEN 'Changed attest limit' ELSE 'Removed attest limit' END,
    COALESCE(nullif(current_setting('gnubok.actor_type', true), ''), 'user'),
    nullif(current_setting('gnubok.actor_label', true), '')
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_company_attest_limits() FROM PUBLIC, anon;

CREATE TRIGGER audit_company_attest_limits_insert
  AFTER INSERT ON public.company_attest_limits
  FOR EACH ROW EXECUTE FUNCTION public.audit_company_attest_limits();
CREATE TRIGGER audit_company_attest_limits_update
  AFTER UPDATE ON public.company_attest_limits
  FOR EACH ROW
  WHEN (OLD.max_amount_sek IS DISTINCT FROM NEW.max_amount_sek OR OLD.scope IS DISTINCT FROM NEW.scope OR OLD.user_id IS DISTINCT FROM NEW.user_id)
  EXECUTE FUNCTION public.audit_company_attest_limits();
CREATE TRIGGER audit_company_attest_limits_delete
  AFTER DELETE ON public.company_attest_limits
  FOR EACH ROW EXECUTE FUNCTION public.audit_company_attest_limits();

-- 2. Two attesters from an amount ----------------------------------------------
ALTER TABLE public.company_attest_policies
  ADD COLUMN two_step_from_sek numeric(14,2)
    CONSTRAINT company_attest_policies_two_step_check CHECK (two_step_from_sek IS NULL OR two_step_from_sek >= 0);

-- Two different people cannot approve when there is one attester.
ALTER TABLE public.company_attest_policies
  ADD CONSTRAINT company_attest_policies_two_step_needs_two
  CHECK (NOT enabled OR two_step_from_sek IS NULL OR cardinality(attesters) >= 2);

COMMENT ON COLUMN public.company_attest_policies.two_step_from_sek IS
  'From this invoice total in SEK two different attesters must approve, at least one with a limit (company_attest_limits) that covers the amount. NULL = one approval is enough.';

-- The policy's audit (20261028214917) logs a save that changes a rule; the
-- new rule is one of them.
DROP TRIGGER audit_company_attest_policies_update ON public.company_attest_policies;
CREATE TRIGGER audit_company_attest_policies_update
  AFTER UPDATE ON public.company_attest_policies
  FOR EACH ROW
  WHEN (
    OLD.enabled IS DISTINCT FROM NEW.enabled
    OR OLD.threshold_amount IS DISTINCT FROM NEW.threshold_amount
    OR OLD.mode IS DISTINCT FROM NEW.mode
    OR OLD.attesters IS DISTINCT FROM NEW.attesters
    OR OLD.preparer_may_attest IS DISTINCT FROM NEW.preparer_may_attest
    OR OLD.two_step_from_sek IS DISTINCT FROM NEW.two_step_from_sek
  )
  EXECUTE FUNCTION public.audit_company_attest_policies();

-- 3. What an approval was judged on ----------------------------------------------
ALTER TABLE public.supplier_invoice_attestations
  ADD COLUMN step smallint CONSTRAINT supplier_invoice_attestations_step_check CHECK (step IS NULL OR step >= 1),
  ADD COLUMN limit_sek numeric,
  ADD COLUMN amount_sek numeric;

COMMENT ON COLUMN public.supplier_invoice_attestations.step IS
  'The approval''s place among the counted approvals of its round (1, 2, ...) when the attest policy governed the invoice; NULL for a rejection, an approval no policy asked for and rows before 2026-10-30.';
COMMENT ON COLUMN public.supplier_invoice_attestations.limit_sek IS
  'The limit in SEK that applied to the approval: the person''s (company_attest_limits), through a key with levels on the lower of it and the key''s unattended ceiling. NULL = no limit, or no policy.';
COMMENT ON COLUMN public.supplier_invoice_attestations.amount_sek IS
  'The invoice''s total in SEK when the approval was given, as the rules judged it. NULL when a foreign invoice had no rate.';

-- 4. The rules ---------------------------------------------------------------------
--
-- What an approval of the invoice by p_user_id would do, without writing
-- anything: {kind: 'unrestricted'} when no policy governs the invoice,
-- {kind: 'refused', code, reason?} or {kind: 'record', satisfies, step,
-- steps, limit_sek, amount_sek}. The order of the checks, and every rule,
-- mirror ruleOnApproval in src/lib/supplier-invoices/attest-policy.ts, after
-- the attest service's own check that the person keeps the books. The status
-- of the invoice is the caller's to check (attest_supplier_invoice, under
-- its lock).
CREATE FUNCTION public.supplier_invoice_attest_ruling(
  p_company_id uuid,
  p_invoice_id uuid,
  p_user_id uuid,
  p_via_key boolean DEFAULT false,
  p_key_ceiling numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_invoice record;
  v_policy record;
  v_method text;
  v_amount numeric;
  v_writers uuid[];
  v_eligible uuid[];
  v_round_start timestamptz;
  v_approved uuid[];
  v_limit numeric;
  v_levels boolean;
  v_ceiling numeric := CASE WHEN p_key_ceiling > 0 THEN p_key_ceiling END;
  v_applied numeric;
  v_steps integer;
  v_covering boolean;
  v_after uuid[];
BEGIN
  SELECT si.user_id, si.is_credit_note, si.currency, si.total, si.total_sek, si.exchange_rate
    INTO v_invoice
    FROM public.supplier_invoices si
   WHERE si.id = p_invoice_id AND si.company_id = p_company_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'refused', 'code', 'SI_NOT_FOUND');
  END IF;

  -- Only someone who keeps the books attests, policy or not (owner, admin,
  -- member: isBookkeepingWriterRole).
  v_writers := ARRAY(
    SELECT m.user_id FROM public.company_members m
     WHERE m.company_id = p_company_id AND m.role IN ('owner', 'admin', 'member'));
  IF p_user_id IS NULL OR NOT (p_user_id = ANY (v_writers)) THEN
    RETURN jsonb_build_object('kind', 'refused', 'code', 'FORBIDDEN', 'reason', 'not_member');
  END IF;

  SELECT s.accounting_method INTO v_method FROM public.company_settings s WHERE s.company_id = p_company_id;
  SELECT p.enabled, p.threshold_amount, p.mode, p.attesters, p.preparer_may_attest, p.two_step_from_sek
    INTO v_policy
    FROM public.company_attest_policies p
   WHERE p.company_id = p_company_id;

  -- invoiceTotalSek: the stored SEK total, the total of a SEK invoice, the
  -- total at the invoice's rate; NULL without a rate. To the öre.
  v_amount := round(abs(CASE
    WHEN v_invoice.total_sek IS NOT NULL AND v_invoice.total_sek <> 'NaN'::numeric THEN v_invoice.total_sek
    WHEN v_invoice.currency = 'SEK' THEN v_invoice.total
    WHEN v_invoice.exchange_rate IS NULL OR v_invoice.exchange_rate <= 0 THEN NULL
    ELSE v_invoice.total * v_invoice.exchange_rate
  END), 2);

  -- invoiceNeedsAttest: the policy is on, faktureringsmetoden, a payable,
  -- at or above the threshold (or no threshold, or an amount that cannot be
  -- judged).
  IF NOT (coalesce(v_policy.enabled, false)
          AND coalesce(v_method, '') <> 'cash'
          AND NOT coalesce(v_invoice.is_credit_note, false)
          AND (v_policy.threshold_amount IS NULL OR v_amount IS NULL OR v_amount >= v_policy.threshold_amount)) THEN
    RETURN jsonb_build_object('kind', 'unrestricted', 'amount_sek', v_amount);
  END IF;

  IF NOT (p_user_id = ANY (v_policy.attesters)) THEN
    RETURN jsonb_build_object('kind', 'refused', 'code', 'ATTEST_NOT_ALLOWED', 'reason', 'not_attester');
  END IF;
  IF NOT v_policy.preparer_may_attest AND v_invoice.user_id = p_user_id THEN
    RETURN jsonb_build_object('kind', 'refused', 'code', 'ATTEST_NOT_ALLOWED', 'reason', 'registrant');
  END IF;

  -- The round: the decisions after the latest rejection.
  SELECT max(t.decided_at) INTO v_round_start
    FROM public.supplier_invoice_attestations t
   WHERE t.company_id = p_company_id AND t.supplier_invoice_id = p_invoice_id AND t.decision = 'rejected';
  IF EXISTS (
    SELECT 1 FROM public.supplier_invoice_attestations t
     WHERE t.company_id = p_company_id AND t.supplier_invoice_id = p_invoice_id
       AND t.decision = 'approved' AND t.user_id = p_user_id
       AND (v_round_start IS NULL OR t.decided_at > v_round_start)
  ) THEN
    RETURN jsonb_build_object('kind', 'refused', 'code', 'ATTEST_ALREADY_GIVEN');
  END IF;

  -- eligibleAttesters: the attesters, without the registrant unless allowed,
  -- who still keep the books. Only their approvals count.
  v_eligible := ARRAY(
    SELECT DISTINCT a.user_id FROM unnest(v_policy.attesters) AS a(user_id)
     WHERE (v_policy.preparer_may_attest OR a.user_id <> v_invoice.user_id)
       AND a.user_id = ANY (v_writers));
  v_approved := ARRAY(
    SELECT DISTINCT t.user_id FROM public.supplier_invoice_attestations t
     WHERE t.company_id = p_company_id AND t.supplier_invoice_id = p_invoice_id
       AND t.decision = 'approved' AND (v_round_start IS NULL OR t.decided_at > v_round_start)
       AND t.user_id = ANY (v_eligible));

  -- The levels.
  SELECT l.max_amount_sek INTO v_limit
    FROM public.company_attest_limits l
   WHERE l.company_id = p_company_id AND l.user_id = p_user_id AND l.scope = 'supplier_invoice';
  v_levels := v_policy.two_step_from_sek IS NOT NULL OR EXISTS (
    SELECT 1 FROM public.company_attest_limits l
     WHERE l.company_id = p_company_id AND l.scope = 'supplier_invoice' AND l.max_amount_sek IS NOT NULL
       AND l.user_id = ANY (v_policy.attesters));
  v_steps := CASE
    WHEN v_policy.two_step_from_sek IS NOT NULL AND (v_amount IS NULL OR v_amount >= v_policy.two_step_from_sek) THEN 2
    ELSE 1 END;
  -- LEAST ignores NULL: no limit on one side leaves the other.
  v_applied := CASE WHEN coalesce(p_via_key, false) AND v_levels THEN least(v_limit, v_ceiling) ELSE v_limit END;

  IF coalesce(p_via_key, false) AND v_levels
     AND NOT (v_applied IS NULL OR (v_amount IS NOT NULL AND v_amount <= v_applied)) THEN
    RETURN jsonb_build_object('kind', 'refused', 'code', 'ATTEST_LIMIT_EXCEEDED', 'reason', 'key_limit',
                              'limit_sek', v_applied, 'amount_sek', v_amount);
  END IF;

  v_covering := EXISTS (
    SELECT 1 FROM unnest(v_approved) AS a(user_id)
      LEFT JOIN public.company_attest_limits l
        ON l.company_id = p_company_id AND l.user_id = a.user_id AND l.scope = 'supplier_invoice'
     WHERE l.max_amount_sek IS NULL OR (v_amount IS NOT NULL AND v_amount <= l.max_amount_sek));

  -- Mode 'any': an approval whose limit does not cover the amount counts
  -- only while the round has room for someone besides the covering approver
  -- it still needs.
  IF v_policy.mode <> 'all'
     AND NOT (v_limit IS NULL OR (v_amount IS NOT NULL AND v_amount <= v_limit))
     AND v_steps - cardinality(v_approved) - (CASE WHEN v_covering THEN 0 ELSE 1 END) <= 0 THEN
    RETURN jsonb_build_object('kind', 'refused', 'code', 'ATTEST_LIMIT_EXCEEDED', 'reason', 'limit',
                              'limit_sek', v_limit, 'amount_sek', v_amount);
  END IF;

  v_after := v_approved || p_user_id;
  RETURN jsonb_build_object(
    'kind', 'record',
    'satisfies',
      cardinality(v_eligible) > 0
      AND (v_policy.mode <> 'all' OR NOT EXISTS (SELECT 1 FROM unnest(v_eligible) AS e(user_id) WHERE NOT (e.user_id = ANY (v_after))))
      AND cardinality(v_after) >= v_steps
      AND (v_covering OR v_limit IS NULL OR (v_amount IS NOT NULL AND v_amount <= v_limit)),
    'step', cardinality(v_approved) + 1,
    'steps', v_steps,
    'limit_sek', v_applied,
    'amount_sek', v_amount);
END;
$$;

REVOKE ALL ON FUNCTION public.supplier_invoice_attest_ruling(uuid, uuid, uuid, boolean, numeric) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.supplier_invoice_attest_ruling(uuid, uuid, uuid, boolean, numeric) IS
  'The attest rules for supplier invoices in SQL (policy, limits, two steps, key cap): what an approval by the user would do. Read only; attest_supplier_invoice applies it under the invoice lock. Mirrors ruleOnApproval in src/lib/supplier-invoices/attest-policy.ts.';

-- 5. The one writer of an approval -----------------------------------------------
CREATE FUNCTION public.attest_supplier_invoice(
  p_company_id uuid,
  p_invoice_id uuid,
  p_user_id uuid DEFAULT NULL,
  p_source text DEFAULT 'app',
  p_via_key boolean DEFAULT false,
  p_key_ceiling numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_actor uuid;
  v_source text := p_source;
  v_via_key boolean := coalesce(p_via_key, false);
  v_ceiling numeric := p_key_ceiling;
  v_invoice record;
  v_ruling jsonb;
  v_record boolean;
  v_sets boolean;
  v_attestation_id uuid;
  v_status text;
  v_approved_at timestamptz;
BEGIN
  IF auth.role() = 'service_role' THEN
    -- Server code names the attester: the mail's link, v1, an approved agent operation.
    v_actor := p_user_id;
  ELSE
    -- A signed-in session attests as itself, in the app.
    v_actor := auth.uid();
    IF v_actor IS NULL OR (p_user_id IS NOT NULL AND p_user_id <> v_actor) THEN
      RAISE EXCEPTION 'Du kan bara attestera i ditt eget namn.'
        USING ERRCODE = '42501',
              DETAIL = 'attest_supplier_invoice: a session attests as auth.uid()';
    END IF;
    v_source := 'app';
    v_via_key := false;
    v_ceiling := NULL;
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'attest_supplier_invoice: p_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF v_source IS NULL OR v_source NOT IN ('app', 'email_link', 'api', 'mcp') THEN
    RAISE EXCEPTION 'attest_supplier_invoice: unknown source %', v_source USING ERRCODE = '22023';
  END IF;
  -- A company the attester is no member of has no invoices to them, as under RLS.
  IF NOT EXISTS (SELECT 1 FROM public.company_members m WHERE m.company_id = p_company_id AND m.user_id = v_actor) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SI_NOT_FOUND');
  END IF;

  -- The lock: approvals of one invoice take turns, so the last one reads
  -- every other and the marker is set once.
  SELECT si.status, si.approved_at, si.due_date, si.remaining_amount, si.is_credit_note
    INTO v_invoice
    FROM public.supplier_invoices si
   WHERE si.id = p_invoice_id AND si.company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SI_NOT_FOUND');
  END IF;
  IF v_invoice.approved_at IS NOT NULL OR v_invoice.status NOT IN ('registered', 'overdue') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SI_APPROVE_NOT_REGISTERED', 'current_status', v_invoice.status);
  END IF;

  v_ruling := public.supplier_invoice_attest_ruling(p_company_id, p_invoice_id, v_actor, v_via_key, v_ceiling);
  IF v_ruling->>'kind' = 'refused' THEN
    RETURN (v_ruling - 'kind') || jsonb_build_object('ok', false);
  END IF;
  v_record := v_ruling->>'kind' = 'record';
  v_sets := NOT v_record OR (v_ruling->>'satisfies')::boolean;

  INSERT INTO public.supplier_invoice_attestations
    (company_id, supplier_invoice_id, user_id, decision, source, step, limit_sek, amount_sek, decided_at)
  VALUES (
    p_company_id, p_invoice_id, v_actor, 'approved', v_source,
    CASE WHEN v_record THEN (v_ruling->>'step')::smallint END,
    CASE WHEN v_record THEN round((v_ruling->>'limit_sek')::numeric, 2) END,
    (v_ruling->>'amount_sek')::numeric,
    -- Dated after the lock, not at the transaction's start: a rejection that
    -- committed while this call waited is older than this approval, as the
    -- ruling above counted it.
    clock_timestamp()
  )
  RETURNING id INTO v_attestation_id;

  IF v_sets THEN
    -- resolveUnsettledStatus: an attested payable past its due date stays
    -- 'overdue' (the daily cron's predicate), else 'approved'.
    v_status := CASE
      WHEN NOT coalesce(v_invoice.is_credit_note, false)
       AND v_invoice.remaining_amount > 0.005
       AND v_invoice.due_date < (now() AT TIME ZONE 'Europe/Stockholm')::date THEN 'overdue'
      ELSE 'approved' END;
    UPDATE public.supplier_invoices
       SET status = v_status, approved_at = now(), approved_by = v_actor
     WHERE id = p_invoice_id AND company_id = p_company_id
    RETURNING approved_at INTO v_approved_at;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'approved', v_sets,
    'required', v_record,
    'attestation_id', v_attestation_id,
    'status', coalesce(v_status, v_invoice.status),
    'approved_at', v_approved_at,
    'step', v_ruling->'step',
    'steps', v_ruling->'steps',
    'limit_sek', v_ruling->'limit_sek',
    'amount_sek', v_ruling->'amount_sek');
END;
$$;

REVOKE ALL ON FUNCTION public.attest_supplier_invoice(uuid, uuid, uuid, text, boolean, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attest_supplier_invoice(uuid, uuid, uuid, text, boolean, numeric) TO authenticated, service_role;

COMMENT ON FUNCTION public.attest_supplier_invoice(uuid, uuid, uuid, text, boolean, numeric) IS
  'Approve (attest) a supplier invoice: locks it, applies supplier_invoice_attest_ruling, records the approval with its step, limit and amount, and sets approved_at when the policy is met (or no policy governs the invoice). A session attests as itself; the service role names the attester, the source and the key it came through.';

-- 6. The policy and its limits, saved together ----------------------------------
--
-- p_limits: [{user_id, max_amount_sek}] replaces the supplier_invoice limits
-- (a person left out loses theirs); NULL leaves the attesters' limits as they
-- are. Either way someone who is no longer an attester loses theirs.
CREATE FUNCTION public.save_company_attest_policy(
  p_company_id uuid,
  p_enabled boolean,
  p_threshold_amount numeric,
  p_mode text,
  p_attesters uuid[],
  p_preparer_may_attest boolean,
  p_two_step_from_sek numeric,
  p_limits jsonb,
  p_updated_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $$
BEGIN
  INSERT INTO public.company_attest_policies AS p
    (company_id, enabled, threshold_amount, mode, attesters, preparer_may_attest, two_step_from_sek, updated_by)
  VALUES
    (p_company_id, p_enabled, p_threshold_amount, p_mode, p_attesters, p_preparer_may_attest, p_two_step_from_sek, p_updated_by)
  ON CONFLICT (company_id) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    threshold_amount = EXCLUDED.threshold_amount,
    mode = EXCLUDED.mode,
    attesters = EXCLUDED.attesters,
    preparer_may_attest = EXCLUDED.preparer_may_attest,
    two_step_from_sek = EXCLUDED.two_step_from_sek,
    updated_by = EXCLUDED.updated_by;

  IF p_limits IS NOT NULL AND jsonb_typeof(p_limits) <> 'array' THEN
    RAISE EXCEPTION 'save_company_attest_policy: p_limits must be an array' USING ERRCODE = '22023';
  END IF;

  -- Who changed the limits, for audit_company_attest_limits when no session names them.
  PERFORM set_config('gnubok.attest_limit_actor', coalesce(p_updated_by::text, ''), true);

  -- A limit is an attester's: whoever is no longer one loses theirs.
  DELETE FROM public.company_attest_limits l
   WHERE l.company_id = p_company_id
     AND l.scope = 'supplier_invoice'
     AND NOT (l.user_id = ANY (coalesce(p_attesters, '{}'::uuid[])));

  IF p_limits IS NULL THEN
    RETURN;
  END IF;

  DELETE FROM public.company_attest_limits l
   WHERE l.company_id = p_company_id
     AND l.scope = 'supplier_invoice'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_limits) AS e(item) WHERE (e.item->>'user_id')::uuid = l.user_id);

  INSERT INTO public.company_attest_limits AS l (company_id, user_id, scope, max_amount_sek, updated_by)
  SELECT p_company_id, (e.item->>'user_id')::uuid, 'supplier_invoice', (e.item->>'max_amount_sek')::numeric, p_updated_by
    FROM jsonb_array_elements(p_limits) AS e(item)
  ON CONFLICT (company_id, user_id, scope) DO UPDATE
    SET max_amount_sek = EXCLUDED.max_amount_sek,
        updated_by = EXCLUDED.updated_by
    WHERE l.max_amount_sek IS DISTINCT FROM EXCLUDED.max_amount_sek;
END;
$$;

REVOKE ALL ON FUNCTION public.save_company_attest_policy(uuid, boolean, numeric, text, uuid[], boolean, numeric, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_company_attest_policy(uuid, boolean, numeric, text, uuid[], boolean, numeric, jsonb, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.save_company_attest_policy(uuid, boolean, numeric, text, uuid[], boolean, numeric, jsonb, uuid) IS
  'Save the attest policy for supplier invoices and its limits per person in one transaction. SECURITY INVOKER: a session is held to the admin-only RLS policies of both tables.';

-- 7. behandlingshistorik reads the limit changes ------------------------------------
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
            'company_grant_settings', 'company_attest_policies', 'company_attest_limits'])
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
