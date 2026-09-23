-- Arkiv: documents stamped by a reader that could not be loaded are unread.
--
-- Between phase 1 reaching production (2026-09-21 16:42 UTC) and the fix in
-- #2880, every PDF the read path touched was stamped with
-- "read_failed: Failed to load external module @firecrawl/pdf-inspector…":
-- the Linux build of the reader needs glibc 2.35 and the hosted runtime has
-- 2.34. That says nothing about the document, and a stamped row is never
-- revisited, so the stamp is taken off again. Since #2880 such a failure no
-- longer stamps anything, so this runs once and stays true.
--
-- Only Arkiv's own bookkeeping columns on the row are touched; no file, no
-- page text (none was ever written for these rows) and nothing in the ledger.

UPDATE public.document_attachments
SET pages_read_at = NULL,
    page_count = NULL,
    read_error = NULL
WHERE read_error LIKE 'read_failed: Failed to load external module%';
