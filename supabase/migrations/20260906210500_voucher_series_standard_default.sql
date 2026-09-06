-- Migration: Standard verifikationsserier for new companies (issue #2184)
--
-- default_voucher_series_per_source_type shipped (20260526120700) with every
-- source type on 'A' "to preserve current behaviour", and nothing since has
-- asked a new company to lay its series out: the onboarding upsert
-- (lib/company/create-company.ts) and the sandbox seed both insert the row
-- without this column, so every company started with its whole ledger in one
-- series, and each source type added later (webshop_order, vat_settlement,
-- expense_payout, ...) silently joined it through the resolver's 'A' fallback.
--
-- New rows now default to the standard set. The letters are Fortnox's, the
-- same ones VOUCHER_SERIES_PRESETS already names in every picker, so a ledger
-- imported from Fortnox continues its kundfakturor in B, leverantörsfakturor
-- in D and löner in K instead of starting parallel series:
--   A  manual entries, bank transactions, and everything not listed below
--   B  kundfakturor, kreditfakturor, påminnelseavgifter
--   C  inbetalningar från kunder (incl. rot/rut payouts clearing 1513)
--   D  leverantörsfakturor, leverantörskreditfakturor, privat betalda
--   E  utbetalningar till leverantörer
--   H  periodiseringar
--   I  bokslut, resultatdisposition
--   K  lön
--   L  kontantfakturor (webshop orders)
--   M  momsredovisning
-- The JSON below must stay equal to STANDARD_VOUCHER_SERIES_MAP in
-- lib/bookkeeping/voucher-series-resolver.ts and name every value the
-- journal_entries.source_type CHECK accepts;
-- tests/pg/voucher-series-standard-default.pg.test.ts asserts both.
--
-- Existing rows are deliberately NOT updated. A company that has been booking
-- on A keeps A for every type until it chooses the standard set itself under
-- Inställningar > Bokföring ("Använd standarduppsättningen"). Each series must
-- be unbroken within the räkenskapsår (BFL 5 kap. 7 §); a switch does not
-- break that, but a remap by migration would move the next kundfaktura from
-- A(n+1) into a fresh B1 mid-year with nothing in the behandlingshistorik
-- saying who decided it. BFNAR 2013:2 p. 9.16 records changes to the
-- behandlingsregler with date and actor, which the audited settings save
-- provides and a migration cannot.

ALTER TABLE public.company_settings
  ALTER COLUMN default_voucher_series_per_source_type
  SET DEFAULT '{
    "manual": "A",
    "bank_transaction": "A",
    "invoice_created": "B",
    "credit_note": "B",
    "reminder_fee": "B",
    "invoice_paid": "C",
    "invoice_cash_payment": "C",
    "rot_rut_payout": "C",
    "supplier_invoice_registered": "D",
    "supplier_credit_note": "D",
    "supplier_invoice_privately_paid": "D",
    "supplier_invoice_paid": "E",
    "supplier_invoice_cash_payment": "E",
    "accrual": "H",
    "year_end": "I",
    "result_appropriation": "I",
    "salary_payment": "K",
    "webshop_order": "L",
    "vat_settlement": "M",
    "opening_balance": "A",
    "currency_revaluation": "A",
    "inbox_item": "A",
    "import": "A",
    "system": "A",
    "storno": "A",
    "correction": "A",
    "stripe_payout": "A",
    "expense_claim": "A",
    "expense_payout": "A"
  }'::jsonb;

COMMENT ON COLUMN public.company_settings.default_voucher_series_per_source_type IS
  'Maps journal_entries.source_type -> default voucher_series (single uppercase letter A-Z). Read by lib/bookkeeping/voucher-series-resolver.ts (missing key -> "A"); written via /api/settings. New rows default to STANDARD_VOUCHER_SERIES_MAP (A manual/bank, B kundfakturor, C inbetalningar, D leverantörsfakturor, E utbetalningar, H periodisering, I bokslut, K lön, L kontantfaktura, M moms); rows created before 20260906210500 keep every type on "A" until the company applies the standard set in settings.';

NOTIFY pgrst, 'reload schema';
