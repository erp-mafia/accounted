-- Settings restructure: add bookkeeping lock, PDF/invoice settings
-- Phase 2: Bookkeeping settings
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS bookkeeping_locked_through date,
  ADD COLUMN IF NOT EXISTS auto_lock_period_days integer;

-- Phase 3: Invoice/PDF settings
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS ore_rounding boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS invoice_show_ocr boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS invoice_show_bankgiro boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS invoice_show_plusgiro boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS invoice_late_fee_text text,
  ADD COLUMN IF NOT EXISTS invoice_credit_terms_text text;

-- Enforce company-wide bookkeeping lock date on journal entries
CREATE OR REPLACE FUNCTION public.enforce_company_lock_date()
RETURNS TRIGGER AS $$
DECLARE
  lock_date date;
BEGIN
  SELECT bookkeeping_locked_through INTO lock_date
  FROM public.company_settings
  WHERE company_id = NEW.company_id;

  IF lock_date IS NOT NULL AND NEW.entry_date <= lock_date THEN
    RAISE EXCEPTION 'Bokföringen är låst t.o.m. %. Kan inte skapa verifikation med datum %.',
      lock_date, NEW.entry_date;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger only on insert and update of entry_date
DROP TRIGGER IF EXISTS trg_enforce_company_lock_date ON public.journal_entries;
CREATE TRIGGER trg_enforce_company_lock_date
  BEFORE INSERT OR UPDATE OF entry_date ON public.journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_company_lock_date();
