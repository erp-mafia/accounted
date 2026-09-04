-- Parties, phase 0: draw the golden set for the counterparty resolver.
--
-- Read-only. Run against prod through the Supabase MCP (execute_sql) or psql.
-- The OUTPUT contains customer voucher text, which can include person names
-- (salary vouchers, expense claims). It must never be committed to this
-- public repository: write it to dev_docs/parties/golden/ (gitignored) and
-- label it there. Only aggregate results and the labelling vocabulary belong
-- in the repo.
--
-- Scope: posted SIE-imported vouchers (source_type = 'import') with at least
-- one expense debit line (4xxx-7xxx), sandbox tenants excluded. Keys are the
-- shipped normalize_counterparty_key() so the sample matches what the
-- resolver will see. Three strata so the set is not dominated by one tenant:
--   fleet  = key seen in 5+ companies (60 rows)
--   heavy  = 20+ vouchers in fewer companies (60 rows)
--   tail   = everything else with 3+ vouchers (80 rows)
-- Ordering by md5(key) makes the draw deterministic and re-runnable.

-- 1. Keys for the pre-classifier (party / category / payroll / adjustment /
--    authority / bank / intermediary / unsure).
WITH real_co AS (SELECT id FROM companies WHERE name NOT ILIKE '%sandl%'),
scope AS (
  SELECT je.id, je.company_id, je.description, public.normalize_counterparty_key(je.description) AS k,
         (SELECT l.account_number FROM journal_entry_lines l
           WHERE l.journal_entry_id = je.id AND l.account_number ~ '^[4-7][0-9]{3}$'
           ORDER BY l.debit_amount DESC LIMIT 1) AS acct,
         (SELECT sum(l.debit_amount) FROM journal_entry_lines l
           WHERE l.journal_entry_id = je.id AND l.account_number ~ '^[4-7][0-9]{3}$') AS sek
  FROM journal_entries je JOIN real_co c ON c.id = je.company_id
  WHERE je.status = 'posted' AND je.source_type = 'import'
    AND EXISTS (SELECT 1 FROM journal_entry_lines l
                 WHERE l.journal_entry_id = je.id AND l.account_number ~ '^[4-7][0-9]{3}$' AND l.debit_amount > 0)
),
keys AS (
  SELECT k, count(*) AS n, count(DISTINCT company_id) AS cos,
         mode() WITHIN GROUP (ORDER BY description) AS example,
         mode() WITHIN GROUP (ORDER BY acct) AS acct, round(sum(sek)) AS sek,
         (array_agg(DISTINCT left(description, 60)))[1:3] AS variants
  FROM scope WHERE k <> '' GROUP BY k HAVING count(*) >= 3
),
strata AS (
  SELECT *,
         CASE WHEN cos >= 5 THEN 'fleet' WHEN n >= 20 THEN 'heavy' ELSE 'tail' END AS stratum,
         row_number() OVER (PARTITION BY (CASE WHEN cos >= 5 THEN 'fleet' WHEN n >= 20 THEN 'heavy' ELSE 'tail' END)
                            ORDER BY md5(k)) AS rn
  FROM keys
)
SELECT stratum, k, example, n, cos, acct, sek, variants
FROM strata
WHERE (stratum = 'fleet' AND rn <= 60) OR (stratum = 'heavy' AND rn <= 60) OR (stratum = 'tail' AND rn <= 80)
ORDER BY stratum, rn;

-- 2. Base rate of supplier bankgiro changes in our own documents, to set the
--    severity of the payee-identity signal. "Established" = a bankgiro seen on
--    at least two documents for the same org number; a single differing value
--    is treated as OCR noise or a one-off account.
WITH real_co AS (SELECT id FROM companies WHERE name NOT ILIKE '%sandl%'),
docs AS (
  SELECT d.company_id,
         regexp_replace(coalesce(d.extracted_data->'supplier'->>'orgNumber',''), '[^0-9]', '', 'g') AS org,
         regexp_replace(coalesce(d.extracted_data->'supplier'->>'bankgiro',''), '[^0-9]', '', 'g') AS bg,
         d.created_at::date AS seen
  FROM document_attachments d JOIN real_co c ON c.id = d.company_id
  WHERE length(regexp_replace(coalesce(d.extracted_data->'supplier'->>'bankgiro',''), '[^0-9]', '', 'g')) BETWEEN 7 AND 8
    AND length(regexp_replace(coalesce(d.extracted_data->'supplier'->>'orgNumber',''), '[^0-9]', '', 'g')) = 10
),
bg_counts AS (SELECT company_id, org, bg, count(*) AS n, min(seen) AS first_seen, max(seen) AS last_seen FROM docs GROUP BY 1,2,3),
established AS (SELECT * FROM bg_counts WHERE n >= 2),
per_supplier AS (
  SELECT company_id, org, count(*) AS established_bgs, sum(n) AS docs, max(last_seen) - min(first_seen) AS span_days
  FROM established GROUP BY 1,2
)
SELECT count(*) AS suppliers_with_established_bg,
       count(*) FILTER (WHERE established_bgs >= 2) AS suppliers_with_2_established_bgs,
       round(100.0 * count(*) FILTER (WHERE established_bgs >= 2) / nullif(count(*),0), 1) AS pct,
       round(avg(span_days) FILTER (WHERE established_bgs >= 2)) AS avg_span_days_when_changed
FROM per_supplier;
