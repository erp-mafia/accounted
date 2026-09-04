-- Parties, phase 0/1: draw the document-anchored ground truth for the
-- SELECTION step. Read-only. Output contains customer voucher text: keep it
-- in dev_docs/parties/golden/, never in this public repository.
--
-- Truth without a human: a key whose voucher is linked to a document with an
-- OCR-read supplier org number is a known party; two keys in the same company
-- are the same party exactly when their org numbers agree. Keys that map to
-- several org numbers are dropped as ambiguous; documents whose "supplier"
-- org number is the company's own are dropped as the company's sales side.
WITH real_co AS (SELECT id, regexp_replace(coalesce(org_number,''), '[^0-9]', '', 'g') AS own_org FROM companies WHERE name NOT ILIKE '%sandl%'),
linked AS (
  SELECT d.company_id, je.description,
         regexp_replace(coalesce(d.extracted_data->'supplier'->>'orgNumber',''), '[^0-9]', '', 'g') AS org,
         public.normalize_counterparty_key(je.description) AS k,
         (SELECT l.account_number FROM journal_entry_lines l WHERE l.journal_entry_id = je.id AND l.account_number ~ '^[4-7][0-9]{3}$' ORDER BY l.debit_amount DESC LIMIT 1) AS acct
  FROM document_attachments d
  JOIN real_co c ON c.id = d.company_id
  JOIN journal_entries je ON je.id = d.journal_entry_id AND je.status = 'posted'
  WHERE d.extracted_data->'supplier'->>'orgNumber' IS NOT NULL
),
keys AS (
  SELECT l.company_id, l.org, l.k, count(*) AS n, mode() WITHIN GROUP (ORDER BY l.description) AS example, mode() WITHIN GROUP (ORDER BY l.acct) AS acct,
         btrim(regexp_replace(regexp_replace(l.k, '^(levfakt|levfkt|lev\.?fakt\.?|leverantörsfaktura från|leverantörsfaktura|levbet\.?|kvitto|faktura|utgift|inköp)\s+', '', 'g'), '\m\d+\M', '', 'g')) AS core
  FROM linked l JOIN real_co c ON c.id = l.company_id
  WHERE length(l.org) = 10 AND l.k <> '' AND l.org <> c.own_org
  GROUP BY l.company_id, l.org, l.k
),
uniq AS (SELECT company_id, k, min(org) AS org, sum(n) AS n, min(example) AS example, min(acct) AS acct, min(core) AS core FROM keys GROUP BY company_id, k HAVING count(DISTINCT org) = 1),
co_ok AS (SELECT company_id FROM uniq GROUP BY 1 HAVING count(DISTINCT org) >= 2 AND count(*) >= 6),
anchors AS (SELECT u.*, row_number() OVER (ORDER BY md5(u.company_id::text || u.k)) AS rn FROM uniq u JOIN co_ok USING (company_id) WHERE length(u.core) >= 4),
sample AS (SELECT * FROM anchors WHERE rn <= 320),
cands AS (
  SELECT s.rn AS anchor_rn, o.k, o.example, o.n, o.acct, o.org, extensions.similarity(s.core, o.core) AS sim,
         row_number() OVER (PARTITION BY s.rn ORDER BY extensions.similarity(s.core, o.core) DESC, o.n DESC) AS cr
  FROM sample s JOIN uniq o ON o.company_id = s.company_id AND o.k <> s.k
  WHERE extensions.similarity(s.core, o.core) >= 0.25
),
agg AS (
  SELECT s.rn, s.k AS anchor_k, s.example AS anchor_example, s.n AS anchor_n, s.acct AS anchor_acct, s.org AS anchor_org,
         (SELECT json_agg(json_build_object('k', c.k, 'example', c.example, 'n', c.n, 'acct', c.acct, 'org', c.org, 'sim', round(c.sim::numeric, 2)) ORDER BY c.sim DESC)
          FROM cands c WHERE c.anchor_rn = s.rn AND c.cr <= 6) AS candidates
  FROM sample s
)
SELECT * FROM agg WHERE candidates IS NOT NULL ORDER BY rn LIMIT 300;
