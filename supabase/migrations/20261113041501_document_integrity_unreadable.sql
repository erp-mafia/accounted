-- document_integrity_checks.result gains 'unreadable': storage refuses the
-- document at every key with something other than "not found" (a 403), so
-- neither a pass nor a missing object can be recorded. (A 400 InvalidKey says
-- nothing can be at that key: the cron counts it as not found.)
--
-- The nightly integrity check (app/api/documents/verify/cron) wrote no ledger
-- row for such a document, so it stayed first in the queue
-- (next_documents_for_integrity_check orders by the newest check, never
-- checked first): five of them stopped every night's run at document five,
-- and nothing behind them was ever verified. Recording the outcome moves the
-- document behind the others; it is tried again when its turn comes, and the
-- cron reports it once, when it first becomes unreadable.
--
-- 'unreadable' is not a loss of the document: the cron writes no
-- INTEGRITY_FAILURE audit row for it, and DOCUMENT_OBJECT_MISSING is still
-- written only when every storage key answered "not found". The table stays
-- append-only (document_integrity_check_immutable); only the CHECK changes.
--
-- pg-test: tests/pg/document-integrity-checks.pg.test.ts

ALTER TABLE public.document_integrity_checks
  DROP CONSTRAINT document_integrity_checks_result_check;

ALTER TABLE public.document_integrity_checks
  ADD CONSTRAINT document_integrity_checks_result_check
  CHECK (result IN ('passed', 'hash_mismatch', 'object_missing', 'unreadable'));

NOTIFY pgrst, 'reload schema';
