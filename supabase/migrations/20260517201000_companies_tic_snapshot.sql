-- Migration: companies.tic_snapshot — cached TIC company profile per company
--
-- The specialized accountant composer reads from a denormalized snapshot of
-- the TICCompanyProfile (Bolagsverket-sourced data: legal form, SNI codes,
-- F-skatt/VAT/payroll registration, employee/turnover bands, bank accounts,
-- recent financials). Caching it here means:
--
--   * Recomposition (monthly + on-demand) does not hammer the TIC API.
--   * The MCP briefing tool gnubok_get_agent_briefing can return the same
--     facts external clients (Claude.ai) see in-app.
--   * Refresh is deliberate (manual rebuild or monthly cron), not implicit.
--
-- The JSONB shape mirrors TICCompanyProfile in extensions/general/tic/lib/
-- tic-types.ts (companyId, orgNumber, legalEntityType, sniCodes[],
-- registration{fTax,vat,payroll}, employeeRange, turnoverRange, address,
-- bankAccounts[], financialReports[]). We intentionally avoid a structured
-- shape constraint here — TIC schema evolves outside our migration cadence.
--
-- See dev_docs/specialized-agent-plan.md §5 (data model) and §6 (composer).

ALTER TABLE public.companies
  ADD COLUMN tic_snapshot              jsonb,
  ADD COLUMN tic_snapshot_fetched_at   timestamptz;

NOTIFY pgrst, 'reload schema';
