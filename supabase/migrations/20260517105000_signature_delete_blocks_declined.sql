-- A 'declined' signature is auditable evidence: it records that a board
-- member refused to sign the årsredovisning, which is material under ABL 8
-- kap (board-member liability) and may be relevant in a Bolagsverket review.
-- The original migration (20260516170000) only blocked DELETE on 'signed'
-- rows. Extend the DELETE RLS policy to also protect 'declined' so the
-- evidence trail can't be silently wiped.

DROP POLICY IF EXISTS "arsredovisning_sigreq_delete" ON public.arsredovisning_signature_requests;

CREATE POLICY "arsredovisning_sigreq_delete" ON public.arsredovisning_signature_requests
  FOR DELETE USING (
    company_id IN (SELECT public.user_company_ids())
    AND status NOT IN ('signed', 'declined')
  );

NOTIFY pgrst, 'reload schema';
