-- Nordea's Signer ID for file payments (crm#1530).
--
-- Nordea identifies who sends a pain.001 file by the Signer ID in the file
-- agreement, not by the organisationsnummer:
--
--   GrpHdr/InitgPty/Id/OrgId/Othr/Id  Signer ID, SchmeNm/Cd CUST
--
-- ("Signer Id as agreed with (or assigned by) Nordea": Corporate Access
-- Payables MIG pain.001.001.09 v1.4 and Corporate eGateway MIG
-- pain.001.001.03 v3.3, both 2026-09-16). It cannot be derived from the org
-- number, so the company enters it once in Settings. Accounted wrote the org
-- number there, and Nordea refused the file ("Filen avvisades - fel Signer
-- ID").
--
-- Plain nullable text, no CHECK, like the Swedbank ids
-- (20261011122750_company_settings_swedbank_file_ids.sql): the format is
-- validated where it is entered (UpdateSettingsSchema). Read only for a
-- company whose bank resolves to Nordea (BIC NDEASESS).

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS nordea_signer_id text;

COMMENT ON COLUMN public.company_settings.nordea_signer_id IS
  'Nordea Signer ID for pain.001 files: GrpHdr/InitgPty/Id/OrgId/Othr/Id with SchmeNm CUST. Agreed with or assigned by Nordea.';

COMMENT ON COLUMN public.supplier_payment_batches.debtor_snapshot IS
  'Debtor at creation: {name, org_number, iban, bic, bankgiro, city}, plus swedbank_signer_id and swedbank_corporate_pay_id for a Swedbank debtor, or nordea_signer_id for a Nordea debtor. Immutable: regenerating the file reads only this.';

NOTIFY pgrst, 'reload schema';
