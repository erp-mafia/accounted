-- Arkiv phase 9, the agent door: the archive asks for what the books say should exist.
--
-- A finding of kind document_expected is derived nightly from ledger evidence (a cost
-- that recurs, a balance that keeps moving) with no agreement of the matching kind in
-- the archive. A person or an agent closes it as dismissed with a note that the lint
-- remembers by key (not_exists, not_applicable), or as resolved after an upload.

ALTER TABLE public.arkiv_findings DROP CONSTRAINT arkiv_findings_kind_check;
ALTER TABLE public.arkiv_findings
  ADD CONSTRAINT arkiv_findings_kind_check
  CHECK (kind IN ('settings_mismatch', 'agreement_ending', 'agreement_no_counterparty', 'agreement_duplicate', 'duplicate_document', 'document_stuck', 'document_expected'));

ALTER TABLE public.arkiv_findings
  ADD COLUMN resolution_note text
  CHECK (resolution_note IS NULL OR resolution_note IN ('not_exists', 'not_applicable', 'uploaded'));

COMMENT ON COLUMN public.arkiv_findings.resolution_note IS
  'Arkiv phase 9: why a document_expected finding was closed. not_exists and not_applicable are dismissals the lint never reopens; uploaded is a resolution after the document arrived.';
