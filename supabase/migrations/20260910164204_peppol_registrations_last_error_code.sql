-- #2483: a failed Peppol registration kept only the composed English prose in
-- last_error, so the UI could neither translate it nor tell a permanent
-- refusal from a transient one. Keep the stable code beside the raw text:
-- the transport code (hosted connector envelope code or HTTP_<status>) when
-- there is one, else the registration result code.
ALTER TABLE public.peppol_registrations
  ADD COLUMN IF NOT EXISTS last_error_code text;

COMMENT ON COLUMN public.peppol_registrations.last_error_code IS
  'Stable code behind last_error (connector envelope code, HTTP_<status>, or a PEPPOL_REGISTRATION_* result code). Translated in the UI; last_error stays raw for ops.';

NOTIFY pgrst, 'reload schema';
