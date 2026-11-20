-- Ordered attest steps for supplier invoices: förattest per project, then
-- the attest itself, and substitutes (accounted#192, crm#1179).
--
-- A construction company with about fifteen attesters wants the project
-- leader to look at an invoice first and ekonomi to attest it after, the
-- project leader chosen by the invoice's project, and someone to stand in
-- when an attester is away. Until now the policy had one list of attesters
-- with no order between them (#135: two attesters from an amount, in any
-- order).
--
-- Everything here is opt-in: a company that names no förattestant, no
-- project attester and no substitute is ruled exactly as before
-- (tests/pg/supplier-invoice-attest-steps.pg.test.ts runs the ruling of
-- 20261102202100 beside this one and compares them case by case).
--
-- 1. company_attest_policies.pre_attesters and .project_attesters: the
--    förattest. Every project (dimension 6) on the invoice's lines needs one
--    förattest by that project's attesters (project_attesters, by code); a
--    line without a project, or with a project nobody is named for, needs one
--    by pre_attesters; with neither there is no förattest. One approval
--    covers every group its giver is in. Only once every group has its
--    förattest may the policy's attesters attest, as before (mode, limits,
--    two attesters from an amount). A person's approval counts once per
--    round, in the step it was given in: the one who förattested cannot
--    also attest the same invoice. Förattest is no decision on the amount,
--    so no limit applies to it (an API key's own ceiling still does, at the
--    door). Codes, not dimension_values ids: an invoice's lines carry the
--    code, and a code never changes.
-- 2. company_attest_substitutes: an attester away names who stands in, for
--    a date range (Stockholm dates, both days included, at most 366 days).
--    While it runs the substitute may attest wherever the attester may, as
--    the attester: in their place in the order, with their limit. Owners
--    and admins name substitutes for anyone, an attester names their own.
--    Rows are added and removed through add_company_attest_substitute and
--    remove_company_attest_substitute, which say who did it for the audit.
--    The table keys on the policy row, so the policy's one read embeds the
--    substitutions that run today: a company without them reads exactly
--    what it read before.
-- 3. supplier_invoice_attestations.stage and .on_behalf_of: which step an
--    approval was given in ('pre' or 'final'; null for a rejection and rows
--    before this migration, which count as 'final') and whom a substitute
--    acted for ("B för A"). The attest counts as the attester's; the row
--    keeps who clicked.
-- 4. supplier_invoice_pre_attest_groups: the förattest groups of one
--    invoice, read only. The TypeScript twin is preAttestGroups in
--    src/lib/supplier-invoices/attest-policy.ts.
-- 5. supplier_invoice_attest_ruling: the ruling of 20261102202100 with the
--    order and the substitutes. attest_supplier_invoice records the step and
--    the attester acted for. ruleOnApproval in attest-policy.ts holds the
--    same rules; the pg test proves the two agree.
-- 6. save_company_attest_policy takes the förattest beside the policy; left
--    out (NULL) it is kept as it is, so code from before this migration
--    still saves.
-- 7. The audit: a policy save that changes the förattest is logged, every
--    substitute added or removed is logged (audit_company_attest_substitutes),
--    and behandlingshistorik_sources reads company_attest_substitutes
--    (restated from 20261108174501, unchanged but for that table).
--
-- Payments are unchanged: they read approved_at, set exactly when the policy
-- is met, förattest included.
--
-- pg-test: tests/pg/supplier-invoice-attest-steps.pg.test.ts

-- 1. Förattest -------------------------------------------------------------------

-- {code: [user id, ...]}: at most 500 projects of 1 to 50 attesters each.
CREATE FUNCTION public.attest_project_attesters_valid(p_value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $$
  SELECT jsonb_typeof(p_value) = 'object'
     AND (SELECT count(*) FROM jsonb_object_keys(p_value)) <= 500
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_each(p_value) AS e(key, value)
        WHERE char_length(e.key) NOT BETWEEN 1 AND 40
           OR e.key ~ '["{}]'
           OR e.key <> regexp_replace(e.key, '^[[:space:]]+|[[:space:]]+$', '', 'g')
           OR jsonb_typeof(e.value) <> 'array'
           OR jsonb_array_length(e.value) NOT BETWEEN 1 AND 50
           OR EXISTS (
             SELECT 1 FROM jsonb_array_elements(e.value) AS a(id)
              WHERE jsonb_typeof(a.id) <> 'string'
                 OR (a.id #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
$$;

REVOKE ALL ON FUNCTION public.attest_project_attesters_valid(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attest_project_attesters_valid(jsonb) TO authenticated, service_role;

ALTER TABLE public.company_attest_policies
  ADD COLUMN pre_attesters uuid[] NOT NULL DEFAULT '{}'
    CONSTRAINT company_attest_policies_pre_attesters_check
    CHECK (cardinality(pre_attesters) <= 50 AND array_position(pre_attesters, NULL) IS NULL),
  ADD COLUMN project_attesters jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT company_attest_policies_project_attesters_check
    CHECK (public.attest_project_attesters_valid(project_attesters));

COMMENT ON COLUMN public.company_attest_policies.pre_attesters IS
  'Förattest: one of them approves first an invoice (or a line) without a project of its own in project_attesters; empty = no förattest for those. Members whose attest can count, checked by the server on save.';
COMMENT ON COLUMN public.company_attest_policies.project_attesters IS
  'Förattest per project: {dimension 6 code: [user id, ...]}. Every project on an invoice''s lines needs an approval by one of its attesters before the attesters may attest. Empty = no project routing.';

-- The policy's audit (20261030140000) logs a save that changes a rule; the
-- förattest is a rule.
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
    OR OLD.pre_attesters IS DISTINCT FROM NEW.pre_attesters
    OR OLD.project_attesters IS DISTINCT FROM NEW.project_attesters
  )
  EXECUTE FUNCTION public.audit_company_attest_policies();

-- 2. Substitutes --------------------------------------------------------------------
CREATE TABLE public.company_attest_substitutes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- A substitute stands in under the company's attest policy, and the policy
  -- reads today's substitutes in its own read (an embed needs this key).
  company_id          uuid NOT NULL REFERENCES public.company_attest_policies(company_id) ON DELETE CASCADE,
  -- The attester who is away.
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Who attests in their place while the period runs.
  substitute_user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Stockholm dates, both included.
  starts_on           date NOT NULL,
  ends_on             date NOT NULL,
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_attest_substitutes_not_self CHECK (user_id <> substitute_user_id),
  CONSTRAINT company_attest_substitutes_period CHECK (ends_on >= starts_on AND ends_on - starts_on <= 366)
);

COMMENT ON TABLE public.company_attest_substitutes IS
  'Substitutes for supplier invoice attest: while starts_on..ends_on (Stockholm dates) runs, substitute_user_id attests wherever user_id may, as user_id (their place in the order, their limit). Owners and admins add them for anyone, an attester for themselves; added and removed through add_company_attest_substitute and remove_company_attest_substitute.';

CREATE INDEX company_attest_substitutes_substitute ON public.company_attest_substitutes (company_id, substitute_user_id, ends_on);
CREATE INDEX company_attest_substitutes_user ON public.company_attest_substitutes (company_id, user_id, ends_on);

ALTER TABLE public.company_attest_substitutes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_attest_substitutes_select_member" ON public.company_attest_substitutes
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
-- An owner or admin names a substitute for anyone; a member names their own, as themselves.
CREATE POLICY "company_attest_substitutes_insert_admin_or_self" ON public.company_attest_substitutes
  FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND (public.user_is_company_admin(company_id) OR (user_id = (SELECT auth.uid()) AND created_by = (SELECT auth.uid())))
  );
CREATE POLICY "company_attest_substitutes_delete_admin_or_self" ON public.company_attest_substitutes
  FOR DELETE USING (
    company_id IN (SELECT public.user_company_ids())
    AND (public.user_is_company_admin(company_id) OR user_id = (SELECT auth.uid()))
  );

-- No UPDATE: a changed period is a removed row and a new one, both logged.
GRANT SELECT, INSERT, DELETE ON TABLE public.company_attest_substitutes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.company_attest_substitutes TO service_role;
-- no-grant: anon on public.company_attest_substitutes (company configuration, members only)

-- Every substitute added or removed, as the person who did it: the session's
-- user, else the person the RPC names (gnubok.attest_substitute_actor), else
-- the row's created_by.
CREATE FUNCTION public.audit_company_attest_substitutes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.company_attest_substitutes := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  v_user_id uuid := coalesce(
    auth.uid(),
    nullif(current_setting('gnubok.attest_substitute_actor', true), '')::uuid,
    v_row.created_by
  );
BEGIN
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
     OR (TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id)) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description, actor_type, actor_label)
  VALUES (
    v_user_id, v_row.company_id, TG_OP, TG_TABLE_NAME, v_row.id, v_user_id,
    CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END,
    CASE TG_OP WHEN 'INSERT' THEN 'Added attest substitute' WHEN 'UPDATE' THEN 'Changed attest substitute' ELSE 'Removed attest substitute' END,
    COALESCE(nullif(current_setting('gnubok.actor_type', true), ''), 'user'),
    nullif(current_setting('gnubok.actor_label', true), '')
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_company_attest_substitutes() FROM PUBLIC, anon;

CREATE TRIGGER audit_company_attest_substitutes
  AFTER INSERT OR UPDATE OR DELETE ON public.company_attest_substitutes
  FOR EACH ROW EXECUTE FUNCTION public.audit_company_attest_substitutes();

-- Add a substitute. SECURITY INVOKER: a session is held to the RLS policies
-- above; the service role (v1) checks who may in the server first.
CREATE FUNCTION public.add_company_attest_substitute(
  p_company_id uuid,
  p_user_id uuid,
  p_substitute_user_id uuid,
  p_starts_on date,
  p_ends_on date,
  p_actor uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM set_config('gnubok.attest_substitute_actor', coalesce(p_actor::text, ''), true);
  INSERT INTO public.company_attest_substitutes (company_id, user_id, substitute_user_id, starts_on, ends_on, created_by)
  VALUES (p_company_id, p_user_id, p_substitute_user_id, p_starts_on, p_ends_on, p_actor)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.add_company_attest_substitute(uuid, uuid, uuid, date, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_company_attest_substitute(uuid, uuid, uuid, date, date, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.add_company_attest_substitute(uuid, uuid, uuid, date, date, uuid) IS
  'Add a substitute for supplier invoice attest, logged as p_actor when no session names who. SECURITY INVOKER: a session is held to the RLS policies of company_attest_substitutes (an owner or admin for anyone, a member for themselves).';

-- Remove a substitute; answers whether a row went.
CREATE FUNCTION public.remove_company_attest_substitute(p_company_id uuid, p_id uuid, p_actor uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $$
BEGIN
  PERFORM set_config('gnubok.attest_substitute_actor', coalesce(p_actor::text, ''), true);
  DELETE FROM public.company_attest_substitutes s WHERE s.company_id = p_company_id AND s.id = p_id;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_company_attest_substitute(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_company_attest_substitute(uuid, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.remove_company_attest_substitute(uuid, uuid, uuid) IS
  'Remove a substitute for supplier invoice attest, logged as p_actor when no session names who. SECURITY INVOKER: a session is held to the RLS policies of company_attest_substitutes.';

-- 3. Which step, and for whom ---------------------------------------------------------
ALTER TABLE public.supplier_invoice_attestations
  ADD COLUMN stage text CONSTRAINT supplier_invoice_attestations_stage_check CHECK (stage IS NULL OR stage IN ('pre', 'final')),
  ADD COLUMN on_behalf_of uuid REFERENCES auth.users(id) ON DELETE RESTRICT;

COMMENT ON COLUMN public.supplier_invoice_attestations.stage IS
  'The step an approval was given in: ''pre'' (förattest) or ''final'' (the attest the policy asks for). NULL for a rejection, and rows before this migration; NULL counts as final.';
COMMENT ON COLUMN public.supplier_invoice_attestations.on_behalf_of IS
  'The attester a substitute (company_attest_substitutes) acted for: the decision counts as theirs, user_id is who made it. NULL = the person made it in their own name.';

-- 4. The förattest groups of one invoice -------------------------------------------------
--
-- [{project, attesters}]: one group per project on the invoice's lines that
-- project_attesters names, by code; then one group of pre_attesters when a
-- line has no project, or a project nobody is named for (null project). A
-- line's project is the one its verifikat line books to: its own dimension 6
-- when the line names one (an empty value clears the invoice's), else the
-- invoice's (mergeDimensionBags); an invoice without lines reads its own.
-- Codes are read and trimmed as the reports read them (dimension_tag_code).
-- Empty when there is no förattest. Mirrors invoiceProjects and
-- preAttestGroups in attest-policy.ts.
CREATE FUNCTION public.supplier_invoice_pre_attest_groups(p_company_id uuid, p_invoice_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO ''
AS $$
  WITH pol AS (
    SELECT p.pre_attesters, p.project_attesters FROM public.company_attest_policies p WHERE p.company_id = p_company_id
  ), inv AS (
    SELECT si.id, public.dimension_tag_code(si.default_dimensions, '6') AS default_code
      FROM public.supplier_invoices si
     WHERE si.id = p_invoice_id AND si.company_id = p_company_id
  ), codes AS (
    SELECT CASE WHEN it.dimensions ? '6' THEN public.dimension_tag_code(it.dimensions, '6') ELSE inv.default_code END AS code
      FROM inv JOIN public.supplier_invoice_items it ON it.supplier_invoice_id = inv.id
    UNION
    SELECT inv.default_code FROM inv
     WHERE NOT EXISTS (SELECT 1 FROM public.supplier_invoice_items it WHERE it.supplier_invoice_id = inv.id)
  ), routed AS (
    SELECT c.code, pol.project_attesters -> c.code AS attesters
      FROM codes c CROSS JOIN pol
     WHERE c.code IS NOT NULL
       AND jsonb_typeof(pol.project_attesters -> c.code) = 'array'
       AND jsonb_array_length(pol.project_attesters -> c.code) > 0
  )
  SELECT coalesce(jsonb_agg(x.g ORDER BY x.ord, x.project COLLATE "C"), '[]'::jsonb)
    FROM (
      SELECT 0 AS ord, r.code AS project, jsonb_build_object('project', r.code, 'attesters', r.attesters) AS g FROM routed r
      UNION ALL
      SELECT 1, NULL, jsonb_build_object('project', NULL, 'attesters', to_jsonb(pol.pre_attesters))
        FROM pol
       WHERE cardinality(pol.pre_attesters) > 0
         AND EXISTS (SELECT 1 FROM codes c WHERE NOT EXISTS (SELECT 1 FROM routed r WHERE r.code = c.code))
    ) x
$$;

REVOKE ALL ON FUNCTION public.supplier_invoice_pre_attest_groups(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.supplier_invoice_pre_attest_groups(uuid, uuid) IS
  'The förattest groups of a supplier invoice: [{project, attesters}], one per project on its lines named in company_attest_policies.project_attesters, then pre_attesters for lines without one (project null). Read by supplier_invoice_attest_ruling. Mirrors preAttestGroups in src/lib/supplier-invoices/attest-policy.ts.';

-- True when every group has an approval by one of its attesters among p_slots.
CREATE FUNCTION public.attest_pre_groups_met(p_groups jsonb, p_slots uuid[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(coalesce(p_groups, '[]'::jsonb)) AS g(item)
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(g.item->'attesters') AS a(id)
        WHERE a.id::uuid = ANY (coalesce(p_slots, '{}'::uuid[]))))
$$;

REVOKE ALL ON FUNCTION public.attest_pre_groups_met(jsonb, uuid[]) FROM PUBLIC, anon, authenticated, service_role;

-- 5. The rules -------------------------------------------------------------------------
--
-- What an approval of the invoice by p_user_id would do, without writing
-- anything. As in 20261102202100, plus, where the policy governs the
-- invoice: who the user may act for (themselves, then each attester whose
-- substitute they are today, by id), which step the invoice is at (förattest
-- until every group has one, then the attest), and whose place the approval
-- takes (the first of those people the step still needs). The record gains
-- stage and on_behalf_of. A user who attests the invoice at some step but not
-- the one it is at is refused ATTEST_NOT_ALLOWED other_step.
CREATE OR REPLACE FUNCTION public.supplier_invoice_attest_ruling(
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
  v_members uuid[];
  v_today date := public.stockholm_today();
  v_candidates uuid[];
  v_groups jsonb;
  v_pre_eligible uuid[];
  v_round_start timestamptz;
  v_pre_slots uuid[];
  v_pre_met boolean;
  v_eligible uuid[];
  v_approved uuid[];
  v_stage_set uuid[];
  v_slot uuid;
  v_on_behalf_of uuid;
  v_limit numeric;
  v_levels boolean;
  v_ceiling numeric := CASE WHEN p_key_ceiling > 0 THEN p_key_ceiling END;
  v_applied numeric;
  v_steps integer;
  v_covering boolean;
  v_after uuid[];
  v_eligible_after uuid[];
BEGIN
  SELECT si.user_id, si.is_credit_note, si.currency, si.total, si.total_sek, si.exchange_rate
    INTO v_invoice
    FROM public.supplier_invoices si
   WHERE si.id = p_invoice_id AND si.company_id = p_company_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'refused', 'code', 'SI_NOT_FOUND');
  END IF;

  -- Whose attest can count (isAttestRole): those who keep the books (owner,
  -- admin, member: isBookkeepingWriterRole), and viewers, who attest only
  -- where the policy names them (crm#1569). Anyone else is no attester.
  v_writers := ARRAY(
    SELECT m.user_id FROM public.company_members m
     WHERE m.company_id = p_company_id AND m.role IN ('owner', 'admin', 'member'));
  v_members := ARRAY(
    SELECT m.user_id FROM public.company_members m
     WHERE m.company_id = p_company_id AND m.role IN ('owner', 'admin', 'member', 'viewer'));
  IF p_user_id IS NULL OR NOT (p_user_id = ANY (v_members)) THEN
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
    -- No policy governs the invoice: the one click it was before the policy,
    -- which only someone who keeps the books gives (deciderRefusal).
    IF NOT (p_user_id = ANY (v_writers)) THEN
      RETURN jsonb_build_object('kind', 'refused', 'code', 'FORBIDDEN', 'reason', 'read_only');
    END IF;
    RETURN jsonb_build_object('kind', 'unrestricted', 'amount_sek', v_amount);
  END IF;

  -- Who the user may act for today: themselves, then each attester whose
  -- substitute they are (company_attest_substitutes), by id.
  v_candidates := ARRAY[p_user_id] || ARRAY(
    SELECT DISTINCT s.user_id FROM public.company_attest_substitutes s
     WHERE s.company_id = p_company_id AND s.substitute_user_id = p_user_id AND s.user_id <> p_user_id
       AND v_today BETWEEN s.starts_on AND s.ends_on
     ORDER BY s.user_id);
  v_groups := public.supplier_invoice_pre_attest_groups(p_company_id, p_invoice_id);

  -- Neither the user nor anyone they stand in for attests the invoice at any step.
  IF NOT EXISTS (
    SELECT 1 FROM unnest(v_candidates) AS c(user_id)
     WHERE c.user_id = ANY (v_policy.attesters)
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(v_groups) AS g(item), jsonb_array_elements_text(g.item->'attesters') AS a(id)
           WHERE a.id::uuid = c.user_id)
  ) THEN
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

  -- Förattest: who may give it (the groups' attesters, without the
  -- registrant unless allowed, still members), and whose it is this round.
  -- An approval counts as the attester it was given for.
  v_pre_eligible := ARRAY(
    SELECT DISTINCT a.id::uuid
      FROM jsonb_array_elements(v_groups) AS g(item), jsonb_array_elements_text(g.item->'attesters') AS a(id)
     WHERE (v_policy.preparer_may_attest OR a.id::uuid <> v_invoice.user_id) AND a.id::uuid = ANY (v_members));
  v_pre_slots := ARRAY(
    SELECT DISTINCT coalesce(t.on_behalf_of, t.user_id) FROM public.supplier_invoice_attestations t
     WHERE t.company_id = p_company_id AND t.supplier_invoice_id = p_invoice_id
       AND t.decision = 'approved' AND t.stage = 'pre' AND (v_round_start IS NULL OR t.decided_at > v_round_start)
       AND coalesce(t.on_behalf_of, t.user_id) = ANY (v_pre_eligible));
  v_pre_met := public.attest_pre_groups_met(v_groups, v_pre_slots);

  -- eligibleAttesters: the attesters, without the registrant unless allowed,
  -- who are still members whose attest can count, less whoever gave a
  -- förattest this round. Only their approvals (as 'final') count.
  v_eligible := ARRAY(
    SELECT DISTINCT a.user_id FROM unnest(v_policy.attesters) AS a(user_id)
     WHERE (v_policy.preparer_may_attest OR a.user_id <> v_invoice.user_id)
       AND a.user_id = ANY (v_members)
       AND NOT (a.user_id = ANY (v_pre_slots)));
  v_approved := ARRAY(
    SELECT DISTINCT coalesce(t.on_behalf_of, t.user_id) FROM public.supplier_invoice_attestations t
     WHERE t.company_id = p_company_id AND t.supplier_invoice_id = p_invoice_id
       AND t.decision = 'approved' AND t.stage IS DISTINCT FROM 'pre'
       AND (v_round_start IS NULL OR t.decided_at > v_round_start)
       AND coalesce(t.on_behalf_of, t.user_id) = ANY (v_eligible));

  -- Who the step the invoice is at still needs: the eligible attesters of
  -- the groups without a förattest, else the attesters.
  v_stage_set := CASE WHEN v_pre_met THEN v_eligible ELSE ARRAY(
    SELECT DISTINCT a.id::uuid
      FROM jsonb_array_elements(v_groups) AS g(item), jsonb_array_elements_text(g.item->'attesters') AS a(id)
     WHERE a.id::uuid = ANY (v_pre_eligible)
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(g.item->'attesters') AS b(id) WHERE b.id::uuid = ANY (v_pre_slots))) END;
  SELECT c.user_id INTO v_slot
    FROM unnest(v_candidates) WITH ORDINALITY AS c(user_id, n)
   WHERE c.user_id = ANY (v_stage_set) AND NOT (c.user_id = ANY (v_pre_slots || v_approved))
   ORDER BY c.n
   LIMIT 1;
  IF v_slot IS NULL THEN
    IF EXISTS (SELECT 1 FROM unnest(v_candidates) AS c(user_id) WHERE c.user_id = ANY (v_stage_set)) THEN
      RETURN jsonb_build_object('kind', 'refused', 'code', 'ATTEST_ALREADY_GIVEN');
    END IF;
    RETURN jsonb_build_object('kind', 'refused', 'code', 'ATTEST_NOT_ALLOWED', 'reason', 'other_step');
  END IF;
  v_on_behalf_of := CASE WHEN v_slot <> p_user_id THEN v_slot END;

  -- The levels.
  v_levels := v_policy.two_step_from_sek IS NOT NULL OR EXISTS (
    SELECT 1 FROM public.company_attest_limits l
     WHERE l.company_id = p_company_id AND l.scope = 'supplier_invoice' AND l.max_amount_sek IS NOT NULL
       AND l.user_id = ANY (v_policy.attesters));
  v_steps := CASE
    WHEN v_policy.two_step_from_sek IS NOT NULL AND (v_amount IS NULL OR v_amount >= v_policy.two_step_from_sek) THEN 2
    ELSE 1 END;

  IF NOT v_pre_met THEN
    -- A förattest: no limit applies. It completes the policy only when it
    -- gives the last group its förattest and the attest is already there
    -- (attesters given before the förattest was asked for).
    v_eligible_after := ARRAY(SELECT e.user_id FROM unnest(v_eligible) AS e(user_id) WHERE e.user_id <> v_slot);
    v_covering := EXISTS (
      SELECT 1 FROM unnest(v_approved) AS a(user_id)
        LEFT JOIN public.company_attest_limits l
          ON l.company_id = p_company_id AND l.user_id = a.user_id AND l.scope = 'supplier_invoice'
       WHERE l.max_amount_sek IS NULL OR (v_amount IS NOT NULL AND v_amount <= l.max_amount_sek));
    RETURN jsonb_build_object(
      'kind', 'record',
      'satisfies',
        public.attest_pre_groups_met(v_groups, v_pre_slots || v_slot)
        AND cardinality(v_eligible_after) > 0
        AND (v_policy.mode <> 'all' OR NOT EXISTS (SELECT 1 FROM unnest(v_eligible_after) AS e(user_id) WHERE NOT (e.user_id = ANY (v_approved))))
        AND cardinality(v_approved) >= v_steps
        AND v_covering,
      'step', cardinality(v_pre_slots) + cardinality(v_approved) + 1,
      'steps', v_steps,
      'limit_sek', NULL,
      'amount_sek', v_amount,
      'stage', 'pre',
      'on_behalf_of', v_on_behalf_of);
  END IF;

  -- The attest: the limit of the attester the approval counts for.
  SELECT l.max_amount_sek INTO v_limit
    FROM public.company_attest_limits l
   WHERE l.company_id = p_company_id AND l.user_id = v_slot AND l.scope = 'supplier_invoice';
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

  v_after := v_approved || v_slot;
  RETURN jsonb_build_object(
    'kind', 'record',
    'satisfies',
      cardinality(v_eligible) > 0
      AND (v_policy.mode <> 'all' OR NOT EXISTS (SELECT 1 FROM unnest(v_eligible) AS e(user_id) WHERE NOT (e.user_id = ANY (v_after))))
      AND cardinality(v_after) >= v_steps
      AND (v_covering OR v_limit IS NULL OR (v_amount IS NOT NULL AND v_amount <= v_limit)),
    'step', cardinality(v_pre_slots) + cardinality(v_approved) + 1,
    'steps', v_steps,
    'limit_sek', v_applied,
    'amount_sek', v_amount,
    'stage', 'final',
    'on_behalf_of', v_on_behalf_of);
END;
$$;

REVOKE ALL ON FUNCTION public.supplier_invoice_attest_ruling(uuid, uuid, uuid, boolean, numeric) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.supplier_invoice_attest_ruling(uuid, uuid, uuid, boolean, numeric) IS
  'The attest rules for supplier invoices in SQL (who may attest, policy, förattest per project, substitutes, limits, two steps, key cap): what an approval by the user would do. An owner, admin or member attests; a viewer only where the policy names them. Read only; attest_supplier_invoice applies it under the invoice lock. Mirrors deciderRefusal and ruleOnApproval in src/lib/supplier-invoices/attest-service.ts and attest-policy.ts.';

-- The one writer of an approval, as in 20261030140000, recording the step
-- and the attester a substitute acted for.
CREATE OR REPLACE FUNCTION public.attest_supplier_invoice(
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
    (company_id, supplier_invoice_id, user_id, decision, source, step, limit_sek, amount_sek, stage, on_behalf_of, decided_at)
  VALUES (
    p_company_id, p_invoice_id, v_actor, 'approved', v_source,
    CASE WHEN v_record THEN (v_ruling->>'step')::smallint END,
    CASE WHEN v_record THEN round((v_ruling->>'limit_sek')::numeric, 2) END,
    (v_ruling->>'amount_sek')::numeric,
    CASE WHEN v_record THEN v_ruling->>'stage' END,
    CASE WHEN v_record THEN (v_ruling->>'on_behalf_of')::uuid END,
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
    'amount_sek', v_ruling->'amount_sek',
    'stage', v_ruling->'stage',
    'on_behalf_of', v_ruling->'on_behalf_of');
END;
$$;

REVOKE ALL ON FUNCTION public.attest_supplier_invoice(uuid, uuid, uuid, text, boolean, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attest_supplier_invoice(uuid, uuid, uuid, text, boolean, numeric) TO authenticated, service_role;

COMMENT ON FUNCTION public.attest_supplier_invoice(uuid, uuid, uuid, text, boolean, numeric) IS
  'Approve (attest) a supplier invoice: locks it, applies supplier_invoice_attest_ruling, records the approval with its step, stage, the attester a substitute acted for, limit and amount, and sets approved_at when the policy is met (or no policy governs the invoice). A session attests as itself; the service role names the attester, the source and the key it came through.';

-- 6. The policy, its limits and the förattest, saved together ---------------------------
DROP FUNCTION public.save_company_attest_policy(uuid, boolean, numeric, text, uuid[], boolean, numeric, jsonb, uuid);

-- As in 20261030140000, plus p_pre_attesters and p_project_attesters: NULL
-- (or left out) keeps what is saved.
CREATE FUNCTION public.save_company_attest_policy(
  p_company_id uuid,
  p_enabled boolean,
  p_threshold_amount numeric,
  p_mode text,
  p_attesters uuid[],
  p_preparer_may_attest boolean,
  p_two_step_from_sek numeric,
  p_limits jsonb,
  p_updated_by uuid,
  p_pre_attesters uuid[] DEFAULT NULL,
  p_project_attesters jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $$
BEGIN
  INSERT INTO public.company_attest_policies AS p
    (company_id, enabled, threshold_amount, mode, attesters, preparer_may_attest, two_step_from_sek, updated_by,
     pre_attesters, project_attesters)
  VALUES
    (p_company_id, p_enabled, p_threshold_amount, p_mode, p_attesters, p_preparer_may_attest, p_two_step_from_sek, p_updated_by,
     coalesce(p_pre_attesters, '{}'::uuid[]), coalesce(p_project_attesters, '{}'::jsonb))
  ON CONFLICT (company_id) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    threshold_amount = EXCLUDED.threshold_amount,
    mode = EXCLUDED.mode,
    attesters = EXCLUDED.attesters,
    preparer_may_attest = EXCLUDED.preparer_may_attest,
    two_step_from_sek = EXCLUDED.two_step_from_sek,
    updated_by = EXCLUDED.updated_by,
    pre_attesters = coalesce(p_pre_attesters, p.pre_attesters),
    project_attesters = coalesce(p_project_attesters, p.project_attesters);

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

REVOKE ALL ON FUNCTION public.save_company_attest_policy(uuid, boolean, numeric, text, uuid[], boolean, numeric, jsonb, uuid, uuid[], jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_company_attest_policy(uuid, boolean, numeric, text, uuid[], boolean, numeric, jsonb, uuid, uuid[], jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.save_company_attest_policy(uuid, boolean, numeric, text, uuid[], boolean, numeric, jsonb, uuid, uuid[], jsonb) IS
  'Save the attest policy for supplier invoices, its limits per person and its förattest (pre_attesters, project_attesters; NULL keeps them) in one transaction. SECURITY INVOKER: a session is held to the admin-only RLS policies of both tables.';

-- 7. behandlingshistorik reads the substitutes ----------------------------------------------
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
            'contract_revenue_settings', 'company_attest_substitutes'])
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
