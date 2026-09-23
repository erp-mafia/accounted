-- Invoice document type visibility toggles (Inställningar > Försäljning).
--
-- Four per-company switches that hide the optional invoice kinds from the UI
-- for users who never need them: offert (quote), proformafaktura (proforma),
-- återkommande faktura (recurring schedules) and självfaktura (self-billing).
-- Default ON so nothing changes for existing companies.
--
-- UI-visibility only, NEVER load-bearing for correctness: documents of a
-- hidden kind that already exist stay listed under Alla, remain reachable by
-- URL and keep working through the API/MCP. Mirrors sales_orders_enabled
-- (20260902130000) and mileage_enabled (20260812193500).
--
-- pg-test: skip (plain column addition, no trigger/RPC/RLS)

ALTER TABLE public.company_settings
  ADD COLUMN quotes_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN proforma_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN recurring_invoices_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN self_billing_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.company_settings.quotes_enabled IS
  'UI-visibility toggle for offert (quote) entry points. Never load-bearing: existing quotes stay listed and the API/MCP work regardless.';
COMMENT ON COLUMN public.company_settings.proforma_enabled IS
  'UI-visibility toggle for proformafaktura entry points. Never load-bearing: existing proformas stay listed and the API/MCP work regardless.';
COMMENT ON COLUMN public.company_settings.recurring_invoices_enabled IS
  'UI-visibility toggle for återkommande faktura (recurring schedule) entry points. Never load-bearing: schedules keep running and /invoices/recurring stays reachable by URL.';
COMMENT ON COLUMN public.company_settings.self_billing_enabled IS
  'UI-visibility toggle for självfaktura (self-billing) entry points. Never load-bearing: existing self-billed invoices stay listed and the API/MCP work regardless.';

NOTIFY pgrst, 'reload schema';
