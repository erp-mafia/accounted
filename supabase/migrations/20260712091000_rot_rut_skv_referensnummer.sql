-- Rot & rut: record Skatteverkets referensnummer on the payout request.
--
-- The beslutsfil (decision JSON downloaded from Skatteverkets e-tjänst,
-- dev_docs/skatteverket/husavdrag/exempel_beslut.json) identifies each
-- begäran by referensnummer (^\d{11}(-\d+)?$). Storing it on the request
-- gives the import an idempotency key (re-importing the same file is a
-- no-op) and an audit link between our request row and SKV's ärende.

ALTER TABLE public.rot_rut_payout_requests
  ADD COLUMN IF NOT EXISTS skv_referensnummer TEXT NULL;

ALTER TABLE public.rot_rut_payout_requests
  DROP CONSTRAINT IF EXISTS rot_rut_payout_requests_skv_referensnummer_check;
ALTER TABLE public.rot_rut_payout_requests
  ADD CONSTRAINT rot_rut_payout_requests_skv_referensnummer_check
  CHECK (skv_referensnummer IS NULL OR skv_referensnummer ~ '^\d{11}(-\d+)?$') NOT VALID;

ALTER TABLE public.rot_rut_payout_requests
  VALIDATE CONSTRAINT rot_rut_payout_requests_skv_referensnummer_check;

NOTIFY pgrst, 'reload schema';
