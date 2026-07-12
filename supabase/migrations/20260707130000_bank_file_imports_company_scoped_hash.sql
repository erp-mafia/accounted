-- bank_file_imports dedup key: (user_id, file_hash) -> (company_id, file_hash).
-- The old key predates multi-tenancy: it blocked the same user from importing
-- the same statement file into two different companies (upsert resolved onto
-- the other company's row, and RLS correctly rejected the cross-company
-- UPDATE with 42501). The 20260330130000 refactor made this exact swap for
-- sie_imports but missed bank_file_imports. Verified in prod before this
-- migration: no duplicate (company_id, file_hash) pairs exist.
ALTER TABLE public.bank_file_imports
  DROP CONSTRAINT IF EXISTS bank_file_imports_user_id_file_hash_key;
ALTER TABLE public.bank_file_imports
  ADD CONSTRAINT bank_file_imports_company_id_file_hash_key
  UNIQUE (company_id, file_hash);

NOTIFY pgrst, 'reload schema';
