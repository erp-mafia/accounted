-- Per-company opt-in for analysis of bookkeeping data (#1346).
--
-- Adds the consent flag that gates every path where a company's bookkeeping
-- data is read across companies for Accounted's own analysis. Two scopes,
-- both stated in the consent copy (messages/*.json data_analysis.*):
--   1. Booking outcomes (proposed vs booked account, amount, confidence):
--      the auto-booking calibration corpus (categorize_calibration_samples,
--      written by POST /api/agent/categorize/outcome) and the calibration-fit
--      script.
--   2. Evaluation runs (scripts/backtest-categorize.ts, founder-run): the
--      company's transaction descriptions, counterparty names and matched
--      underlag (receipts, invoices) are re-run through the same AI model
--      and processors as regular booking. That text can contain personal
--      data (e.g. names in Swish payments), so the disclosure says so.
-- Enforced server-side by lib/company/data-analysis.ts and by the scripts'
-- own opted-in filter, never by the client.
--
-- Default false for everyone, no grandfathering: a company contributes
-- nothing until a company owner or admin flips the toggle in
-- Inställningar > Företag (the company_settings RLS update policy is admin
-- only, so the switch is admin only too). Turning it off stops new collection immediately.
-- The flag does not cover product-usage analytics or MCP reliability
-- telemetry (no bookkeeping content, documented under legitimate interest in
-- .compliance/ropa.yaml). Mirrors mileage_enabled (20260812193500).
--
-- pg-test: skip (plain column addition, no trigger/RPC/RLS)

ALTER TABLE public.company_settings
  ADD COLUMN data_analysis_opt_in boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.company_settings.data_analysis_opt_in IS
  'Consent flag: when true, this company''s booking outcomes (proposed vs booked account, confidence, amount) may be read across companies for the auto-booking calibration corpus, and in evaluation runs (scripts/backtest-categorize.ts) its transaction descriptions, counterparty names and matched underlag may be re-run through the AI model. Default false; enforced server-side (lib/company/data-analysis.ts).';

NOTIFY pgrst, 'reload schema';
