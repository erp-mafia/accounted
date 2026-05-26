-- Migration: recurring_invoice_schedules — Återkommande fakturor (v1)
--
-- Why this exists: Users with subscription-style billing (retainers, hyror,
-- abonnemang) repeatedly create the same invoice on a fixed day each month.
-- This table stores an invoice template plus a monthly cadence. A daily cron
-- (/api/invoices/recurring/cron) finds schedules whose next_run_date <= today
-- and spawns a real invoice via the standard invoice creation pipeline.
--
-- Scope v1 (locked in via planning):
--  - Monthly cadence only (day_of_month 1-31; clamped to last day of month
--    in cron's computeNextRunDate, schedule retains original day_of_month).
--  - No end_date / max_runs — schedule runs until user pauses or deletes.
--  - Per-schedule auto_send flag: true = create + send email immediately,
--    false = create as draft for manual review.

-- ============================================================
-- recurring_invoice_schedules — the template + cadence
-- ============================================================

CREATE TABLE public.recurring_invoice_schedules (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id          UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Customer is RESTRICT so deleting a customer with active schedules raises a
  -- clear FK error rather than silently nuking the schedules. Surface as a
  -- Swedish error via lib/errors/get-error-message.ts on the customer delete
  -- API route; the user then pauses/deletes the schedule first.
  customer_id         UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  -- Human-readable name shown in the list view (e.g. "Månadsretainer Acme AB").
  name                TEXT NOT NULL CHECK (length(name) > 0),
  -- Day of month (1-31). Values >28 are clamped to the last day of shorter
  -- months by computeNextRunDate; the original day_of_month is preserved so
  -- a 31-day schedule jumps back to 31 in months that have it.
  day_of_month        SMALLINT NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  -- Payment terms (days). due_date = invoice_date + payment_terms_days.
  -- Net-30 is the SME default; 0-90 covers practical range without being
  -- arbitrary.
  payment_terms_days  SMALLINT NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 90),
  currency            TEXT NOT NULL DEFAULT 'SEK',
  -- Free-text fields mirroring the manual invoice form, applied to each
  -- generated faktura.
  your_reference      TEXT,
  our_reference       TEXT,
  notes               TEXT,
  -- false: create as draft so the user reviews + sends manually.
  -- true: render PDF, send via email extension, flip status to 'sent',
  --       create journal entry on accrual. If email extension not configured
  --       or customer has no email, falls back to draft + sets
  --       last_run_warning.
  auto_send           BOOLEAN NOT NULL DEFAULT false,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  -- Date the schedule should next produce an invoice. Cron filter:
  -- next_run_date <= today AND status='active'. Recomputed after every
  -- successful run.
  next_run_date       DATE NOT NULL,
  -- last_run_at + last_invoice_id provide idempotency. Cron skips if
  -- last_run_at::date >= today, so retries within the same UTC day don't
  -- double-spawn.
  last_run_at         TIMESTAMPTZ,
  last_invoice_id     UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  -- Free-text Swedish warning surfaced in the UI when the most recent run
  -- couldn't fully complete (e.g. email extension disabled). Cleared on
  -- next successful run.
  last_run_warning    TEXT,
  generated_count     INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ris_company ON public.recurring_invoice_schedules (company_id);
CREATE INDEX idx_ris_customer ON public.recurring_invoice_schedules (customer_id);
-- Partial index for cron's primary query: active schedules due to run.
CREATE INDEX idx_ris_due ON public.recurring_invoice_schedules (next_run_date)
  WHERE status = 'active';

ALTER TABLE public.recurring_invoice_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "recurring_invoice_schedules_select" ON public.recurring_invoice_schedules
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "recurring_invoice_schedules_insert" ON public.recurring_invoice_schedules
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "recurring_invoice_schedules_update" ON public.recurring_invoice_schedules
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "recurring_invoice_schedules_delete" ON public.recurring_invoice_schedules
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER recurring_invoice_schedules_updated_at
  BEFORE UPDATE ON public.recurring_invoice_schedules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- recurring_invoice_schedule_items — template line items
-- ============================================================

CREATE TABLE public.recurring_invoice_schedule_items (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  schedule_id   UUID NOT NULL REFERENCES public.recurring_invoice_schedules(id) ON DELETE CASCADE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  description   TEXT NOT NULL CHECK (length(description) > 0),
  quantity      NUMERIC(12, 4) NOT NULL CHECK (quantity > 0),
  unit          TEXT NOT NULL DEFAULT 'st',
  unit_price    NUMERIC(14, 2) NOT NULL,
  -- NULL = inherit the customer's default VAT rate at spawn time. The cron
  -- resolves this via lib/invoices/vat-rules.ts so a customer who later
  -- becomes VAT-validated picks up the new rate automatically on the next
  -- run.
  vat_rate      NUMERIC(5, 2) CHECK (vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate <= 100)),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_risi_schedule ON public.recurring_invoice_schedule_items (schedule_id, sort_order);

ALTER TABLE public.recurring_invoice_schedule_items ENABLE ROW LEVEL SECURITY;

-- Items inherit access from the parent schedule via EXISTS-join so we
-- don't have to duplicate company_id on the child rows.
CREATE POLICY "recurring_invoice_schedule_items_select" ON public.recurring_invoice_schedule_items
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.recurring_invoice_schedules s
    WHERE s.id = schedule_id
      AND s.company_id IN (SELECT public.user_company_ids())
  ));
CREATE POLICY "recurring_invoice_schedule_items_insert" ON public.recurring_invoice_schedule_items
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM public.recurring_invoice_schedules s
    WHERE s.id = schedule_id
      AND s.company_id IN (SELECT public.user_company_ids())
  ));
CREATE POLICY "recurring_invoice_schedule_items_update" ON public.recurring_invoice_schedule_items
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM public.recurring_invoice_schedules s
    WHERE s.id = schedule_id
      AND s.company_id IN (SELECT public.user_company_ids())
  ));
CREATE POLICY "recurring_invoice_schedule_items_delete" ON public.recurring_invoice_schedule_items
  FOR DELETE USING (EXISTS (
    SELECT 1 FROM public.recurring_invoice_schedules s
    WHERE s.id = schedule_id
      AND s.company_id IN (SELECT public.user_company_ids())
  ));

NOTIFY pgrst, 'reload schema';
