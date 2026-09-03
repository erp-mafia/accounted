-- get_ledger_key_evidence: a company without an org number lost every hard
-- key. (d.org = own.org) is NULL when own.org is NULL, NOT NULL is NULL, and
-- the row fell out of the useful set, so orgs, names, bankgiro and plusgiro
-- came back empty while docs still counted. Sole traders and every company
-- that has not filled in its org number were affected. The comparison is now
-- coalesced to false: with no own org number nothing can be self-extracted.
-- Same body as 20260902200000 otherwise.
-- pg-test: covered-by tests/pg/party-suggestions.pg.test.ts

CREATE OR REPLACE FUNCTION public.get_ledger_key_evidence(p_company_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  WITH own AS (
    SELECT public.normalize_org_number(c.org_number) AS org
    FROM public.companies c WHERE c.id = p_company_id
  ),
  entries AS (
    SELECT je.id, je.entry_date, public.ledger_key(je.description) AS k
    FROM public.journal_entries je
    WHERE je.company_id = p_company_id
      AND je.status = 'posted'
      AND je.source_type NOT IN ('storno', 'opening_balance', 'year_end', 'vat_settlement')
      AND je.description IS NOT NULL
      AND btrim(je.description) <> ''
      AND NOT EXISTS (
        SELECT 1 FROM public.transactions t
        WHERE t.journal_entry_id = je.id
          AND t.merchant_name IS NOT NULL
          AND btrim(t.merchant_name) <> ''
      )
  ),
  docs AS (
    SELECT e.k, e.entry_date, d.id AS document_id,
           public.normalize_org_number(d.extracted_data->'supplier'->>'orgNumber') AS org,
           nullif(upper(regexp_replace(coalesce(d.extracted_data->'supplier'->>'vatNumber', ''), '[^0-9A-Za-z]', '', 'g')), '') AS vat,
           nullif(regexp_replace(coalesce(d.extracted_data->'supplier'->>'bankgiro', ''), '[^0-9]', '', 'g'), '') AS bankgiro,
           nullif(regexp_replace(coalesce(d.extracted_data->'supplier'->>'plusgiro', ''), '[^0-9]', '', 'g'), '') AS plusgiro,
           nullif(btrim(d.extracted_data->'supplier'->>'name'), '') AS name
    FROM entries e
    JOIN public.document_attachments d
      ON d.journal_entry_id = e.id
     AND d.company_id = p_company_id
     AND d.is_current_version
     AND jsonb_typeof(d.extracted_data->'supplier') = 'object'
    WHERE e.k <> ''
  ),
  classified AS (
    SELECT d.*, coalesce(d.org IS NOT NULL AND d.org = own.org, false) AS is_self
    FROM docs d CROSS JOIN own
  ),
  useful AS (SELECT * FROM classified WHERE NOT is_self),
  orgs AS (
    SELECT k, org, count(*) AS n FROM useful WHERE org IS NOT NULL GROUP BY k, org
  ),
  vats AS (
    SELECT k, vat, count(*) AS n FROM useful WHERE vat IS NOT NULL GROUP BY k, vat
  ),
  names AS (
    SELECT k, name, count(*) AS n FROM useful WHERE name IS NOT NULL GROUP BY k, name
  ),
  bg AS (
    SELECT k, bankgiro AS value, count(*) AS n, min(entry_date) AS first_seen, max(entry_date) AS last_seen
    FROM useful WHERE bankgiro IS NOT NULL AND length(bankgiro) BETWEEN 7 AND 8 GROUP BY k, bankgiro
  ),
  pg AS (
    SELECT k, plusgiro AS value, count(*) AS n, min(entry_date) AS first_seen, max(entry_date) AS last_seen
    FROM useful WHERE plusgiro IS NOT NULL AND length(plusgiro) BETWEEN 5 AND 8 GROUP BY k, plusgiro
  ),
  per_key AS (
    SELECT c.k,
           count(*) AS docs,
           count(*) FILTER (WHERE c.is_self) AS self_docs
    FROM classified c GROUP BY c.k
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'key', p.k,
    'docs', p.docs,
    'self_docs', p.self_docs,
    'orgs', coalesce((SELECT jsonb_agg(jsonb_build_object('org', o.org, 'n', o.n) ORDER BY o.n DESC, o.org) FROM orgs o WHERE o.k = p.k), '[]'::jsonb),
    'vat_numbers', coalesce((SELECT jsonb_agg(jsonb_build_object('vat', v.vat, 'n', v.n) ORDER BY v.n DESC, v.vat) FROM vats v WHERE v.k = p.k), '[]'::jsonb),
    'names', coalesce((SELECT jsonb_agg(jsonb_build_object('name', x.name, 'n', x.n) ORDER BY x.n DESC, x.name) FROM names x WHERE x.k = p.k), '[]'::jsonb),
    'bankgiro', coalesce((SELECT jsonb_agg(jsonb_build_object('value', b.value, 'n', b.n, 'first_seen', b.first_seen, 'last_seen', b.last_seen) ORDER BY b.n DESC, b.value) FROM bg b WHERE b.k = p.k), '[]'::jsonb),
    'plusgiro', coalesce((SELECT jsonb_agg(jsonb_build_object('value', g.value, 'n', g.n, 'first_seen', g.first_seen, 'last_seen', g.last_seen) ORDER BY g.n DESC, g.value) FROM pg g WHERE g.k = p.k), '[]'::jsonb)
  ) ORDER BY p.docs DESC, p.k), '[]'::jsonb)
  FROM per_key p;
$$;

NOTIFY pgrst, 'reload schema';
