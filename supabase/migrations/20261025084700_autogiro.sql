-- Autogiro v1: collecting a company's customer invoices by direct debit
-- through Bankgirot, on the company's own Autogiro agreement with its bank.
-- pg-test: tests/pg/autogiro.pg.test.ts,
--          tests/pg/account-erasure.pg.test.ts
--
-- The company writes Bankgirot's files in Accounted (src/lib/invoices/autogiro)
-- and uploads them in its own bank, and uploads the reports Bankgirot sends
-- back. Accounted never talks to Bankgirot itself and stores no seal key: a
-- bank upload carries the uploader's own electronic signature.
--
-- A debit needs only the payee's bankgiro and the payer number: Bankgirot
-- finds the account in its own mandate register. So a mandate here is the
-- link between a customer and a payer number, with Bankgirot's status, and
-- never holds the payer's bank account or personnummer.
--
-- An invoice is debited only when it told the customer so (Bankgirot's
-- notice rule, 8 banking days before the debit). invoices.autogiro_payer_number
-- carries that: a draft follows its customer's active mandate, and the value
-- freezes when the invoice is issued, because the PDF the customer gets is
-- rendered from the draft row. An invoice issued without it is never debited.

-- =============================================================================
-- 1. autogiro_settings: the company's Autogiro agreement
-- =============================================================================

CREATE TABLE public.autogiro_settings (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Kundnummer at Bankgirot, from the Autogiro agreement.
  customer_number text NOT NULL CHECK (customer_number ~ '^[0-9]{1,6}$'),
  -- The bankgiro the debits are credited to, digits only.
  bankgiro text NOT NULL CHECK (bankgiro ~ '^[0-9]{7,8}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.autogiro_settings IS
  'The company''s Autogiro agreement: Bankgirot Kundnummer and the receiving bankgiro. No seal key: files are uploaded in the company''s own bank.';

ALTER TABLE public.autogiro_settings ENABLE ROW LEVEL SECURITY;

-- Members read their companies' rows; writes take the active company and a
-- writing role, as bank_transaction_parts. No member deletes: a mandate is
-- cancelled, a debit cancelled or withdrawn, and a file stays.

CREATE POLICY "autogiro_settings_select" ON public.autogiro_settings
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "autogiro_settings_insert" ON public.autogiro_settings
  FOR INSERT WITH CHECK (company_id = public.current_active_company_id() AND public.current_user_can_write());
CREATE POLICY "autogiro_settings_update" ON public.autogiro_settings
  FOR UPDATE USING (company_id = public.current_active_company_id() AND public.current_user_can_write())
  WITH CHECK (company_id = public.current_active_company_id() AND public.current_user_can_write());

GRANT SELECT, INSERT, UPDATE ON TABLE public.autogiro_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.autogiro_settings TO service_role;
-- no-grant: anon on public.autogiro_settings (company data)

CREATE TRIGGER autogiro_settings_updated_at
  BEFORE UPDATE ON public.autogiro_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 2. autogiro_mandates: customer <-> payer number, with Bankgirot's status
-- =============================================================================

CREATE TABLE public.autogiro_mandates (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Null until someone links the payer to a customer.
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  -- Betalarnummer without leading zeros (Bankgirot zero-fills it to 16).
  payer_number text NOT NULL CHECK (payer_number ~ '^(0|[1-9][0-9]{0,15})$'),
  -- pending: signed in the internet bank and not yet answered, or sent to
  -- Bankgirot and not yet confirmed. active: approved for Autogiro.
  status text NOT NULL CHECK (status IN ('pending', 'active', 'cancelled', 'rejected')),
  -- Where Accounted learnt of it: Bankgirot's register extract, a mandate
  -- notice, the internet-bank file, or typed in by the company.
  source text NOT NULL CHECK (source IN ('register', 'notice', 'internet_bank', 'manual')),
  -- The name the payer gave in its internet bank, to help linking.
  payer_name text CHECK (payer_name IS NULL OR length(payer_name) <= 200),
  -- Bankgirot's words for the latest status change.
  status_text text CHECK (status_text IS NULL OR length(status_text) <= 300),
  status_changed_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT autogiro_mandates_company_payer_key UNIQUE (company_id, payer_number)
);

COMMENT ON TABLE public.autogiro_mandates IS
  'Autogiro mandates on the company''s bankgiro: which customer each payer number belongs to and Bankgirot''s status. Never the payer''s account or personnummer.';

-- One active mandate per customer, so an invoice knows whom to debit.
CREATE UNIQUE INDEX autogiro_mandates_one_active_per_customer
  ON public.autogiro_mandates (company_id, customer_id)
  WHERE status = 'active' AND customer_id IS NOT NULL;
CREATE INDEX autogiro_mandates_customer ON public.autogiro_mandates (customer_id) WHERE customer_id IS NOT NULL;

ALTER TABLE public.autogiro_mandates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "autogiro_mandates_select" ON public.autogiro_mandates
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "autogiro_mandates_insert" ON public.autogiro_mandates
  FOR INSERT WITH CHECK (company_id = public.current_active_company_id() AND public.current_user_can_write());
CREATE POLICY "autogiro_mandates_update" ON public.autogiro_mandates
  FOR UPDATE USING (company_id = public.current_active_company_id() AND public.current_user_can_write())
  WITH CHECK (company_id = public.current_active_company_id() AND public.current_user_can_write());

GRANT SELECT, INSERT, UPDATE ON TABLE public.autogiro_mandates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.autogiro_mandates TO service_role;
-- no-grant: anon on public.autogiro_mandates (company data)

CREATE TRIGGER autogiro_mandates_updated_at
  BEFORE UPDATE ON public.autogiro_mandates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 3. autogiro_files: every file written for Bankgirot and every report read
-- =============================================================================

CREATE TABLE public.autogiro_files (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('to_bankgirot', 'from_bankgirot')),
  kind text NOT NULL CHECK (kind IN (
    'debits', 'mandates',
    'payment_specification', 'mandate_notice', 'rejected_payments', 'internet_bank_mandates', 'mandate_register'
  )),
  filename text CHECK (filename IS NULL OR length(filename) <= 255),
  -- sha256 of the file's text: the same report read twice is refused.
  file_hash text NOT NULL CHECK (file_hash ~ '^[0-9a-f]{64}$'),
  -- The file itself, only when it carries no personnummer or bank account
  -- (debit files, payment specifications, rejected payments). Mandate files
  -- and mandate reports are read and answered, never stored.
  content text CHECK (content IS NULL OR length(content) <= 2000000),
  -- What the file held or did: counts, sums, dates.
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.autogiro_files IS
  'Autogiro files the company wrote for Bankgirot and reports it read from Bankgirot. Content kept only for files without personal data.';

-- A report is read once. A file written for Bankgirot may repeat byte for
-- byte (withdrawn and written again the same day), so only reports count.
CREATE UNIQUE INDEX autogiro_files_report_once
  ON public.autogiro_files (company_id, file_hash)
  WHERE direction = 'from_bankgirot';
CREATE INDEX autogiro_files_company ON public.autogiro_files (company_id, created_at DESC);

ALTER TABLE public.autogiro_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "autogiro_files_select" ON public.autogiro_files
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "autogiro_files_insert" ON public.autogiro_files
  FOR INSERT WITH CHECK (company_id = public.current_active_company_id() AND public.current_user_can_write());

GRANT SELECT, INSERT ON TABLE public.autogiro_files TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.autogiro_files TO service_role;
-- no-grant: anon on public.autogiro_files (company data)

-- =============================================================================
-- 4. autogiro_debits: one debit of one invoice
-- =============================================================================

CREATE TABLE public.autogiro_debits (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  mandate_id uuid REFERENCES public.autogiro_mandates(id) ON DELETE SET NULL,
  payer_number text NOT NULL CHECK (payer_number ~ '^(0|[1-9][0-9]{0,15})$'),
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  -- The payment day written in the file; Bankgirot reports the day it ran.
  debit_date date NOT NULL,
  -- The invoice's OCR, returned in every report.
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 16),
  -- sent: in a file for Bankgirot. debited: Bankgirot took the money.
  -- failed: the payer's bank stopped it (no cover, account closed).
  -- rejected: Bankgirot refused it. cancelled: the company withdrew it.
  -- refunded: the payer got the money back after it was debited.
  status text NOT NULL CHECK (status IN ('sent', 'debited', 'failed', 'rejected', 'cancelled', 'refunded')),
  status_text text CHECK (status_text IS NULL OR length(status_text) <= 300),
  -- The day Bankgirot reported the outcome.
  status_date date,
  file_id uuid REFERENCES public.autogiro_files(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.autogiro_debits IS
  'Each Autogiro debit of a customer invoice: written into a file for Bankgirot, then debited, failed, rejected, cancelled or refunded per Bankgirot''s reports.';

-- An invoice is in at most one live debit: never asked for twice.
CREATE UNIQUE INDEX autogiro_debits_one_live_per_invoice
  ON public.autogiro_debits (invoice_id)
  WHERE status IN ('sent', 'debited');
CREATE INDEX autogiro_debits_company_status ON public.autogiro_debits (company_id, status, debit_date);
CREATE INDEX autogiro_debits_file ON public.autogiro_debits (file_id) WHERE file_id IS NOT NULL;

ALTER TABLE public.autogiro_debits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "autogiro_debits_select" ON public.autogiro_debits
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "autogiro_debits_insert" ON public.autogiro_debits
  FOR INSERT WITH CHECK (company_id = public.current_active_company_id() AND public.current_user_can_write());
CREATE POLICY "autogiro_debits_update" ON public.autogiro_debits
  FOR UPDATE USING (company_id = public.current_active_company_id() AND public.current_user_can_write())
  WITH CHECK (company_id = public.current_active_company_id() AND public.current_user_can_write());

GRANT SELECT, INSERT, UPDATE ON TABLE public.autogiro_debits TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.autogiro_debits TO service_role;
-- no-grant: anon on public.autogiro_debits (company data)

CREATE TRIGGER autogiro_debits_updated_at
  BEFORE UPDATE ON public.autogiro_debits
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 5. invoices.autogiro_payer_number: the invoice says it is debited
-- =============================================================================

ALTER TABLE public.invoices
  ADD COLUMN autogiro_payer_number text
  CHECK (autogiro_payer_number IS NULL OR autogiro_payer_number ~ '^(0|[1-9][0-9]{0,15})$');

COMMENT ON COLUMN public.invoices.autogiro_payer_number IS
  'Set while the invoice is a draft from its customer''s active Autogiro mandate, frozen at issue: the invoice told the customer it is debited by Autogiro on this payer number. Null: never debited.';

-- A draft follows its customer's active mandate; an issued invoice keeps what
-- its draft said. Only a SEK faktura is debited (no credit notes, quotes,
-- proformas or delivery notes).
CREATE OR REPLACE FUNCTION public.invoices_sync_autogiro_payer_number()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM 'draft' THEN
    NEW.autogiro_payer_number := OLD.autogiro_payer_number;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM 'draft' THEN
    -- Issued now (the draft's value stands) or inserted already issued (an
    -- import: it never told the customer about Autogiro).
    IF TG_OP = 'INSERT' THEN
      NEW.autogiro_payer_number := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.document_type IS DISTINCT FROM 'invoice'
     OR NEW.credited_invoice_id IS NOT NULL
     OR NEW.currency IS DISTINCT FROM 'SEK'
     OR NEW.customer_id IS NULL THEN
    NEW.autogiro_payer_number := NULL;
    RETURN NEW;
  END IF;
  NEW.autogiro_payer_number := (
    SELECT m.payer_number
    FROM public.autogiro_mandates m
    WHERE m.company_id = NEW.company_id
      AND m.customer_id = NEW.customer_id
      AND m.status = 'active'
    LIMIT 1
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_sync_autogiro_payer_number
  BEFORE INSERT OR UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_sync_autogiro_payer_number();

-- A mandate that becomes active, ends or moves to another customer updates
-- that customer's drafts; issued invoices never change.
CREATE OR REPLACE FUNCTION public.autogiro_mandates_refresh_drafts()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE public.invoices i
  SET autogiro_payer_number = (
    SELECT m.payer_number
    FROM public.autogiro_mandates m
    WHERE m.company_id = i.company_id
      AND m.customer_id = i.customer_id
      AND m.status = 'active'
    LIMIT 1
  )
  WHERE i.company_id = NEW.company_id
    AND i.status = 'draft'
    AND i.customer_id IN (NEW.customer_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.customer_id END)
    AND i.autogiro_payer_number IS DISTINCT FROM (
      SELECT m.payer_number
      FROM public.autogiro_mandates m
      WHERE m.company_id = i.company_id
        AND m.customer_id = i.customer_id
        AND m.status = 'active'
      LIMIT 1
    );
  RETURN NULL;
END;
$$;

CREATE TRIGGER autogiro_mandates_refresh_drafts
  AFTER INSERT OR UPDATE OF status, customer_id ON public.autogiro_mandates
  FOR EACH ROW EXECUTE FUNCTION public.autogiro_mandates_refresh_drafts();

NOTIFY pgrst, 'reload schema';
