-- Nordea's CCM agreement id for file payments (crm#1530).
--
-- A pain.001 file to Nordea names two ids Nordea assigns: the Signer ID as
-- the initiating party (20261028211500_company_settings_nordea_signer_id.sql)
-- and the customer's Corporate Cash Management (CCM) agreement as the debtor:
--
--   GrpHdr/InitgPty/Id/OrgId/Othr/Id  Signer ID, SchmeNm/Cd CUST
--   PmtInf/Dbtr/Id/OrgId/Othr/Id      CCM agreement id, SchmeNm/Cd BANK
--
-- ("Customer agreement (Nordea's CCM agreement) identification with Nordea
-- is mandatory (BANK)": Corporate Access Payables MIG pain.001.001.03 v2.4,
-- 2026-06-24, and pain.001.001.09 v1.4, 2026-09-16.) Accounted wrote the org
-- number there, and Nordea rejected the file after upload for the missing
-- agreement id. A Nordea Business agreement id starts with NB (NB123456 in
-- Nordea's example), a Corporate Netbank one is digits (1234567890).
--
-- Plain nullable text, no CHECK, like the Signer ID and the Swedbank ids:
-- the format is validated where it is entered (UpdateSettingsSchema). Read
-- only for a company whose bank resolves to Nordea (BIC NDEASESS).

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS nordea_agreement_id text;

COMMENT ON COLUMN public.company_settings.nordea_agreement_id IS
  'Nordea CCM agreement id for pain.001 files: PmtInf/Dbtr/Id/OrgId/Othr/Id with SchmeNm BANK. Assigned by Nordea.';

COMMENT ON COLUMN public.supplier_payment_batches.debtor_snapshot IS
  'Debtor at creation: {name, org_number, iban, bic, bankgiro, city}, plus swedbank_signer_id and swedbank_corporate_pay_id for a Swedbank debtor, or nordea_signer_id and nordea_agreement_id for a Nordea debtor. Immutable: regenerating the file reads only this.';

NOTIFY pgrst, 'reload schema';
