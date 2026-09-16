-- Arkiv phase 8 (dev_docs/arkiv_plan.md): the record is read on demand.
-- An agent or a person asks a document a question; the reader answers from
-- the page text with a page and a quote and the question is an activity of
-- its own, so the trail shows what was asked of which document by whom.
ALTER TABLE public.activities DROP CONSTRAINT activities_kind_check;
ALTER TABLE public.activities ADD CONSTRAINT activities_kind_check CHECK (kind IN ('extract', 'review', 'derive', 'ask'));
