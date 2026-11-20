-- Extra files that go out with a customer invoice email (crm#1269).
-- pg-test: tests/pg/invoice-attachments.pg.test.ts
--
-- An invoice can carry files besides its own PDF: a time report, a
-- specification, a copy of a receipt that is invoiced onward. Each row links
-- one document of the archive (document_attachments, written by the existing
-- upload pipeline) to one invoice, and every email delivery of the invoice
-- attaches the linked files after the invoice PDF.
--
-- The set can change only while the invoice is a draft that has never been
-- emailed. Once the invoice is issued (any status but draft) or an email
-- delivery of it went out, the links are fixed and their documents can no
-- longer be deleted from the archive: what the customer received with the
-- invoice is räkenskapsinformation kept for the BFL 7 kap period. Before
-- that, removing an attachment removes only the link; the uploaded file stays
-- in the archive like any other upload.
--
-- Every foreign key cascades. A draft can be deleted and takes its links
-- with it (the guard lets a delete through once the invoice row is gone).
-- The sandbox teardown deletes documents before invoices; both guards honour
-- its window (gnubok.sandbox_cleanup, re-verified per row through
-- company_settings.is_sandbox, the enforce_salary_payment_files_worm pattern).

CREATE TABLE public.invoice_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id  uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.document_attachments(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_attachments_invoice_document_key UNIQUE (invoice_id, document_id)
);

COMMENT ON TABLE public.invoice_attachments IS
  'Archived documents emailed with a customer invoice after its PDF. Fixed once the invoice is issued or emailed (crm#1269).';

CREATE INDEX idx_invoice_attachments_company ON public.invoice_attachments (company_id);
CREATE INDEX idx_invoice_attachments_document ON public.invoice_attachments (document_id);

ALTER TABLE public.invoice_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY invoice_attachments_select
  ON public.invoice_attachments FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY invoice_attachments_insert
  ON public.invoice_attachments FOR INSERT
  WITH CHECK (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
  );

CREATE POLICY invoice_attachments_delete
  ON public.invoice_attachments FOR DELETE
  USING (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
  );

-- No UPDATE policy: a link is added or removed, never rewritten.
GRANT SELECT, INSERT, DELETE ON TABLE public.invoice_attachments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.invoice_attachments TO service_role;
-- no-grant: anon on public.invoice_attachments (company-scoped: members only)

-- True once the invoice's attachments are part of what the customer
-- received: the invoice left draft, or an email delivery of it went out.
CREATE OR REPLACE FUNCTION public.invoice_attachments_fixed(p_invoice_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = p_invoice_id AND i.status <> 'draft'
  ) OR EXISTS (
    SELECT 1 FROM public.invoice_deliveries d
    WHERE d.invoice_id = p_invoice_id AND d.status = 'sent'
  );
$$;

REVOKE ALL ON FUNCTION public.invoice_attachments_fixed(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_invoice_attachment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'invoice attachments are never rewritten: remove the link and add another'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.invoices i
      WHERE i.id = NEW.invoice_id AND i.company_id = NEW.company_id
    ) THEN
      RAISE EXCEPTION 'invoice attachment invoice/company mismatch'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.document_attachments d
      WHERE d.id = NEW.document_id AND d.company_id = NEW.company_id
    ) THEN
      RAISE EXCEPTION 'invoice attachment document/company mismatch'
        USING ERRCODE = '23514';
    END IF;
    IF public.invoice_attachments_fixed(NEW.invoice_id) THEN
      RAISE EXCEPTION 'invoice attachments are fixed once the invoice is issued or emailed'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- DELETE. The sandbox teardown removes the whole company.
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND EXISTS (
       SELECT 1 FROM public.company_settings cs
       WHERE cs.company_id = OLD.company_id AND cs.is_sandbox = true
     ) THEN
    RETURN OLD;
  END IF;

  -- A cascade from a deleted draft: the invoice row is already gone.
  IF NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = OLD.invoice_id) THEN
    RETURN OLD;
  END IF;

  IF public.invoice_attachments_fixed(OLD.invoice_id) THEN
    RAISE EXCEPTION 'retention: an issued or emailed invoice keeps the files it was sent with'
      USING ERRCODE = '23514';
  END IF;

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_invoice_attachment() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER guard_invoice_attachment
  BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_attachments
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_attachment();

-- The archive side of the same rule: a document an issued or emailed invoice
-- holds as an attachment cannot be deleted. The 'retention' wording is what
-- deleteDocument() maps to its Swedish BFL refusal.
CREATE OR REPLACE FUNCTION public.block_invoice_attachment_document_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND EXISTS (
       SELECT 1 FROM public.company_settings cs
       WHERE cs.company_id = OLD.company_id AND cs.is_sandbox = true
     ) THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.invoice_attachments a
    WHERE a.document_id = OLD.id
      AND public.invoice_attachments_fixed(a.invoice_id)
  ) THEN
    RAISE EXCEPTION 'retention: document was sent as an attachment with a customer invoice'
      USING ERRCODE = '23514';
  END IF;

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.block_invoice_attachment_document_deletion() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER block_invoice_attachment_document_deletion
  BEFORE DELETE ON public.document_attachments
  FOR EACH ROW EXECUTE FUNCTION public.block_invoice_attachment_document_deletion();

CREATE TRIGGER audit_invoice_attachments
  AFTER INSERT OR DELETE ON public.invoice_attachments
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

NOTIFY pgrst, 'reload schema';
