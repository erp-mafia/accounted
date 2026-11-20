-- Swedbank's own identifiers for file payments (crm#1117).
--
-- Swedbank's file service (MIG 2.0, "ISO 2.0", the one its internet bank
-- validates uploads against) identifies who sends a pain.001 file and under
-- which agreement by ids Swedbank assigns, not by the organisationsnummer:
--
--   GrpHdr/InitgPty/Id/OrgId/Othr/Id  SignerID, nnnnnnnnnORInnnn
--   PmtInf/Dbtr/Id/OrgId/Othr/Id      Corporate Pay agreement id, nnnnnnnnnCPOnnnn
--
-- both with SchmeNm/Cd BANK. Neither can be derived from the org number, so
-- the company enters them once in Settings. Accounted wrote the org number in
-- both places, and Swedbank refused every file ("Aktivt id för
-- fullmaktshavare saknas").
--
-- Plain nullable text, no CHECK: the format is validated where it is entered
-- (UpdateSettingsSchema), because Swedbank publishes MIG 2.0 as preliminary
-- and a format change must not need a migration. Read only for a company
-- whose bank resolves to Swedbank (BIC SWEDSESS, savings banks included).

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS swedbank_signer_id text,
  ADD COLUMN IF NOT EXISTS swedbank_corporate_pay_id text;

COMMENT ON COLUMN public.company_settings.swedbank_signer_id IS
  'Swedbank SignerID (nnnnnnnnnORInnnn) for pain.001 files: GrpHdr/InitgPty/Id/OrgId/Othr/Id with SchmeNm BANK. Assigned by Swedbank.';
COMMENT ON COLUMN public.company_settings.swedbank_corporate_pay_id IS
  'Swedbank Corporate Pay agreement id (nnnnnnnnnCPOnnnn) for pain.001 files: PmtInf/Dbtr/Id/OrgId/Othr/Id with SchmeNm BANK. Assigned by Swedbank.';

COMMENT ON COLUMN public.supplier_payment_batches.debtor_snapshot IS
  'Debtor at creation: {name, org_number, iban, bic, bankgiro, city}, plus swedbank_signer_id and swedbank_corporate_pay_id for a Swedbank debtor. Immutable: regenerating the file reads only this.';

NOTIFY pgrst, 'reload schema';
