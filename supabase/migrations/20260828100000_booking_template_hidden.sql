-- =============================================================================
-- Booking Template Hidden (per-company opt-in hiding of system templates)
-- =============================================================================
--
-- A company can hide system templates (standardmallar) it never uses so they
-- stop cluttering the settings panel and pickers. Stored separately from
-- booking_template_library because system templates are shared globally
-- (is_system = TRUE, company_id NULL): hiding must be a per-company choice,
-- never a mutation of the shared row. Nothing is hidden by default; every row
-- here is an explicit action by a write-role member of that company, and it
-- only affects that company.
--
-- One row per (template_id, company_id). Insert to hide, delete to unhide.

CREATE TABLE IF NOT EXISTS public.booking_template_hidden (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_id     UUID NOT NULL REFERENCES public.booking_template_library(id) ON DELETE CASCADE,
  company_id      UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  hidden_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (template_id, company_id)
);

-- RLS
ALTER TABLE public.booking_template_hidden ENABLE ROW LEVEL SECURITY;

-- Members of a company can see which templates it hides.
DROP POLICY IF EXISTS "bth_select" ON public.booking_template_hidden;
CREATE POLICY "bth_select" ON public.booking_template_hidden
  FOR SELECT USING (
    company_id IN (SELECT public.user_company_ids())
  );

-- Hiding/unhiding is a write action on the ACTIVE company only, gated on the
-- non-viewer role like the other settings writes (see 20260702093000). Only
-- active SYSTEM templates can be hidden: company/team templates have a real
-- delete path, so a hide row for them must not exist even via direct
-- PostgREST calls (the API route checks the same thing).
DROP POLICY IF EXISTS "bth_insert" ON public.booking_template_hidden;
CREATE POLICY "bth_insert" ON public.booking_template_hidden
  FOR INSERT WITH CHECK (
    company_id = current_active_company_id()
    AND current_user_can_write()
    AND EXISTS (
      SELECT 1 FROM public.booking_template_library t
       WHERE t.id = template_id AND t.is_system AND t.is_active
    )
  );

DROP POLICY IF EXISTS "bth_delete" ON public.booking_template_hidden;
CREATE POLICY "bth_delete" ON public.booking_template_hidden
  FOR DELETE USING (
    company_id = current_active_company_id() AND current_user_can_write()
  );

-- No UPDATE policy on purpose: a hide row is insert-or-delete only.

-- Lookup index for the list route: all hidden template ids for a company.
CREATE INDEX IF NOT EXISTS idx_bth_company
  ON public.booking_template_hidden (company_id);

-- Schema reload for PostgREST
NOTIFY pgrst, 'reload schema';
