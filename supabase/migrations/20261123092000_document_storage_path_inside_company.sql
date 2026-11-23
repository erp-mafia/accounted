-- document_attachments.storage_path: a member's write keeps the key inside the
-- row's own company.
--
-- A write made with a member's own token may give a document row only:
--
--   * a key in the company's own folder, documents/{company_id}/..., where
--     every upload since 20260726092000 lands; or
--   * a key another row of the same company already holds: the copies that
--     put one stored file on a second verifikat (an utlägg booked again, an
--     invoice PDF on its payment verifikat) and the legacy uploader keys,
--     documents/{user_id}/{file}, written before the company layout.
--
-- A key with an empty, "." or ".." part, or with a control character, \, %, ?
-- or #, is refused either way: Storage builds its request URL from the key as
-- written.
--
-- The same rule in TypeScript is src/lib/core/documents/storage-key.ts
-- (isDocumentKeyOfCompany), which every service-role read, signature and
-- removal of a document key goes through; create_document_version
-- (20261016180700) checks its own key against the company folder too. The
-- register entry is scripts/checks/one-definition/document-key-of-company.mjs.
--
-- Server code (the service role, migrations, scripts) builds its keys itself
-- and is not checked here, as in enforce_company_writer_role. A write that
-- leaves the key and the company as they are passes untouched, so existing
-- rows keep every other update. Existing rows are not checked again and
-- nothing is rewritten.
--
-- pg-test: covered-by tests/pg/document-storage-path-inside-company.pg.test.ts

CREATE OR REPLACE FUNCTION public.guard_document_storage_path()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.jwt_caller_is_end_user() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.storage_path IS NOT DISTINCT FROM OLD.storage_path
     AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id THEN
    RETURN NEW;
  END IF;

  IF NEW.storage_path !~ '[[:cntrl:]\\%?#]'
     AND NEW.storage_path !~ '(^|/)(\.{1,2})?(/|$)'
     AND (
       starts_with(NEW.storage_path, 'documents/' || NEW.company_id::text || '/')
       OR EXISTS (
         SELECT 1
         FROM public.document_attachments d
         WHERE d.company_id = NEW.company_id
           AND d.storage_path = NEW.storage_path
           AND d.id IS DISTINCT FROM NEW.id
       )
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'storage_path must be a file of the document''s own company'
    USING ERRCODE = '42501';
END;
$$;

COMMENT ON FUNCTION public.guard_document_storage_path() IS
  'A member''s document row keeps storage_path inside its own company: the company folder, or a key another row of the company already holds. Same rule as src/lib/core/documents/storage-key.ts.';

DROP TRIGGER IF EXISTS guard_document_storage_path ON public.document_attachments;
CREATE TRIGGER guard_document_storage_path
  BEFORE INSERT OR UPDATE OF storage_path, company_id ON public.document_attachments
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_document_storage_path();
