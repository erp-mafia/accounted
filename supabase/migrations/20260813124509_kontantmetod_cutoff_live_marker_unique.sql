-- Serialize cash-method year-end cut-off approvals at the immutable journal.
-- Two separately staged operations can race past the application preflight;
-- the live marker index makes the second commit fail before a duplicate
-- posted entry can exist.
-- pg-test: tests/pg/kontantmetod-cutoff-unique.pg.test.ts

-- The existing corporate-tax index was broader than its comment: it reserved
-- every year_end entry with a fiscal-period source_id, so a cut-off could not
-- post its second immutable voucher. Keep the tax race guard on tax entries.
DROP INDEX IF EXISTS public.uq_year_end_corporate_tax_per_period;

CREATE UNIQUE INDEX uq_year_end_corporate_tax_per_period
  ON public.journal_entries (company_id, source_id)
  WHERE source_type = 'year_end'
    AND source_id IS NOT NULL
    AND status IN ('draft', 'posted')
    AND description LIKE 'Bokslutsdisposition: Bolagsskatt %';

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_kontantmetod_cutoff_live_marker_unique
  ON public.journal_entries (company_id, source_id, description)
  WHERE status = 'posted'
    AND source_type = 'year_end'
    AND description IN (
      'Kundfordringar vid bokslut (kontantmetoden)',
      'Vändning kundfordringar bokslut (kontantmetoden)',
      'Leverantörsskulder vid bokslut (kontantmetoden)',
      'Vändning leverantörsskulder bokslut (kontantmetoden)'
    );
