-- A viewer the attest policy names attests supplier invoices (crm#1569).
--
-- A byrå keeps the books and the client says yes or no to paying. Until now
-- an attester had to keep the books (owner, admin, member), so a client who
-- only reads them had to be given write access to attest. Now a viewer
-- (Läsbehörighet) whom company_attest_policies.attesters names counts as an
-- attester wherever the policy governs the invoice: the approval is recorded
-- and counts toward the policy like anyone else's, limits and two steps
-- included. Nothing else changes for a viewer: an invoice no policy governs
-- is still the one click by someone who keeps the books, so a viewer is
-- refused there (FORBIDDEN, reason read_only), and a viewer the policy does
-- not name is refused as before (ATTEST_NOT_ALLOWED, not_attester).
--
-- supplier_invoice_attest_ruling as in 20261030140000, but for the roles:
-- v_members (owner, admin, member, viewer) decides who may attest at all and
-- who of the policy's attesters is eligible; v_writers (owner, admin,
-- member) is kept for the invoice no policy governs. attest_supplier_invoice
-- calls it unchanged. The application holds the same rule in
-- src/lib/auth/invoicer-role.ts (isAttestRole) and the attest service
-- (deciderRefusal); tests/pg/supplier-invoice-attest-levels.pg.test.ts proves
-- the two agree.
--
-- pg-test: tests/pg/supplier-invoice-attest-levels.pg.test.ts

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
  -- who are still members whose attest can count. Only their approvals count.
  v_eligible := ARRAY(
    SELECT DISTINCT a.user_id FROM unnest(v_policy.attesters) AS a(user_id)
     WHERE (v_policy.preparer_may_attest OR a.user_id <> v_invoice.user_id)
       AND a.user_id = ANY (v_members));
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
  'The attest rules for supplier invoices in SQL (who may attest, policy, limits, two steps, key cap): what an approval by the user would do. An owner, admin or member attests; a viewer only where the policy names them. Read only; attest_supplier_invoice applies it under the invoice lock. Mirrors deciderRefusal and ruleOnApproval in src/lib/supplier-invoices/attest-service.ts and attest-policy.ts.';
