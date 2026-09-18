-- Opt-in auto-approval of leverantörsfakturor (payment attest via approved_at).
--
-- Today enskild firma always auto-approves after register in the dashboard
-- create flow (registerer and attester are the same person). Aktiebolag
-- leaves invoices in status registered until someone clicks Godkänn.
--
-- When auto_approve_supplier_invoices is true, the dashboard create paths
-- call POST /approve after a successful register (same as EF). Default false:
-- AB companies opt in from invoicing settings. EF behaviour stays always-on
-- in the client (isEF || setting), so this column is not a backfill for EF.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS auto_approve_supplier_invoices boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.company_settings.auto_approve_supplier_invoices IS
  'Opt-in: after registering a leverantörsfaktura, automatically approve it for payment (sets approved_at). Default off. Enskild firma still auto-approves in the dashboard regardless of this flag.';

NOTIFY pgrst, 'reload schema';
