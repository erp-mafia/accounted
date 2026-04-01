-- Voucher gap explanations table (BFNAR 2013:2 punkt 5.8)
-- Stores documented reasons for missing verifikationsnummer.
-- Unexplained gaps block year-end closing.
CREATE TABLE public.voucher_gap_explanations (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fiscal_period_id uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  voucher_series   text NOT NULL DEFAULT 'A',
  gap_start        integer NOT NULL,
  gap_end          integer NOT NULL,
  explanation      text NOT NULL CHECK (char_length(explanation) <= 500),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (company_id, fiscal_period_id, voucher_series, gap_start, gap_end)
);

ALTER TABLE public.voucher_gap_explanations ENABLE ROW LEVEL SECURITY;

-- SELECT: any company member can read explanations
CREATE POLICY "voucher_gap_explanations_select"
  ON public.voucher_gap_explanations FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

-- INSERT: only owner/admin can create explanations (bokföringsansvarig)
CREATE POLICY "voucher_gap_explanations_insert"
  ON public.voucher_gap_explanations FOR INSERT
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND EXISTS (
      SELECT 1 FROM public.team_members tm
      JOIN public.companies c ON c.team_id = tm.team_id
      WHERE c.id = company_id
        AND tm.user_id = auth.uid()
        AND tm.role IN ('owner', 'admin')
    )
  );

-- UPDATE: only owner/admin can update explanations
CREATE POLICY "voucher_gap_explanations_update"
  ON public.voucher_gap_explanations FOR UPDATE
  USING (
    company_id IN (SELECT public.user_company_ids())
    AND EXISTS (
      SELECT 1 FROM public.team_members tm
      JOIN public.companies c ON c.team_id = tm.team_id
      WHERE c.id = company_id
        AND tm.user_id = auth.uid()
        AND tm.role IN ('owner', 'admin')
    )
  );

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.voucher_gap_explanations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
