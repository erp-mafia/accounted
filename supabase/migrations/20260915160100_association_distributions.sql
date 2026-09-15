-- =============================================================================
-- Värdeöverföringar from an ekonomisk förening to its members (design section
-- 5, "association_distributions" and "association_distribution_allocations").
--
-- EFL (2018:672) 12 kap. governs value transfers: 12 kap. 1 § names the forms
-- (vinstutdelning, gottgörelse, ...), 12 kap. 2-3 §§ the beloppsspärr (full
-- coverage of bundet eget kapital after the transfer) and the
-- försiktighetsregel; 13 kap. puts the decision on vinstutdelning with the
-- föreningsstämma on the board's proposal. IL 39 kap. 22-23 §§ let a
-- kooperativ förening deduct gottgörelse given in proportion to purchases or
-- sales (efterlikvid, återbäring) and utdelning in proportion to paid
-- insatser.
--
-- Three kinds:
--   insats_dividend    utdelning på medlemsinsatser (EFL 13 kap.), booked from
--                      fritt eget kapital: Dr 2091 / Cr 2898 on the decision.
--   forlags_dividend   utdelning på förlagsinsatser (EFL 11 kap.), same posting.
--   cooperative_rebate gottgörelse / efterlikvid / återbäring (IL 39 kap. 22 §),
--                      a cost: Dr 8840 Lämnade gottgörelser / Cr 2890.
--
-- Two tables, company-scoped and RLS-protected like the member register
-- (20260915160000): the decision row and its allocations per member. The
-- ledger is written by the bookkeeping engine (lib/associations/distributions),
-- never here; the rows link to the verifikat that booked the decision and the
-- payment. No DELETE policy or grant: a decided transfer is history. A trigger
-- keeps the allocations equal to the total once the row leaves 'decided' and
-- freezes them after that.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.association_distributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('insats_dividend', 'forlags_dividend', 'cooperative_rebate')),
  -- The fiscal year whose result the decision disposes of (the beloppsspärr
  -- is measured against its adopted balance sheet).
  fiscal_period_id UUID NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  decision_date DATE NOT NULL,
  decided_by TEXT NOT NULL CHECK (decided_by IN ('stamma', 'board')),
  -- Protokoll reference (stämma date and §), free text.
  decision_reference TEXT CHECK (decision_reference IS NULL OR char_length(decision_reference) <= 200),
  allocation_basis TEXT NOT NULL CHECK (allocation_basis IN ('contributions', 'turnover', 'custom')),
  total_amount NUMERIC(15, 2) NOT NULL CHECK (total_amount > 0),
  status TEXT NOT NULL DEFAULT 'decided' CHECK (status IN ('decided', 'booked', 'paid')),
  journal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  payment_journal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A booked row carries its decision verifikat, a paid row both.
  CONSTRAINT association_distributions_status_entries CHECK (
    (status = 'decided')
    OR (status = 'booked' AND journal_entry_id IS NOT NULL)
    OR (status = 'paid' AND journal_entry_id IS NOT NULL AND payment_journal_entry_id IS NOT NULL)
  )
);

COMMENT ON TABLE public.association_distributions IS
  'Värdeöverföringar till medlemmar i en ekonomisk förening (EFL 12-13 kap.): vinstutdelning på insatser/förlagsinsatser och gottgörelse. Decision, verifikat links and status; never deleted.';

CREATE INDEX IF NOT EXISTS idx_association_distributions_company
  ON public.association_distributions (company_id, fiscal_period_id, status);

CREATE TABLE IF NOT EXISTS public.association_distribution_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  distribution_id UUID NOT NULL REFERENCES public.association_distributions(id) ON DELETE RESTRICT,
  member_id UUID NOT NULL REFERENCES public.association_members(id) ON DELETE RESTRICT,
  -- The member's share of the basis (paid insatser, turnover with the
  -- förening, or a custom figure); informational once the amount is set.
  basis_value NUMERIC(15, 2) NOT NULL CHECK (basis_value >= 0),
  amount NUMERIC(15, 2) NOT NULL CHECK (amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT association_distribution_allocations_one_per_member UNIQUE (distribution_id, member_id)
);

COMMENT ON TABLE public.association_distribution_allocations IS
  'Fördelning av en värdeöverföring per medlem: basis and amount. Frozen once the distribution is booked.';

CREATE INDEX IF NOT EXISTS idx_association_distribution_allocations_distribution
  ON public.association_distribution_allocations (distribution_id);
CREATE INDEX IF NOT EXISTS idx_association_distribution_allocations_member
  ON public.association_distribution_allocations (member_id);

DROP TRIGGER IF EXISTS association_distributions_updated_at ON public.association_distributions;
CREATE TRIGGER association_distributions_updated_at
  BEFORE UPDATE ON public.association_distributions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS association_distribution_allocations_updated_at ON public.association_distribution_allocations;
CREATE TRIGGER association_distribution_allocations_updated_at
  BEFORE UPDATE ON public.association_distribution_allocations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- -----------------------------------------------------------------------------
-- Integrity: the allocations must add up to the decided total before the row
-- can be booked (the verifikat carries the total, the allocations say who gets
-- what), and neither the total nor the allocations may change afterwards.
-- The amounts are compared in öre, so a plan produced by the application's
-- rounding (residual on the largest allocation) passes exactly.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.association_distribution_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_allocated NUMERIC(15, 2);
BEGIN
  IF OLD.status = 'decided' AND NEW.status <> 'decided' THEN
    SELECT COALESCE(SUM(amount), 0) INTO v_allocated
    FROM public.association_distribution_allocations
    WHERE distribution_id = NEW.id;
    IF v_allocated <> NEW.total_amount THEN
      RAISE EXCEPTION 'ASSOCIATION_DISTRIBUTION_ALLOCATIONS_MISMATCH: allocated % does not equal total %',
        v_allocated, NEW.total_amount
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD.status <> 'decided' THEN
    IF NEW.total_amount <> OLD.total_amount OR NEW.kind <> OLD.kind
       OR NEW.fiscal_period_id <> OLD.fiscal_period_id OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
      RAISE EXCEPTION 'ASSOCIATION_DISTRIBUTION_FROZEN: a booked distribution cannot change amount, kind, period or decision verifikat'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'decided' THEN
      RAISE EXCEPTION 'ASSOCIATION_DISTRIBUTION_FROZEN: a booked distribution cannot return to decided'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS association_distributions_guard ON public.association_distributions;
CREATE TRIGGER association_distributions_guard
  BEFORE UPDATE ON public.association_distributions
  FOR EACH ROW EXECUTE FUNCTION public.association_distribution_guard();

CREATE OR REPLACE FUNCTION public.association_distribution_allocation_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
  v_company UUID;
BEGIN
  SELECT status, company_id INTO v_status, v_company
  FROM public.association_distributions
  WHERE id = NEW.distribution_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'ASSOCIATION_DISTRIBUTION_NOT_FOUND' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_status <> 'decided' THEN
    RAISE EXCEPTION 'ASSOCIATION_DISTRIBUTION_FROZEN: allocations cannot change once the distribution is booked'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_company <> NEW.company_id THEN
    RAISE EXCEPTION 'ASSOCIATION_DISTRIBUTION_COMPANY_MISMATCH' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS association_distribution_allocations_guard ON public.association_distribution_allocations;
CREATE TRIGGER association_distribution_allocations_guard
  BEFORE INSERT OR UPDATE ON public.association_distribution_allocations
  FOR EACH ROW EXECUTE FUNCTION public.association_distribution_allocation_guard();

ALTER TABLE public.association_distributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.association_distribution_allocations ENABLE ROW LEVEL SECURITY;

-- Every company member reads; owners, admins and members write as themselves;
-- the routes add requireWrite on top. No DELETE policy on either table.
DROP POLICY IF EXISTS "association_distributions_select" ON public.association_distributions;
CREATE POLICY "association_distributions_select" ON public.association_distributions
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "association_distributions_insert" ON public.association_distributions;
CREATE POLICY "association_distributions_insert" ON public.association_distributions
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')
    )
  );
DROP POLICY IF EXISTS "association_distributions_update" ON public.association_distributions;
CREATE POLICY "association_distributions_update" ON public.association_distributions
  FOR UPDATE USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS "association_distribution_allocations_select" ON public.association_distribution_allocations;
CREATE POLICY "association_distribution_allocations_select" ON public.association_distribution_allocations
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "association_distribution_allocations_insert" ON public.association_distribution_allocations;
CREATE POLICY "association_distribution_allocations_insert" ON public.association_distribution_allocations
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')
    )
  );
DROP POLICY IF EXISTS "association_distribution_allocations_update" ON public.association_distribution_allocations;
CREATE POLICY "association_distribution_allocations_update" ON public.association_distribution_allocations
  FOR UPDATE USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')
    )
  );

REVOKE DELETE ON TABLE public.association_distributions FROM anon, authenticated;
REVOKE DELETE ON TABLE public.association_distribution_allocations FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
