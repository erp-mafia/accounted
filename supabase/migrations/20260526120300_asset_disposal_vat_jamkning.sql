-- Asset disposal: VAT + jämkning (Item 2)
--
-- Extends the assets table with the data needed to post a Swedish-compliant
-- avyttring:
--
--   1) Output VAT on proceeds (ML 3 kap 3 § / 7 kap 3 §).
--      When an anläggningstillgång that had right-to-deduct VAT on
--      acquisition is sold to a VAT-registered domestic counterparty,
--      proceeds are momspliktig at the rate corresponding to the asset's VAT
--      treatment. The two new columns capture the VAT amount and the
--      treatment that was applied so SIE export, BAS 26xx reports, and audit
--      trail all carry the same data.
--
--   2) Jämkning (ML 8a kap 4-7 §§, formerly ML 9 kap 8-11 §§ pre-2023).
--      When an asset that had input VAT deducted at acquisition is disposed
--      of within the korrigeringstid (5 år / 60 mån för lös egendom, 10 år /
--      120 mån för fastighet och markanläggning), part of the original input
--      VAT must be paid back. The four jamkning_* columns record the inputs
--      to the calculation so the audit trail shows how the number was
--      arrived at — purely descriptive metadata; the actual booking sits on
--      a journal entry line against 2641.
--
-- All new columns default to safe zeros / nulls so existing assets without
-- disposal data continue to satisfy the schema without backfilling.

ALTER TABLE public.assets
  ADD COLUMN disposed_proceeds_vat NUMERIC(15, 2) NOT NULL DEFAULT 0,
  ADD COLUMN disposed_vat_treatment TEXT NULL,
  ADD COLUMN jamkning_amount NUMERIC(15, 2) NOT NULL DEFAULT 0,
  ADD COLUMN jamkning_remaining_months INT NULL,
  ADD COLUMN jamkning_total_months INT NULL,
  ADD COLUMN jamkning_original_input_vat NUMERIC(15, 2) NULL;

-- Restrict the VAT treatment to the same enum the bookkeeping engine
-- already understands. Mirrors the VatTreatment type in lib/bookkeeping/
-- vat-entries.ts so the API and engine stay in sync.
ALTER TABLE public.assets
  ADD CONSTRAINT assets_disposed_vat_treatment_check
  CHECK (
    disposed_vat_treatment IS NULL OR disposed_vat_treatment IN (
      'standard_25',
      'reduced_12',
      'reduced_6',
      'reverse_charge',
      'export',
      'exempt'
    )
  );

-- Treatment is required whenever a VAT amount is recorded. A nonzero
-- proceeds_vat without an explicit treatment would be impossible to map
-- back to a BAS 26xx account at SIE export / audit time.
ALTER TABLE public.assets
  ADD CONSTRAINT assets_disposed_vat_consistency
  CHECK (
    (disposed_proceeds_vat = 0) OR (disposed_vat_treatment IS NOT NULL)
  );

NOTIFY pgrst, 'reload schema';
