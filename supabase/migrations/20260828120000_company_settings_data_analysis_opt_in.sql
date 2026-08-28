-- Per-company opt-in for analysis of bookkeeping data (#1346).
--
-- Adds the consent flag that gates every path where a company's bookkeeping
-- outcomes are read across companies for Accounted's own analysis: today the
-- auto-booking calibration corpus (categorize_calibration_samples, written by
-- POST /api/agent/categorize/outcome) and the founder-run backtest and
-- calibration-fit scripts. Enforced server-side by
-- lib/company/data-analysis.ts, never by the client.
--
-- Default false for everyone, no grandfathering: a company contributes
-- nothing until a human with write access flips the toggle in
-- Inställningar > Företag. Turning it off stops new collection immediately.
-- The flag does not cover product-usage analytics or MCP reliability
-- telemetry (no bookkeeping content, documented under legitimate interest in
-- .compliance/ropa.yaml). Mirrors mileage_enabled (20260812193500).
--
-- pg-test: skip (plain column addition, no trigger/RPC/RLS)

ALTER TABLE public.company_settings
  ADD COLUMN data_analysis_opt_in boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.company_settings.data_analysis_opt_in IS
  'Consent flag: when true, this company''s bookkeeping outcomes (proposed vs booked account, confidence, amount) may be read across companies to evaluate and improve automatic booking. Default false; enforced server-side (lib/company/data-analysis.ts).';

NOTIFY pgrst, 'reload schema';
