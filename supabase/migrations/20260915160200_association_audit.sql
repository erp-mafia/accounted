-- =============================================================================
-- Audit workflow for an ekonomisk förening (EFL 2018:672 8 kap.).
--
-- 8 kap. 1 §: an ekonomisk förening has at least one revisor. 8 kap. 14 §: at
-- least one auktoriserad revisor when the association meets at least two of
-- three size conditions in each of the two latest financial years (more than
-- 50 employees on average, balance sheet total above 40 MSEK, net turnover
-- above 80 MSEK); Bolagsverket may allow a named godkänd revisor instead.
-- 8 kap. 16 §: an auktoriserad or godkänd revisor whenever a tenth of the
-- voting members demand it. 8 kap. 24 §: the term runs to the end of the
-- first årsstämma after the year of appointment unless the stadgar say
-- otherwise, and ends at the latest at the årsstämma held in the fourth
-- financial year after the appointment. 8 kap. 32-33 §§: the revisions-
-- berättelse is delivered to the board at least three weeks before the
-- årsstämma, signed, and states the day the audit was completed.
--
-- Accounted does not write the auditor's opinion. It keeps the dependency:
--   association_auditors: who the revisor is, the qualification the law
--     cares about, when the term began and ends. Company-scoped, RLS like
--     the member register, no DELETE policy or grant: an ended term is a
--     date (ended_on), so the roster the stämma once elected stays readable.
--   annual_report_profiles: four nullable columns that archive the externally
--     signed report for the period (signed date, opinion, deviations, the
--     WORM document it was uploaded as). The filing package stays blocked
--     until they are filled (lib/bokslut/arsredovisning/audit-dependency.ts).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.association_auditors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  -- lekmannarevisor: a member or other person without professional
  -- qualification (allowed unless 8 kap. 14-17 §§ apply); godkand_revisor
  -- and auktoriserad_revisor per revisorslagen (2001:883); revisionsbolag: a
  -- registered audit firm (8 kap. 21 §) with the responsible auditor named.
  kind TEXT NOT NULL CHECK (
    kind IN ('lekmannarevisor', 'godkand_revisor', 'auktoriserad_revisor', 'revisionsbolag')
  ),
  -- Revisorsinspektionen registration number, or the audit firm's org.nr.
  registration_reference TEXT CHECK (
    registration_reference IS NULL OR char_length(registration_reference) <= 60
  ),
  appointed_on DATE NOT NULL,
  -- The stämma that ends the term (8 kap. 24 §); NULL when the stadgar leave
  -- it to the default (the first årsstämma after the year of appointment).
  term_ends_on DATE CHECK (term_ends_on IS NULL OR term_ends_on >= appointed_on),
  -- Stämmoprotokoll § or Bolagsverket decision that appointed the revisor.
  appointment_reference TEXT CHECK (
    appointment_reference IS NULL OR char_length(appointment_reference) <= 200
  ),
  -- The date the assignment actually ended (end of term, 8 kap. 25 § early
  -- departure or dismissal). NULL while the revisor serves.
  ended_on DATE CHECK (ended_on IS NULL OR ended_on >= appointed_on),
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.association_auditors IS
  'Revisorer i en ekonomisk förening (EFL 8 kap.): name, qualification, term. An ended assignment is dated, never deleted.';

CREATE INDEX IF NOT EXISTS idx_association_auditors_company
  ON public.association_auditors (company_id, ended_on, appointed_on);

DROP TRIGGER IF EXISTS association_auditors_updated_at ON public.association_auditors;
CREATE TRIGGER association_auditors_updated_at
  BEFORE UPDATE ON public.association_auditors
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.association_auditors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "association_auditors_select" ON public.association_auditors;
CREATE POLICY "association_auditors_select" ON public.association_auditors
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "association_auditors_insert" ON public.association_auditors;
CREATE POLICY "association_auditors_insert" ON public.association_auditors
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')
    )
  );
DROP POLICY IF EXISTS "association_auditors_update" ON public.association_auditors;
CREATE POLICY "association_auditors_update" ON public.association_auditors
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

-- No DELETE policy, and no grant a policy could later be written for.
REVOKE DELETE ON TABLE public.association_auditors FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- The signed revisionsberättelse for a period (8 kap. 33 §): archived on the
-- period's compliance profile. All nullable: an aktiebolag without a revisor
-- never fills them, and an unanswered field is not an answer.
-- -----------------------------------------------------------------------------
ALTER TABLE public.annual_report_profiles
  ADD COLUMN IF NOT EXISTS auditor_report_signed_on DATE,
  ADD COLUMN IF NOT EXISTS auditor_report_opinion TEXT,
  ADD COLUMN IF NOT EXISTS auditor_report_deviations TEXT,
  ADD COLUMN IF NOT EXISTS auditor_report_document_id UUID
    REFERENCES public.document_attachments(id) ON DELETE SET NULL;

ALTER TABLE public.annual_report_profiles
  DROP CONSTRAINT IF EXISTS annual_report_profiles_auditor_report_opinion_check;
-- Added NOT VALID: no existing row carries an opinion, and the swap must not
-- scan the table under ACCESS EXCLUSIVE on a live deploy.
ALTER TABLE public.annual_report_profiles
  ADD CONSTRAINT annual_report_profiles_auditor_report_opinion_check
  CHECK (
    auditor_report_opinion IS NULL
    OR auditor_report_opinion IN ('unmodified', 'qualified', 'adverse', 'disclaimer')
  )
  NOT VALID;

ALTER TABLE public.annual_report_profiles
  DROP CONSTRAINT IF EXISTS annual_report_profiles_auditor_report_deviations_length;
ALTER TABLE public.annual_report_profiles
  ADD CONSTRAINT annual_report_profiles_auditor_report_deviations_length
  CHECK (auditor_report_deviations IS NULL OR char_length(auditor_report_deviations) <= 4000)
  NOT VALID;

COMMENT ON COLUMN public.annual_report_profiles.auditor_report_signed_on IS
  'Date the revisionsberättelse was signed (EFL 8 kap. 33 §); NULL until the signed report is archived.';
COMMENT ON COLUMN public.annual_report_profiles.auditor_report_opinion IS
  'Opinion in the archived revisionsberättelse: unmodified, qualified, adverse or disclaimer.';
COMMENT ON COLUMN public.annual_report_profiles.auditor_report_document_id IS
  'The WORM document_attachments row holding the signed revisionsberättelse.';

NOTIFY pgrst, 'reload schema';
