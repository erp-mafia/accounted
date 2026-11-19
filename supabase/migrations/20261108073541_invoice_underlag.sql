-- Underlag behind a customer invoice (accounted#42, phase 1).
-- pg-test: tests/pg/invoice-underlag.pg.test.ts
--
-- A contractor invoices material bought for one job from a wholesaler. When
-- the end customer later asks what the material line rests on, the
-- contractor opens the customer invoice and finds the wholesaler's invoices
-- there. Each row links one document of the archive (document_attachments)
-- to one invoice, in any state of the invoice: the question usually comes
-- after the invoice went out.
--
-- This is a reference, never a move. The document keeps its own verifikat
-- link (journal_entry_id) untouched, so a supplier invoice's underlag stays
-- on the supplier invoice's verifikat; one document can back several
-- customer invoices and one invoice can rest on several documents.
--
-- Not invoice_attachments (20261016224500): those are the files that go out
-- with every send of the invoice and are frozen once it is issued, because
-- they are what the customer received. Underlag is internal and goes out
-- with nothing; it can be added or removed at any time, and removing a link
-- leaves the document in the archive. Sending chosen underlag is a later
-- phase of accounted#42.
--
-- Every foreign key cascades: deleting an invoice draft or a document the
-- archive lets go of takes the link with it. The audit trigger records who
-- added and removed each link.

CREATE TABLE public.invoice_underlag (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id  uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.document_attachments(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_underlag_invoice_document_key UNIQUE (invoice_id, document_id)
);

COMMENT ON TABLE public.invoice_underlag IS
  'Archived documents a customer invoice rests on (e.g. the wholesaler invoices behind invoiced material). A reference only: the document keeps its own verifikat link, and nothing here is sent to the customer (accounted#42).';

CREATE INDEX idx_invoice_underlag_company ON public.invoice_underlag (company_id);
CREATE INDEX idx_invoice_underlag_document ON public.invoice_underlag (document_id);

ALTER TABLE public.invoice_underlag ENABLE ROW LEVEL SECURITY;

CREATE POLICY invoice_underlag_select
  ON public.invoice_underlag FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY invoice_underlag_insert
  ON public.invoice_underlag FOR INSERT
  WITH CHECK (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
  );

CREATE POLICY invoice_underlag_delete
  ON public.invoice_underlag FOR DELETE
  USING (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
  );

-- No UPDATE policy: a link is added or removed, never rewritten.
GRANT SELECT, INSERT, DELETE ON TABLE public.invoice_underlag TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.invoice_underlag TO service_role;
-- no-grant: anon on public.invoice_underlag (company-scoped: members only)

-- Both ends belong to the row's company, whoever writes it: the v1 and MCP
-- doors use the service role, where RLS does not apply.
CREATE OR REPLACE FUNCTION public.guard_invoice_underlag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'invoice underlag links are never rewritten: remove the link and add another'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = NEW.invoice_id AND i.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'invoice underlag invoice/company mismatch'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.document_attachments d
    WHERE d.id = NEW.document_id AND d.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'invoice underlag document/company mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_invoice_underlag() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER guard_invoice_underlag
  BEFORE INSERT OR UPDATE ON public.invoice_underlag
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_underlag();

CREATE TRIGGER audit_invoice_underlag
  AFTER INSERT OR DELETE ON public.invoice_underlag
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

NOTIFY pgrst, 'reload schema';
