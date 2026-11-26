-- account_reconciliation_attachments: a member's write names a file in the
-- company's own folder of the documents bucket.
--
-- attachUnderlag (src/lib/reconciliation/attachments.ts) is the one writer of
-- these rows. It builds the key itself, documents/{company_id}/reconciliation/
-- ..., uploads the file there and inserts the row, both with the member's own
-- token. Every read of the file goes through isCompanyFolderObject
-- (src/lib/core/documents/storage-key.ts), which follows no other bucket or
-- key. The insert policy checks the uploader and the company only, so until
-- now a row written straight to the table with a member's token could name any
-- bucket and any key.
--
-- A write made with a member's own token may give a row only:
--
--   * the documents bucket; and
--   * a key in the row company's own folder, documents/{company_id}/..., with
--     no empty, "." or ".." part and no control character, \, %, ? or #:
--     Storage builds its request URL from the key as written.
--
-- Anything else is refused with 42501. This is the rule of
-- isCompanyFolderObject in TypeScript, held a little tighter where no upload
-- goes: the company id only as the database writes it (lower case), and
-- [[:cntrl:]] also takes the C1 control characters. The register entry is
-- scripts/checks/one-definition/document-key-of-company.mjs.
--
-- Only the insert is checked: trg_account_reconciliation_attachments_freeze
-- (20260824200000) already refuses any later change to the company, the bucket
-- or the key, for every caller. Server code (the service role, migrations,
-- scripts) is not checked, as in guard_document_storage_path
-- (20261123092000). Existing rows are not checked again and nothing is
-- rewritten.
--
-- pg-test: covered-by tests/pg/reconciliation-attachment-key-inside-company.pg.test.ts

CREATE OR REPLACE FUNCTION public.guard_reconciliation_attachment_storage_path()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT public.jwt_caller_is_end_user() THEN
    RETURN NEW;
  END IF;

  IF NEW.storage_bucket = 'documents'
     AND NEW.storage_path !~ '[[:cntrl:]\\%?#]'
     AND NEW.storage_path !~ '(^|/)(\.{1,2})?(/|$)'
     AND starts_with(NEW.storage_path, 'documents/' || NEW.company_id::text || '/') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'storage_path must be a file in the company''s own folder of the documents bucket'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_reconciliation_attachment_storage_path() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.guard_reconciliation_attachment_storage_path() IS
  'A member''s reconciliation attachment names a file in its company''s own folder of the documents bucket: the rule of isCompanyFolderObject in src/lib/core/documents/storage-key.ts.';

DROP TRIGGER IF EXISTS guard_reconciliation_attachment_storage_path ON public.account_reconciliation_attachments;
CREATE TRIGGER guard_reconciliation_attachment_storage_path
  BEFORE INSERT ON public.account_reconciliation_attachments
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_reconciliation_attachment_storage_path();
