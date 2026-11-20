-- skatteverket_api_audit_log.auth_mode: which credentials an outbound call ran on.
--
-- 'user'   : a person's own BankID session (the personal OAuth token).
-- 'system' : Accounted's own organisation certificate (CCG), acting as ombud.
-- NULL     : recorded before this column existed.
--
-- Why it is needed: when more than one live company claims an org number,
-- the ombud connection goes to the one company where a member has proven with
-- their own BankID that Skatteverket lets them represent the number. The
-- proof is a skattekonto read for that number that Skatteverket answered on
-- the person's session. Both credential kinds read the skattekonto under the
-- same endpoint label, and a call Accounted makes as ombud is no proof of who
-- owns the number, so the row has to say which one made it.
--
-- The table stays append-only: the immutability triggers are untouched and
-- earlier rows keep NULL (they cannot be updated, and none of them is counted
-- as proof). RLS, grants and the reset guards are unchanged.

ALTER TABLE public.skatteverket_api_audit_log
  ADD COLUMN IF NOT EXISTS auth_mode text
    CHECK (auth_mode IN ('user', 'system'));

COMMENT ON COLUMN public.skatteverket_api_audit_log.auth_mode IS
  'Credentials the call ran on: user (a person''s own BankID session) or system (Accounted''s organisation certificate, as ombud). NULL: recorded before the column existed (2026-11-08).';

-- The ownership-proof lookup: one company, one org number, calls on a
-- person's own session that Skatteverket answered.
CREATE INDEX IF NOT EXISTS idx_skv_audit_user_proof
  ON public.skatteverket_api_audit_log (company_id, ag_registered_id)
  WHERE auth_mode = 'user' AND outcome = 'ok';

NOTIFY pgrst, 'reload schema';
