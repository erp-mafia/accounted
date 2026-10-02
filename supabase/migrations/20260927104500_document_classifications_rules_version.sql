-- Which rule set typed a document (2026-09-27).
--
-- A classifier fix used to be forward-only: the six supplier invoices under
-- Arcim's Kundfakturor were model verdicts from 2026-09-21, three rule
-- changes old, and nothing re-ran them. The prompt hash on the row cannot
-- tell an old rule set from a new one (it covers the document's own text),
-- so the row now carries the rule set's version (lib/documents/classify/
-- rules.ts). The classify cron re-runs model verdicts made under an older
-- one, for the types that rule change touched, a bounded batch at a time.
-- Rows from before this column keep NULL and count as older than every
-- version.
ALTER TABLE public.document_classifications ADD COLUMN IF NOT EXISTS rules_version text;

COMMENT ON COLUMN public.document_classifications.rules_version IS
  'CLASSIFY_RULES.version (lib/documents/classify/rules.ts) in force when the row was written; NULL before 2026-09-27. A model verdict under an older version is re-run by the classify cron for the types that changed.';

NOTIFY pgrst, 'reload schema';
