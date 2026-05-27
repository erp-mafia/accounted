-- ROT/RUT-avdrag on invoices.
--
-- Adds per-item deduction flags (ROT or RUT) and invoice-level claim info
-- (customer personnummer + housing designation). The system computes the
-- deduction amount per item and posts a receivable from Skatteverket on
-- BAS 1513 (Övriga kortfristiga fordringar — kund / Skatteverket). The
-- customer pays only the post-deduction amount; Skatteverket pays the
-- rest later via Husavdragstjänsten (XML/SOAP submission is out of scope
-- for v1 — this migration only enables the booking + PDF rendering).
--
-- Personnummer is sensitive PII. We never store it in plaintext: only
-- the AES-256-GCM ciphertext (`deduction_personnummer_encrypted`) plus
-- the last four digits (`deduction_personnummer_last4`) for display.
-- The encryption helper lives at lib/salary/personnummer.ts and is
-- reused unchanged for ROT/RUT.
--
-- Cross-table consistency (if any item carries deduction_type, the
-- invoice MUST carry an encrypted personnummer; ROT specifically also
-- requires housing_designation) is enforced at the API layer via Zod
-- and lib/invoices/rot-rut-rules.ts — Postgres CHECK constraints cannot
-- span tables without expensive triggers, and the API path is the only
-- way to create an invoice with deduction lines (per-row writes via
-- service role still go through the same engine).

-- 1. Per-item deduction columns.
ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS deduction_type TEXT NULL,
  ADD COLUMN IF NOT EXISTS deduction_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS labor_hours NUMERIC(5,2) NULL,
  ADD COLUMN IF NOT EXISTS work_type TEXT NULL,
  ADD COLUMN IF NOT EXISTS housing_designation TEXT NULL,
  ADD COLUMN IF NOT EXISTS apartment_number TEXT NULL;

ALTER TABLE public.invoice_items DROP CONSTRAINT IF EXISTS invoice_items_deduction_type_check;
ALTER TABLE public.invoice_items ADD CONSTRAINT invoice_items_deduction_type_check
  CHECK (deduction_type IS NULL OR deduction_type IN ('rot', 'rut'));

-- The deduction amount must be non-negative; computed at API layer and
-- capped at the line total to stop a tampered request from creating a
-- larger receivable than the invoice itself.
ALTER TABLE public.invoice_items DROP CONSTRAINT IF EXISTS invoice_items_deduction_amount_check;
ALTER TABLE public.invoice_items ADD CONSTRAINT invoice_items_deduction_amount_check
  CHECK (deduction_amount >= 0);

-- 2. Invoice-level totals and claim info.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS deduction_total NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deduction_personnummer_encrypted TEXT NULL,
  ADD COLUMN IF NOT EXISTS deduction_personnummer_last4 TEXT NULL;

ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_deduction_total_check;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_deduction_total_check
  CHECK (deduction_total >= 0);

-- 3. Helpful indexes for the common queries.
CREATE INDEX IF NOT EXISTS idx_invoice_items_deduction_type
  ON public.invoice_items (deduction_type)
  WHERE deduction_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_deduction_total
  ON public.invoices (company_id, deduction_total)
  WHERE deduction_total > 0;

NOTIFY pgrst, 'reload schema';
