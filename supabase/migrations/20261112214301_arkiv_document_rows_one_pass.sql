-- The Dokument tree reads a company's archive in one pass (2026-11-12).
--
-- arkiv_document_type_counts and arkiv_document_page ran three lookups for
-- every document the company has, on every call:
--   1. arkiv_effective_doc_type(...), a SQL function with SET search_path,
--      which Postgres never inlines: one function execution per document
--      (twice for a document in the folder being paged);
--   2. arkiv_document_day(...), the same, once per document dated;
--   3. the verifikat's date, one journal_entries_pkey probe per booked
--      document. journal_entries is a large table under random uuid keys,
--      so each probe lands on a cold index leaf and a cold heap page.
-- 20261027185323 made step 3 a probe (it was a scan of every company's
-- entries); the cost still follows the company's whole archive, with a large
-- constant:
--   * arkiv_document_page reads and dates every document of the company to
--     return one page of one folder;
--   * arkiv_document_type_counts does the same to count them, also when no
--     year is asked for and no date is needed;
--   * the verifikat-date probes are the largest single part of the cost.
-- Both run on every Arkiv view. The time grows in step with the archive, so
-- the page runs into the statement timeout as an archive grows: it stops
-- opening for the companies with the most documents first.
--
-- Now one function, arkiv_document_rows, reads the archive once and both
-- callers select from it:
--   * the effective type is a join to the document's current classification
--     (unique per document), not a function call per row;
--   * the document date is one CASE expression, written once, here;
--   * the verifikat dates are read from the company's own entries in one
--     index range scan (idx_journal_entries_company_date_voucher holds
--     company_id, entry_date and id) and hash-joined, when the company has
--     2 000 booked documents or more. Below that the per-document probe is
--     cheaper (at most 2 000 probes, about 70 ms) and a company with a large
--     ledger and a handful of documents does not pay for a scan of its ledger.
--     Above it, one range scan of even a very large ledger takes a fraction
--     of the time the probes took;
--   * the counts skip dates entirely when no year is asked for.
-- The cost still grows with the company's archive, at roughly a fifth of
-- the old constant, which leaves a wide margin to the statement timeout.
-- Bounding a page by the page (an index on a stored document date) needs
-- that date kept on write from three tables; that is a read model, and
-- the next step if a company passes a few hundred thousand documents. It
-- is not built here: this migration changes how the archive is read, not
-- what is stored.
--
-- arkiv_effective_doc_type and arkiv_document_day had no other caller
-- (pg_proc, views, policies and indexes checked) and are dropped: the type
-- rule and the date rule now have one home each, below.
-- Signatures and results of the two public functions are unchanged
-- (tests/pg/arkiv-folder-pages.pg.test.ts).

CREATE OR REPLACE FUNCTION public.arkiv_document_rows(p_company_id uuid, p_with_day boolean)
RETURNS TABLE (id uuid, created_at timestamptz, doc_type text, booked boolean, doc_day text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH docs AS MATERIALIZED (
    SELECT d.id,
           d.created_at,
           d.journal_entry_id,
           d.journal_entry_line_id,
           (d.journal_entry_id IS NOT NULL OR d.journal_entry_line_id IS NOT NULL) AS booked,
           -- The effective type: the type on the row, else, for a booked
           -- document, the type its current classification carries (a closed
           -- period keeps the type off the row; lib/documents/locked-period.ts).
           COALESCE(d.doc_type, c.doc_type) AS doc_type,
           -- Only a receipt or an invoice is dated by the date read off it.
           CASE
             WHEN p_with_day IS NOT FALSE AND COALESCE(d.doc_type, c.doc_type) IN ('receipt', 'supplier_invoice', 'customer_invoice')
               THEN d.extracted_data -> 'invoice' ->> 'invoiceDate'
           END AS invoice_date
    FROM public.document_attachments d
    LEFT JOIN public.document_classifications c
      ON c.document_id = d.id
     AND c.is_current
     AND c.company_id = p_company_id
     AND d.doc_type IS NULL
     AND (d.journal_entry_id IS NOT NULL OR d.journal_entry_line_id IS NOT NULL)
    WHERE d.company_id = p_company_id
      AND d.admission_state IN ('admitted', 'held')
      AND (d.mime_type IS NULL OR d.mime_type NOT IN ('application/xml', 'text/xml', 'application/json'))
  ),
  -- The company's verifikat dates in one range scan, when there are enough
  -- booked documents for that to beat a probe per document. MATERIALIZED
  -- keeps the company filter inside the scan: joined directly, a generic plan
  -- hash-joined every company's entries (20261027185323).
  entry_dates AS MATERIALIZED (
    SELECT e.id, e.entry_date
    FROM public.journal_entries e
    WHERE p_with_day IS NOT FALSE
      AND e.company_id = p_company_id
      AND (SELECT count(*) FROM docs WHERE docs.journal_entry_id IS NOT NULL) >= 2000
  )
  SELECT d.id,
         d.created_at,
         d.doc_type,
         d.booked,
         CASE
           WHEN p_with_day IS FALSE THEN NULL
           WHEN d.invoice_date ~ '^\d{4}-\d{2}-\d{2}' THEN left(d.invoice_date, 10)
           ELSE to_char(
             COALESCE(
               -- A booked document is dated by its verifikat: the one it names,
               -- else the one whose line it names.
               CASE
                 WHEN d.journal_entry_id IS NOT NULL THEN
                   COALESCE(ed.entry_date, (SELECT e.entry_date FROM public.journal_entries e WHERE e.id = d.journal_entry_id))
                 WHEN d.journal_entry_line_id IS NOT NULL THEN
                   (SELECT e.entry_date FROM public.journal_entry_lines l JOIN public.journal_entries e ON e.id = l.journal_entry_id WHERE l.id = d.journal_entry_line_id)
               END,
               (d.created_at AT TIME ZONE 'UTC')::date
             ),
             'YYYY-MM-DD'
           )
         END AS doc_day
  FROM docs d
  LEFT JOIN entry_dates ed ON ed.id = d.journal_entry_id
$$;

COMMENT ON FUNCTION public.arkiv_document_rows(uuid, boolean) IS
  'The Dokument tree''s rows for one company: effective type, booked, and the document date (left out only when p_with_day is false). The one home of both rules; arkiv_document_type_counts and arkiv_document_page select from it.';

REVOKE ALL ON FUNCTION public.arkiv_document_rows(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.arkiv_document_rows(uuid, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.arkiv_document_type_counts(p_company_id uuid, p_year int DEFAULT NULL)
RETURNS TABLE (doc_type text, booked boolean, n bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT r.doc_type, r.booked, count(*)
  FROM public.arkiv_document_rows(p_company_id, p_year IS NOT NULL) r
  WHERE p_year IS NULL OR left(r.doc_day, 4) = p_year::text
  GROUP BY r.doc_type, r.booked
$$;

CREATE OR REPLACE FUNCTION public.arkiv_document_page(
  p_company_id uuid,
  p_mode text,
  p_types text[],
  p_year int DEFAULT NULL,
  p_offset int DEFAULT 0,
  p_limit int DEFAULT 25
)
RETURNS TABLE (id uuid, doc_day text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT r.id, r.doc_day
  FROM public.arkiv_document_rows(p_company_id, true) r
  WHERE CASE p_mode
      WHEN 'in' THEN r.doc_type = ANY (p_types)
      WHEN 'not_in' THEN r.doc_type IS NOT NULL AND NOT (r.doc_type = ANY (coalesce(p_types, '{}')))
      WHEN 'untyped' THEN r.doc_type IS NULL AND NOT r.booked
      WHEN 'booked' THEN r.doc_type IS NULL AND r.booked
      ELSE false
    END
    AND (p_year IS NULL OR left(r.doc_day, 4) = p_year::text)
  ORDER BY r.doc_day DESC, r.created_at DESC, r.id
  OFFSET greatest(0, coalesce(p_offset, 0))
  LIMIT least(greatest(1, coalesce(p_limit, 25)), 200)
$$;

-- 20260926160000 dropped and recreated arkiv_document_type_counts without
-- repeating its REVOKE, so PUBLIC and anon have held EXECUTE on it since
-- (production ACL read 2026-11-12). RLS gave them no rows; now the inner
-- function refuses them. Close the outer one to match its sibling.
REVOKE EXECUTE ON FUNCTION public.arkiv_document_type_counts(uuid, int) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.arkiv_document_page(uuid, text, text[], int, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.arkiv_document_type_counts(uuid, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arkiv_document_page(uuid, text, text[], int, int, int) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.arkiv_effective_doc_type(text, uuid, boolean);
DROP FUNCTION IF EXISTS public.arkiv_document_day(text, jsonb, timestamptz, date);

NOTIFY pgrst, 'reload schema';
