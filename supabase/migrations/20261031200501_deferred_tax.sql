-- Uppskjuten skatt in a K3 legal entity (BFNAR 2012:1 kap. 29).
--
-- Why this exists: K3 29.19 requires a deferred tax liability for every
-- taxable temporary difference and a deferred tax asset for every deductible
-- one and for tax losses carried forward (the latter only as far as future
-- taxable profit is convincingly probable, 29.29). In a legal entity the tax
-- in obeskattade reserver stays inside the gross reserve (29.37): no deferred
-- tax is booked on them, and nothing here does (the 2026-08-05 removal of the
-- reserves split stands). Until now the year-end flow booked no deferred tax
-- at all, so a K3 company with a loss carried forward or a building whose
-- book and tax values differ had no way to show it.
--
-- What this migration adds:
--   1. public.deferred_tax_assessments: the user's inputs for one fiscal year
--      (whether the loss carried forward is recognised and why, and any
--      temporary differences the register does not compute). Not posted.
--   2. public.deferred_tax_items: what a posted deferred tax voucher was
--      computed from, per temporary difference (kind, carrying amount, tax
--      value, the difference, the rate, the deferred tax). Written only by
--      commit_deferred_tax in the voucher transaction; the movements the K3
--      note on uppskjuten skatt reads.
--   3. commit_deferred_tax: posts the year's change in deferred tax (8940
--      against 2240 Avsättningar för uppskjutna skatter and 1370 Uppskjuten
--      skattefordran, presented net, K3 29.32) and records the items.
--
-- The 29.29 judgement behind a recognised loss is copied onto its item when
-- the voucher posts: the assessment stays editable while the year is open,
-- the item does not, so the reason behind a posted deferred tax asset can
-- never be overwritten (behandlingshistorik, BFL 5 kap. 11 §).
--
-- Deferred tax belongs to a K3 year (K2 has no kapitel 29). The year's
-- framework is fiscal_period_frameworks (20261028120201), not
-- companies.accounting_framework, which holds the LATEST year's: with the
-- next year elected K3, the current K2 year would otherwise read as K3. Two
-- helpers read it for this and the later K3 migrations (development model,
-- own development, the transition): fiscal_year_framework for a known year,
-- fiscal_framework_on for the year a day falls in.
--
-- pg-test: tests/pg/deferred-tax.pg.test.ts

-- =============================================================================
-- 0. The framework of a fiscal year
-- =============================================================================

-- The year's row; without one (a year created before the per-year table),
-- the company setting, as every reader used before; else K2.
CREATE FUNCTION public.fiscal_year_framework(p_company_id uuid, p_fiscal_period_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT coalesce(
    (SELECT f.framework
       FROM public.fiscal_period_frameworks f
      WHERE f.company_id = p_company_id AND f.fiscal_period_id = p_fiscal_period_id),
    (SELECT c.accounting_framework FROM public.companies c WHERE c.id = p_company_id),
    'k2'
  )
$function$;

-- The framework of the year a day falls in; outside every year, the year
-- running today (Stockholm), else the latest year started, else the
-- earliest: the rule of resolveCurrentAccountingFramework.
CREATE FUNCTION public.fiscal_framework_on(p_company_id uuid, p_day date)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.fiscal_year_framework(
    p_company_id,
    coalesce(
      (SELECT p.id FROM public.fiscal_periods p
        WHERE p.company_id = p_company_id AND p_day BETWEEN p.period_start AND p.period_end
        ORDER BY p.period_start LIMIT 1),
      (SELECT p.id FROM public.fiscal_periods p
        WHERE p.company_id = p_company_id
          AND (now() AT TIME ZONE 'Europe/Stockholm')::date BETWEEN p.period_start AND p.period_end
        ORDER BY p.period_start LIMIT 1),
      (SELECT p.id FROM public.fiscal_periods p
        WHERE p.company_id = p_company_id AND p.period_start <= (now() AT TIME ZONE 'Europe/Stockholm')::date
        ORDER BY p.period_start DESC LIMIT 1),
      (SELECT p.id FROM public.fiscal_periods p
        WHERE p.company_id = p_company_id
        ORDER BY p.period_start LIMIT 1)
    )
  )
$function$;

REVOKE ALL ON FUNCTION public.fiscal_year_framework(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fiscal_framework_on(uuid, date) FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 1. deferred_tax_assessments
-- =============================================================================

CREATE TABLE public.deferred_tax_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  -- K3 29.29: a deferred tax asset on a loss carried forward only when it is
  -- convincingly probable that taxable profit will absorb it; the reason is
  -- the documentation of that judgement.
  loss_recognised boolean NOT NULL DEFAULT false,
  loss_reason text CHECK (loss_reason IS NULL OR length(loss_reason) <= 2000),
  -- Temporary differences the register does not compute:
  -- [{label, kind: 'asset'|'liability', carrying_amount, tax_value}].
  manual_items jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(manual_items) = 'array' AND jsonb_array_length(manual_items) <= 100),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deferred_tax_assessments_period_unique UNIQUE (company_id, fiscal_period_id),
  CONSTRAINT deferred_tax_assessments_loss_reason CHECK (
    NOT loss_recognised OR length(btrim(coalesce(loss_reason, ''))) > 0
  )
);

COMMENT ON TABLE public.deferred_tax_assessments IS
  'Inputs to the K3 deferred tax calculation for one fiscal year (BFNAR 2012:1 kap. 29): whether a tax loss carried forward is recognised (29.29) and why, and temporary differences entered by hand. Never posted itself; commit_deferred_tax records what was posted.';

CREATE INDEX idx_deferred_tax_assessments_period ON public.deferred_tax_assessments (fiscal_period_id);

ALTER TABLE public.deferred_tax_assessments ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.deferred_tax_assessments TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.deferred_tax_assessments TO authenticated;

CREATE POLICY deferred_tax_assessments_select ON public.deferred_tax_assessments
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY deferred_tax_assessments_insert ON public.deferred_tax_assessments
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY deferred_tax_assessments_update ON public.deferred_tax_assessments
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER deferred_tax_assessments_updated_at
  BEFORE UPDATE ON public.deferred_tax_assessments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.deferred_tax_assessments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

CREATE TRIGGER deferred_tax_assessments_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.deferred_tax_assessments
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

-- =============================================================================
-- 2. deferred_tax_items
-- =============================================================================

CREATE TABLE public.deferred_tax_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- CASCADE only for the tenant teardown: a posted voucher and its fiscal
  -- year are never deleted otherwise (retention triggers), and the guard
  -- below refuses a direct delete.
  fiscal_period_id uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  -- loss_carryforward: underskottsavdrag (29.19 c); building: a building's
  -- book and tax values (IL 19 kap.); manual: entered by hand.
  kind text NOT NULL CHECK (kind IN ('loss_carryforward', 'building', 'manual')),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  carrying_amount numeric(15, 2) NOT NULL,
  tax_value numeric(15, 2) NOT NULL,
  -- Positive: taxable (a liability); negative: deductible (an asset), 29.14.
  temporary_difference numeric(15, 2) NOT NULL,
  tax_rate numeric(6, 5) NOT NULL CHECK (tax_rate > 0 AND tax_rate < 1),
  -- The deferred tax on this difference at the balansdag: positive a
  -- liability, negative an asset.
  deferred_tax numeric(15, 2) NOT NULL,
  -- K3 29.29: why a recognised loss carried forward is expected to be used,
  -- as the assessment said when the voucher posted.
  reason text CHECK (reason IS NULL OR length(reason) <= 2000),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deferred_tax_items_loss_reason CHECK (
    kind <> 'loss_carryforward' OR length(btrim(coalesce(reason, ''))) > 0
  )
);

COMMENT ON TABLE public.deferred_tax_items IS
  'The temporary differences a posted deferred tax voucher was computed from (K3 29.14-29.25), one row each, with the deferred tax at the balansdag. Written only by commit_deferred_tax in the voucher transaction; immutable.';

CREATE INDEX idx_deferred_tax_items_company ON public.deferred_tax_items (company_id);
CREATE INDEX idx_deferred_tax_items_period ON public.deferred_tax_items (fiscal_period_id);
CREATE INDEX idx_deferred_tax_items_entry ON public.deferred_tax_items (journal_entry_id);

ALTER TABLE public.deferred_tax_items ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.deferred_tax_items TO service_role;
-- Read-only to sessions: commit_deferred_tax (SECURITY DEFINER) is the only writer.
GRANT SELECT ON TABLE public.deferred_tax_items TO authenticated;

CREATE POLICY deferred_tax_items_select ON public.deferred_tax_items
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER deferred_tax_items_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.deferred_tax_items
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

CREATE FUNCTION public.guard_deferred_tax_items()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'A deferred tax item is never updated: reverse its voucher (storno) and post again'
      USING ERRCODE = '23514';
  END IF;
  -- Tenant teardown removes the items with the verifikat.
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Cannot delete a posted deferred tax item (id=%)', OLD.id
    USING ERRCODE = '23514',
          HINT = 'Reverse the voucher (storno). The item is räkenskapsinformation (BFL 7 kap.).';
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_deferred_tax_items() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER guard_deferred_tax_items
  BEFORE UPDATE OR DELETE ON public.deferred_tax_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_deferred_tax_items();

-- =============================================================================
-- 3. commit_deferred_tax
-- =============================================================================
-- Posts the change in deferred tax for a fiscal year and records the items it
-- was computed from, in one transaction. The voucher, built by the year-end
-- service, books only 8940 Uppskjuten skatt, 2240 and 1370; the RPC pins it:
--   * a year_end draft of this company and fiscal year, dated its last day,
--     in an open year behind no lock date;
--   * no other account on it, and its net change on 2240 less 1370 equals
--     p_change (the caller's closing deferred tax less what the ledger held);
--   * the items' deferred tax sums to p_closing, and a recognised loss
--     carries its 29.29 reason;
--   * one deferred tax posting per year, read off the vouchers themselves
--     (a posting with no items still counts): a later one needs the earlier
--     voucher reversed first.

CREATE FUNCTION public.commit_deferred_tax(
  p_company_id uuid,
  p_entry_id uuid,
  p_fiscal_period_id uuid,
  p_closing numeric,
  p_change numeric,
  p_items jsonb,
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
  v_other_accounts integer;
  v_net_change numeric;
  v_items_sum numeric;
  v_voucher_number integer;
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated')
     AND (
       NOT public.caller_is_company_member(p_company_id)
       OR NOT public.current_user_can_write()
     ) THEN
    RAISE EXCEPTION 'unauthorized deferred tax posting for company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'Deferred tax items must be an array' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_items) AS e(v)
     WHERE jsonb_typeof(e.v) <> 'object'
        OR coalesce(e.v ->> 'kind', '') NOT IN ('loss_carryforward', 'building', 'manual')
        OR length(btrim(coalesce(e.v ->> 'label', ''))) = 0
        OR jsonb_typeof(e.v -> 'carrying_amount') <> 'number'
        OR jsonb_typeof(e.v -> 'tax_value') <> 'number'
        OR jsonb_typeof(e.v -> 'temporary_difference') <> 'number'
        OR jsonb_typeof(e.v -> 'tax_rate') <> 'number'
        OR jsonb_typeof(e.v -> 'deferred_tax') <> 'number'
        OR (e.v ? 'reason' AND jsonb_typeof(e.v -> 'reason') NOT IN ('string', 'null'))
  ) THEN
    RAISE EXCEPTION 'Invalid deferred tax item' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_items) AS e(v)
     WHERE e.v ->> 'kind' = 'loss_carryforward'
       AND length(btrim(coalesce(e.v ->> 'reason', ''))) = 0
  ) THEN
    RAISE EXCEPTION 'A recognised loss carried forward needs its reason (K3 29.29)' USING ERRCODE = '22023';
  END IF;

  -- Serialises deferred tax postings of one company like every other posting.
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
    RAISE EXCEPTION 'Cannot post deferred tax in a locked or closed fiscal period'
      USING ERRCODE = '23514';
  END IF;

  -- K3 years only: K2 has no kapitel 29, and the year decides, not the
  -- company's latest framework.
  IF public.fiscal_year_framework(p_company_id, p_fiscal_period_id) IS DISTINCT FROM 'k3' THEN
    RAISE EXCEPTION 'DEFERRED_TAX_NOT_APPLICABLE' USING ERRCODE = 'PT409',
      HINT = 'Deferred tax is booked only in a fiscal year reported under K3.';
  END IF;

  SELECT cs.bookkeeping_locked_through
    INTO v_company_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF v_company_lock_date IS NOT NULL AND v_period_end <= v_company_lock_date THEN
    RAISE EXCEPTION 'Bookkeeping is locked through %', v_company_lock_date
      USING ERRCODE = '23514';
  END IF;

  -- A posted deferred tax voucher of the year: a year_end voucher that books
  -- only 8940, 2240 and 1370, the shape checked below. Read off the voucher,
  -- not the items: a posting whose closing deferred tax is zero has none.
  IF EXISTS (
    SELECT 1
      FROM public.journal_entries je
     WHERE je.company_id = p_company_id
       AND je.fiscal_period_id = p_fiscal_period_id
       AND je.status = 'posted'
       AND je.source_type = 'year_end'
       AND EXISTS (
         SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_entry_id = je.id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.journal_entry_lines l
          WHERE l.journal_entry_id = je.id
            AND l.account_number NOT IN ('8940', '2240', '1370')
       )
  ) THEN
    RAISE EXCEPTION 'DEFERRED_TAX_ALREADY_POSTED' USING ERRCODE = 'PT409';
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
    RAISE EXCEPTION 'Valid deferred tax draft not found: %', p_entry_id USING ERRCODE = '22023';
  END IF;

  SELECT count(*) FILTER (WHERE l.account_number NOT IN ('8940', '2240', '1370')),
         coalesce(sum(l.credit_amount - l.debit_amount) FILTER (WHERE l.account_number = '2240'), 0)
           - coalesce(sum(l.debit_amount - l.credit_amount) FILTER (WHERE l.account_number = '1370'), 0)
    INTO v_other_accounts, v_net_change
    FROM public.journal_entry_lines l
   WHERE l.journal_entry_id = p_entry_id;

  IF v_other_accounts > 0 OR abs(v_net_change - coalesce(p_change, 0)) > 0.005 THEN
    RAISE EXCEPTION 'The draft voucher does not book the deferred tax change % on 8940, 2240 and 1370', p_change
      USING ERRCODE = '23514';
  END IF;

  SELECT coalesce(sum((e.v ->> 'deferred_tax')::numeric), 0)
    INTO v_items_sum
    FROM jsonb_array_elements(p_items) AS e(v);

  IF abs(v_items_sum - coalesce(p_closing, 0)) > 0.005 THEN
    RAISE EXCEPTION 'Deferred tax items % do not sum to the closing deferred tax %', v_items_sum, p_closing
      USING ERRCODE = '23514';
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

  INSERT INTO public.deferred_tax_items (
    company_id, fiscal_period_id, journal_entry_id, kind, label, carrying_amount,
    tax_value, temporary_difference, tax_rate, deferred_tax, reason, sort_order
  )
  SELECT p_company_id, p_fiscal_period_id, p_entry_id, e.v ->> 'kind', btrim(e.v ->> 'label'),
         (e.v ->> 'carrying_amount')::numeric, (e.v ->> 'tax_value')::numeric,
         (e.v ->> 'temporary_difference')::numeric, (e.v ->> 'tax_rate')::numeric,
         (e.v ->> 'deferred_tax')::numeric, nullif(btrim(e.v ->> 'reason'), ''), (e.ord - 1)::integer
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS e(v, ord);

  RETURN QUERY SELECT v_voucher_number;
END;
$function$;

REVOKE ALL ON FUNCTION public.commit_deferred_tax(uuid, uuid, uuid, numeric, numeric, jsonb, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commit_deferred_tax(uuid, uuid, uuid, numeric, numeric, jsonb, text, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.commit_deferred_tax(uuid, uuid, uuid, numeric, numeric, jsonb, text, text) IS
  'Atomically posts the year''s change in uppskjuten skatt (8940 against 2240/1370, K3 kap. 29) and records the temporary differences it was computed from in deferred_tax_items. Voucher numbering is delegated to commit_journal_entry.';

NOTIFY pgrst, 'reload schema';
