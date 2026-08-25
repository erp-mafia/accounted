-- The bokslut checklist per räkenskapsår: which closing steps are done, by
-- whom and when, with a note. Reko 140/760 want the konsult's bokslutsarbete
-- documented step by step; the wizard's own steps were client state that
-- vanished on reload, so nothing recorded that the inventory was counted or
-- the doubtful receivables reviewed.
--
-- The item catalogue lives in code (lib/bokslut/checklist.ts): the row is the
-- state of one catalogue item for one period. Items the system can evaluate
-- itself (drafts left, trial balance, sign-offs through balansdagen) are
-- computed live; a row only overrides them (e.g. marking a step not
-- applicable) or records the manual ones. Mutable by design: a step can be
-- unticked when a late verifikat reopens it. The trail of who last touched a
-- row is kept on the row; the archive dumps the table as documentation.

CREATE TABLE IF NOT EXISTS public.bokslut_checklist_items (
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id UUID NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  -- Catalogue key (lib/bokslut/checklist.ts); constrained by shape so a typo cannot create a phantom step.
  item_key TEXT NOT NULL CHECK (item_key ~ '^[a-z0-9_]{1,64}$'),
  state TEXT NOT NULL CHECK (state IN ('open', 'done', 'not_applicable')),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  -- Who marked it done / not applicable and when; cleared when reopened.
  done_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  done_at TIMESTAMPTZ,
  updated_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, fiscal_period_id, item_key),
  CONSTRAINT bokslut_checklist_items_done_pair
    CHECK ((state = 'open' AND done_at IS NULL) OR (state <> 'open' AND done_at IS NOT NULL))
);

COMMENT ON TABLE public.bokslut_checklist_items IS
  'State of one bokslut checklist item (lib/bokslut/checklist.ts) for one fiscal period: open / done / not_applicable with note and who/when.';

ALTER TABLE public.bokslut_checklist_items ENABLE ROW LEVEL SECURITY;

-- Members read the checklist; owners, admins and members tick it as
-- themselves (updated_by = auth.uid()); viewers look but do not touch. No
-- DELETE policy: a step is reopened, never erased.
DROP POLICY IF EXISTS "bokslut_checklist_items_select" ON public.bokslut_checklist_items;
CREATE POLICY "bokslut_checklist_items_select" ON public.bokslut_checklist_items
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

DROP POLICY IF EXISTS "bokslut_checklist_items_insert" ON public.bokslut_checklist_items;
CREATE POLICY "bokslut_checklist_items_insert" ON public.bokslut_checklist_items
  FOR INSERT WITH CHECK (
    updated_by = auth.uid()
    AND company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS "bokslut_checklist_items_update" ON public.bokslut_checklist_items;
CREATE POLICY "bokslut_checklist_items_update" ON public.bokslut_checklist_items
  FOR UPDATE USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    updated_by = auth.uid()
    AND company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin', 'member')
    )
  );

NOTIFY pgrst, 'reload schema';
