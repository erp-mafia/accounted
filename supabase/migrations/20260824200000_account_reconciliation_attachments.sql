-- Underlag for account reconciliation: the bank statement, engagemangsbesked,
-- reskontralista, inventering or any other document a balance account was
-- reconciled against, attached to (company, account_key, through_date), the
-- same scope a sign-off (account_reconciliations) attests. A file can be
-- attached before the sign-off exists (attach the statement, then sign) and
-- stays with the balansdag afterwards; together they are the bokslutsbilaga
-- Reko 140/760/765 ask a redovisningskonsult to keep per balanspost.
--
-- Räkenskapsinformation once it backs a bokslut (BFL 7 kap.), so rows are
-- never deleted: a wrongly attached file gets a removal stamp (removed_at/by/
-- reason), the storage object stays, and the pärm export lists it as removed.
-- Every column but the removal stamp is frozen by trigger.

CREATE TABLE IF NOT EXISTS public.account_reconciliation_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  account_key TEXT NOT NULL
    CHECK (account_key ~ '^(bank:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|skattekonto|manual:[0-9]{4})$'),
  -- The balansdag the file documents (inclusive), matching account_reconciliations.through_date.
  through_date DATE NOT NULL,
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  storage_bucket TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  -- Content hash, so the pärm and the full archive can prove the file is the one that was attached.
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- What the file is ("Kontoutdrag december", "Engagemangsbesked 2026-12-31").
  note TEXT,
  uploaded_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at TIMESTAMPTZ,
  removed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  removed_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT account_reconciliation_attachments_removal_pair
    CHECK ((removed_at IS NULL) = (removed_by IS NULL)),
  CONSTRAINT account_reconciliation_attachments_storage_path_unique UNIQUE (storage_bucket, storage_path)
);

COMMENT ON TABLE public.account_reconciliation_attachments IS
  'Underlag attached to a reconciliation balansdag (account_key + through_date): the bokslutsbilaga files. Append-only; removal stamps instead of deleting (BFL 7 kap.).';

-- "Files for this account and balansdag" is the read on every status page and in the pärm.
CREATE INDEX IF NOT EXISTS idx_account_reconciliation_attachments_scope
  ON public.account_reconciliation_attachments (company_id, account_key, through_date)
  WHERE removed_at IS NULL;

-- The pärm lists every balansdag of a fiscal period in one query.
CREATE INDEX IF NOT EXISTS idx_account_reconciliation_attachments_company_date
  ON public.account_reconciliation_attachments (company_id, through_date);

-- Only the removal stamp may change after insert; everything else is the record.
CREATE OR REPLACE FUNCTION public.account_reconciliation_attachments_freeze()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.account_key IS DISTINCT FROM OLD.account_key
     OR NEW.through_date IS DISTINCT FROM OLD.through_date
     OR NEW.file_name IS DISTINCT FROM OLD.file_name
     OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
     OR NEW.storage_bucket IS DISTINCT FROM OLD.storage_bucket
     OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
     OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'account_reconciliation_attachments rows are append-only; only the removal stamp may change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.removed_at IS NOT NULL AND (
       NEW.removed_at IS DISTINCT FROM OLD.removed_at
       OR NEW.removed_by IS DISTINCT FROM OLD.removed_by
       OR NEW.removed_reason IS DISTINCT FROM OLD.removed_reason) THEN
    RAISE EXCEPTION 'a removed attachment cannot be restored or re-stamped'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_account_reconciliation_attachments_freeze ON public.account_reconciliation_attachments;
CREATE TRIGGER trg_account_reconciliation_attachments_freeze
  BEFORE UPDATE ON public.account_reconciliation_attachments
  FOR EACH ROW EXECUTE FUNCTION public.account_reconciliation_attachments_freeze();

CREATE OR REPLACE FUNCTION public.account_reconciliation_attachments_no_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'account_reconciliation_attachments rows are never deleted (BFL 7 kap.); stamp removed_at instead'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_account_reconciliation_attachments_no_delete ON public.account_reconciliation_attachments;
CREATE TRIGGER trg_account_reconciliation_attachments_no_delete
  BEFORE DELETE ON public.account_reconciliation_attachments
  FOR EACH ROW EXECUTE FUNCTION public.account_reconciliation_attachments_no_delete();

ALTER TABLE public.account_reconciliation_attachments ENABLE ROW LEVEL SECURITY;

-- Every member of the company sees the underlag; owners, admins and members
-- attach and remove (viewers look but do not touch). requireWrite on the
-- routes is the first layer; this is defense in depth.
DROP POLICY IF EXISTS "account_reconciliation_attachments_select" ON public.account_reconciliation_attachments;
CREATE POLICY "account_reconciliation_attachments_select" ON public.account_reconciliation_attachments
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

DROP POLICY IF EXISTS "account_reconciliation_attachments_insert" ON public.account_reconciliation_attachments;
CREATE POLICY "account_reconciliation_attachments_insert" ON public.account_reconciliation_attachments
  FOR INSERT WITH CHECK (
    uploaded_by = auth.uid()
    AND company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS "account_reconciliation_attachments_update" ON public.account_reconciliation_attachments;
CREATE POLICY "account_reconciliation_attachments_update" ON public.account_reconciliation_attachments
  FOR UPDATE USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin', 'member')
    )
  );

NOTIFY pgrst, 'reload schema';
