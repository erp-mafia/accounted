-- Time tracking extension: time_entries (tidredovisning per kund och projekt)
--
-- One row per registered stretch of work: who (consultant initials), when,
-- for which customer and optional project, under which activity code, how
-- many hours. Consultants and activity codes are small per-company lists kept
-- in extension_data (extension settings), so this is the only new table.
--
-- Customer: rows are linked to an Accounted customer (customer_id) or, until
-- the user links them, carry only the code and name from the imported sheet
-- (customer_code/customer_name). Import never creates customers: a customer
-- record carries invoicing rules (personnummer masking, payment terms, party
-- linkage) that belong to the customer editor, not to a spreadsheet import.
--
-- Project: the SIE dimension 6 object code (dimension_values.code), stored as
-- text like journal_entry_lines.dimensions so it survives a value being
-- inactivated and maps one to one onto #OBJEKT on export.
--
-- import_key makes re-importing the same workbook idempotent: it hashes the
-- source row, so a second upload of an extended file adds only the new rows.

CREATE TABLE public.time_entries (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id     uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entry_date     date NOT NULL,
  consultant     text NOT NULL CHECK (char_length(consultant) BETWEEN 1 AND 20),
  customer_id    uuid NULL REFERENCES public.customers(id) ON DELETE SET NULL,
  customer_code  text NULL CHECK (customer_code IS NULL OR char_length(customer_code) BETWEEN 1 AND 40),
  customer_name  text NULL CHECK (customer_name IS NULL OR char_length(customer_name) <= 200),
  project_code   text NULL CHECK (project_code IS NULL OR char_length(project_code) BETWEEN 1 AND 40),
  activity_code  text NULL CHECK (activity_code IS NULL OR char_length(activity_code) BETWEEN 1 AND 20),
  hours          numeric(6,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  comment        text NULL CHECK (comment IS NULL OR char_length(comment) <= 1000),
  is_billable    boolean NOT NULL DEFAULT true,
  -- Set when the hours have been invoiced; the row is then read-only in the API.
  invoice_id     uuid NULL REFERENCES public.invoices(id) ON DELETE SET NULL,
  source         text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import')),
  import_key     text NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT time_entries_customer_present
    CHECK (customer_id IS NOT NULL OR customer_code IS NOT NULL),
  CONSTRAINT time_entries_import_key_unique UNIQUE (company_id, import_key)
);

ALTER TABLE public.time_entries ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.time_entries TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.time_entries TO authenticated;

CREATE POLICY "view own-company time_entries"
  ON public.time_entries FOR SELECT USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company time_entries"
  ON public.time_entries FOR INSERT WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company time_entries"
  ON public.time_entries FOR UPDATE USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company time_entries"
  ON public.time_entries FOR DELETE USING (company_id IN (SELECT user_company_ids()));

CREATE INDEX idx_time_entries_company_id ON public.time_entries (company_id);
CREATE INDEX idx_time_entries_company_date ON public.time_entries (company_id, entry_date);
CREATE INDEX idx_time_entries_customer_id ON public.time_entries (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_time_entries_invoice_id ON public.time_entries (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX idx_time_entries_user_id ON public.time_entries (user_id);

CREATE TRIGGER set_updated_at_time_entries
  BEFORE UPDATE ON public.time_entries
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_time_entries
  AFTER INSERT OR UPDATE OR DELETE ON public.time_entries
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

NOTIFY pgrst, 'reload schema';
