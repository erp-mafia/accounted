-- vat_eu_trade_fiscal_years: whether each helårsmoms period's own books show
-- trade with other EU countries, as the nightly deadline job last read them.
--
-- Helårsmoms is due earlier for a period with EU trade (lib/reports/eu-trade.ts
-- helarsmomsHasEuTrade). The deadline rows read only the setting "Handel med
-- andra EU-länder", so a yearly filer that bought or sold within the EU with
-- the setting off got the later date on the deadline list, in the calendar,
-- the reminders, Betala via banken and the forecast, while the VAT close check
-- named the earlier one.
--
-- The nightly job (alignYearlyVatDeadlinesWithBooks) reads a period's
-- declaration rutor, the way the declaration does, while the earlier date is
-- still ahead, and writes one row per period it read: has_eu_trade, and when
-- (checked_at), so the next night starts with the periods read longest ago.
-- The deadline generator, the repair job's detection and the filing record
-- read only the rows with has_eu_trade, as they read the setting, so they
-- always agree and none of them reads the books. A yes stays a yes: the job
-- never reads that period again, and a wrong yes only makes the date earlier.
--
-- fiscal_year_end is the month the helårsmoms period ends (YYYY-MM): the
-- räkenskapsår, or for an enskild firma the calendar year it declares
-- (helarsmomsPeriodOf / fiscalYearEndKey in lib/tax/deadline-config.ts).
-- Derived data written by the service role only; members of the company read
-- it. Not in the full-archive dump: it is derived from the journal there. No
-- audit trigger: write_audit_log keys its rows by NEW.id, which this derived
-- table has none of, and the rows only date a deadline.
--
-- pg-test: tests/pg/vat-eu-trade-fiscal-years.pg.test.ts

CREATE TABLE public.vat_eu_trade_fiscal_years (
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_year_end text NOT NULL CHECK (fiscal_year_end ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  has_eu_trade    boolean NOT NULL,
  checked_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, fiscal_year_end)
);

ALTER TABLE public.vat_eu_trade_fiscal_years ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vat_eu_trade_fiscal_years TO service_role;
GRANT SELECT ON TABLE public.vat_eu_trade_fiscal_years TO authenticated;
-- no-grant: anon on public.vat_eu_trade_fiscal_years (company data, members only)

-- Read-only for members: only the nightly job (service role) writes.
CREATE POLICY "view own-company vat_eu_trade_fiscal_years"
  ON public.vat_eu_trade_fiscal_years FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

COMMENT ON TABLE public.vat_eu_trade_fiscal_years IS
  'Per helårsmoms period (fiscal_year_end, YYYY-MM): whether its declaration rutor show EU trade, as the nightly deadline job last read them (checked_at) while the earlier date was ahead; the deadline generator and the repair detection read the has_eu_trade rows as they read vat_has_eu_trade.';

NOTIFY pgrst, 'reload schema';
