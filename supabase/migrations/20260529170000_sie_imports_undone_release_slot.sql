-- Extend the active-import partial unique index to also release the
-- (company_id, file_hash) slot when a row is marked 'undone'.
--
-- Background: 20260528120100_undo_sie_import.sql introduced the 'undone'
-- status (set by undo_sie_import RPC) but the partial unique index from
-- 20260517150000_sie_imports_active_partial_unique.sql still only
-- excluded 'replaced' and 'failed'. Net effect: a clean undo left the
-- file_hash slot held, so the caller could not re-import the same file
-- afterwards without going through replace_sie_import. Add 'undone' to
-- the predicate so undo + retry works.
--
-- Backfill: prior to this migration, the executor would mark an import
-- 'completed' even when journal_entries_created=0 (see Lookma AB support
-- case 2026-05-28). Those rows hold the slot and block any retry. The
-- companion code change in finalizeImportRecord prevents new occurrences;
-- this backfill heals existing data by flipping every 'completed' row
-- that produced literally zero entries to 'failed' (which the partial
-- index already excludes). Safe by construction — no journal entries
-- were ever created for these rows, so nothing downstream depends on
-- their 'completed' status.

DROP INDEX IF EXISTS public.sie_imports_company_id_file_hash_active_idx;

CREATE UNIQUE INDEX sie_imports_company_id_file_hash_active_idx
  ON public.sie_imports (company_id, file_hash)
  WHERE status <> ALL (ARRAY['replaced'::text, 'failed'::text, 'undone'::text]);

UPDATE public.sie_imports
   SET status = 'failed',
       error_message = COALESCE(error_message || '; ', '')
                    || 'Backfill 2026-05-29: importen markerades som '
                    || '''completed'' men skapade 0 verifikationer. '
                    || 'Slot frigjord så filen kan importeras om med korrekta mappningar.'
 WHERE status = 'completed'
   AND transactions_count = 0
   AND opening_balance_entry_id IS NULL;

NOTIFY pgrst, 'reload schema';
