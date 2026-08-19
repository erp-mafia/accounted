-- Per-user dismissals for degraded-state notices (lib/notices).
--
-- lib/notices aggregates system/integration health (broken bank connections,
-- Skatteverket reconnect, failing cloud backups, expiring PSD2 consents,
-- wrong-account hint) into priority-ordered notices. A user can dismiss one;
-- the dismissal must be server-side and per (company, user) so it works
-- cross-device, unlike the localStorage patterns it replaces.
--
-- notice_id is an opaque text id that embeds a state discriminator
-- (connection id + status, consent expiry, error timestamp): a dismissal
-- hides exactly the state the user saw, and a NEW failure after a fix mints
-- a new id and surfaces again. Rows are therefore never updated in place
-- beyond re-stamping dismissed_at on a repeat dismissal (upsert), and stale
-- rows for states that no longer occur are harmless.

CREATE TABLE IF NOT EXISTS public.notice_dismissals (
  company_id UUID NOT NULL REFERENCES public.companies ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  notice_id TEXT NOT NULL,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, user_id, notice_id)
);

ALTER TABLE public.notice_dismissals ENABLE ROW LEVEL SECURITY;

-- All access is scoped to the user's own rows within their companies:
-- dismissals are personal (a colleague still sees the notice), so even
-- SELECT is bound to auth.uid(), not just company membership.
DROP POLICY IF EXISTS "Users see their own notice dismissals" ON public.notice_dismissals;
CREATE POLICY "Users see their own notice dismissals"
  ON public.notice_dismissals FOR SELECT
  USING (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = auth.uid()
  );

DROP POLICY IF EXISTS "Users insert their own notice dismissals" ON public.notice_dismissals;
CREATE POLICY "Users insert their own notice dismissals"
  ON public.notice_dismissals FOR INSERT
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = auth.uid()
  );

-- Upserts re-stamp dismissed_at on conflict, which needs UPDATE.
DROP POLICY IF EXISTS "Users update their own notice dismissals" ON public.notice_dismissals;
CREATE POLICY "Users update their own notice dismissals"
  ON public.notice_dismissals FOR UPDATE
  USING (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = auth.uid()
  )
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = auth.uid()
  );

DROP POLICY IF EXISTS "Users delete their own notice dismissals" ON public.notice_dismissals;
CREATE POLICY "Users delete their own notice dismissals"
  ON public.notice_dismissals FOR DELETE
  USING (
    company_id IN (SELECT public.user_company_ids())
    AND user_id = auth.uid()
  );

NOTIFY pgrst, 'reload schema';
