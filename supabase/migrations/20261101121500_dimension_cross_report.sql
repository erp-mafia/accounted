-- Resultat across two dimensions (accounted#133): ledger_tagset_days, the
-- posted ledger's sums per account, day and full tag set, and the two report
-- RPCs that read it, get_dimension_cross_buckets (the A x B matrix) and
-- get_dimension_cross_lines (the lines behind one cell, a page at a time).
--
-- Why a new summary: a line tagged region NORR and channel WEB counts once
-- under dimension 1 and once under dimension 2 in ledger_dimension_days, so
-- those rows cannot say how much NORR made through WEB (per-dimension sums
-- cannot be intersected, 20261023093900). Reading the lines instead costs
-- what the company's tagged result lines cost: fine for a company with few
-- of them, but past the 100 ms database budget (scripts/perf/bench) for a
-- large company's year once most of its result lines carry tags.
--
-- Keyed by the line's whole tag set, any two dimensions are a GROUP BY over
-- one company's rows: a day of lines sharing a tag set and account is one
-- row.
--
-- What a row holds (s = the lines of posted and reversed entries that carry
-- at least one string-valued tag): per (company_id, fiscal_period_id,
-- account_number, entry_date, tags), sum(coalesce(debit_amount, 0)),
-- sum(coalesce(credit_amount, 0)) and count(*), where tags is the line's
-- dimensions bag without its non-string values (ledger_line_tags). Kept in
-- step by ledger_days_apply_lines, the one place the triggers' arithmetic
-- lives, in the writer's slot like the other summaries; folded by
-- compact_ledger_tagset_days. Derived data only: no API role writes it.
--
-- Rollout without a write freeze: from this migration on every write keeps
-- the rows of every company, and a company's rows are read only once
-- build_ledger_tagset_days has recomputed them from its journal under the
-- company's summary lock and listed it in ledger_tagset_days_companies (the
-- build cron, /api/reports/ledger-account-days/build/cron). Until then the
-- report reads the lines. The build reads only the verifikat that carry a
-- tag (ledger_dimension_entries), so a company without tags is instant and
-- a heavily tagged one takes well under a second.
--
-- Function bodies of ledger_days_apply_lines are verbatim from
-- 20261023093900 with the tag set block added; nothing else in them
-- changes.
--
-- pg-test: tests/pg/dimension-cross.pg.test.ts

-- ---------------------------------------------------------------------------
-- The tag set of a line
-- ---------------------------------------------------------------------------

-- A line's dimensions bag with only its string-valued keys, the values every
-- summary and report counts as tags; NULL when it has none.
CREATE OR REPLACE FUNCTION public.ledger_line_tags(p_dimensions jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO ''
AS $$
  SELECT jsonb_object_agg(d.key, d.value)
  FROM jsonb_each(CASE WHEN jsonb_typeof(p_dimensions) = 'object' THEN p_dimensions ELSE '{}'::jsonb END) d
  WHERE jsonb_typeof(d.value) = 'string'
$$;

REVOKE ALL ON FUNCTION public.ledger_line_tags(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ledger_line_tags(jsonb) TO authenticated, service_role;

-- A dimension code as the reports merge it: trimmed of the characters
-- JavaScript's String.prototype.trim removes (normalizeCode in
-- lib/reports/dimension-pnl.ts), NULL when nothing is left. One definition,
-- so a cell and the lines behind it can never disagree about a padded code.
CREATE OR REPLACE FUNCTION public.dimension_code_trim(p_code text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO ''
AS $$
  SELECT nullif(
    regexp_replace(
      p_code,
      '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$',
      '', 'g'),
    '')
$$;

REVOKE ALL ON FUNCTION public.dimension_code_trim(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dimension_code_trim(text) TO authenticated, service_role;

-- A line's code on one dimension as the reports read it: its string value
-- trimmed, NULL when the line has no string tag there or only blanks.
CREATE OR REPLACE FUNCTION public.dimension_tag_code(p_dimensions jsonb, p_dim_no text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO ''
AS $$
  SELECT CASE WHEN jsonb_typeof(p_dimensions -> p_dim_no) = 'string'
              THEN public.dimension_code_trim(p_dimensions ->> p_dim_no) END
$$;

REVOKE ALL ON FUNCTION public.dimension_tag_code(jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dimension_tag_code(jsonb, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE public.ledger_tagset_days (
  company_id       uuid    NOT NULL,
  fiscal_period_id uuid    NOT NULL,
  account_number   text    NOT NULL,
  entry_date       date    NOT NULL,
  tags             jsonb   NOT NULL,
  debit            numeric NOT NULL DEFAULT 0,
  credit           numeric NOT NULL DEFAULT 0,
  line_count       integer NOT NULL DEFAULT 0,
  slot             integer NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, fiscal_period_id, account_number, entry_date, tags, slot),
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE
);

-- The rows compaction still has to fold, per company.
CREATE INDEX ledger_tagset_days_unfolded ON public.ledger_tagset_days (company_id) WHERE slot <> 0;

COMMENT ON TABLE public.ledger_tagset_days IS
  'Sums of posted/reversed journal lines that carry a dimension tag, per company, fiscal period, account, entry date and the line''s whole tag set (string-valued keys only). Derived from the journal by triggers; read by get_dimension_cross_buckets once the company is in ledger_tagset_days_companies.';

ALTER TABLE public.ledger_tagset_days ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company ledger_tagset_days"
  ON public.ledger_tagset_days FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

-- Read-only for the API roles: only the SECURITY DEFINER trigger function
-- and the builder below write it.
GRANT SELECT ON TABLE public.ledger_tagset_days TO authenticated, service_role;

CREATE TABLE public.ledger_tagset_days_companies (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  built_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ledger_tagset_days_companies IS
  'Companies whose ledger_tagset_days rows are complete: rebuilt from the journal by build_ledger_tagset_days() after the table existed.';

ALTER TABLE public.ledger_tagset_days_companies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company ledger_tagset_days_companies"
  ON public.ledger_tagset_days_companies FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.ledger_tagset_days_companies TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ledger_tagset_days_ready(p_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.ledger_tagset_days_companies r WHERE r.company_id = p_company_id
  )
$$;

REVOKE ALL ON FUNCTION public.ledger_tagset_days_ready(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ledger_tagset_days_ready(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Writing deltas: ledger_days_apply_lines with the tag set block
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ledger_days_apply_lines(p_lines jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF p_lines IS NULL OR jsonb_array_length(p_lines) = 0 THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock_shared(public.ledger_account_days_lock_key(c.company_id))
  FROM (
    SELECT DISTINCT (l ->> 'company_id')::uuid AS company_id
    FROM jsonb_array_elements(p_lines) l
    ORDER BY 1
  ) c;

  WITH x AS (
    SELECT r.*
    FROM jsonb_to_recordset(p_lines) AS r(
      company_id uuid, fiscal_period_id uuid, entry_date date, account_number text,
      debit_amount numeric, credit_amount numeric, dimensions jsonb, s integer)
    WHERE EXISTS (SELECT 1 FROM public.companies c WHERE c.id = r.company_id)
  )
  INSERT INTO public.ledger_account_days AS t
    (company_id, fiscal_period_id, account_number, entry_date,
     debit, credit, net_debit, net_credit, line_count, slot)
  SELECT x.company_id, x.fiscal_period_id, x.account_number, x.entry_date,
         sum(x.s * coalesce(x.debit_amount, 0)),
         sum(x.s * coalesce(x.credit_amount, 0)),
         sum(x.s * greatest(x.debit_amount - x.credit_amount, 0)),
         sum(x.s * greatest(x.credit_amount - x.debit_amount, 0)),
         sum(x.s)::integer,
         pg_backend_pid()
  FROM x
  GROUP BY 1, 2, 3, 4
  ORDER BY 1, 2, 3, 4
  ON CONFLICT (company_id, fiscal_period_id, account_number, entry_date, slot) DO UPDATE
  SET debit      = t.debit + EXCLUDED.debit,
      credit     = t.credit + EXCLUDED.credit,
      net_debit  = t.net_debit + EXCLUDED.net_debit,
      net_credit = t.net_credit + EXCLUDED.net_credit,
      line_count = t.line_count + EXCLUDED.line_count;

  WITH x AS (
    SELECT r.*
    FROM jsonb_to_recordset(p_lines) AS r(
      company_id uuid, fiscal_period_id uuid, entry_date date, account_number text,
      debit_amount numeric, credit_amount numeric, dimensions jsonb, s integer)
    WHERE EXISTS (SELECT 1 FROM public.companies c WHERE c.id = r.company_id)
  )
  INSERT INTO public.ledger_dimension_days AS t
    (company_id, fiscal_period_id, dim_no, code, account_number, entry_date,
     debit, credit, net_debit, net_credit, line_count, slot)
  SELECT x.company_id, x.fiscal_period_id, d.key, d.value #>> '{}', x.account_number, x.entry_date,
         sum(x.s * coalesce(x.debit_amount, 0)),
         sum(x.s * coalesce(x.credit_amount, 0)),
         sum(x.s * greatest(x.debit_amount - x.credit_amount, 0)),
         sum(x.s * greatest(x.credit_amount - x.debit_amount, 0)),
         sum(x.s)::integer,
         pg_backend_pid()
  FROM x
  CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(x.dimensions) = 'object' THEN x.dimensions ELSE '{}'::jsonb END) d
  WHERE jsonb_typeof(d.value) = 'string'
  GROUP BY 1, 2, 3, 4, 5, 6
  ORDER BY 1, 2, 3, 4, 5, 6
  ON CONFLICT (company_id, fiscal_period_id, dim_no, code, account_number, entry_date, slot) DO UPDATE
  SET debit      = t.debit + EXCLUDED.debit,
      credit     = t.credit + EXCLUDED.credit,
      net_debit  = t.net_debit + EXCLUDED.net_debit,
      net_credit = t.net_credit + EXCLUDED.net_credit,
      line_count = t.line_count + EXCLUDED.line_count;

  -- Per full tag set (20261101121500): the dimension cross report reads two
  -- dimensions of the same line, which the per-dimension rows above cannot
  -- intersect. Only lines with at least one string-valued tag.
  WITH x AS (
    SELECT r.*, public.ledger_line_tags(r.dimensions) AS tags
    FROM jsonb_to_recordset(p_lines) AS r(
      company_id uuid, fiscal_period_id uuid, entry_date date, account_number text,
      debit_amount numeric, credit_amount numeric, dimensions jsonb, s integer)
    WHERE EXISTS (SELECT 1 FROM public.companies c WHERE c.id = r.company_id)
  )
  INSERT INTO public.ledger_tagset_days AS t
    (company_id, fiscal_period_id, account_number, entry_date, tags, debit, credit, line_count, slot)
  SELECT x.company_id, x.fiscal_period_id, x.account_number, x.entry_date, x.tags,
         sum(x.s * coalesce(x.debit_amount, 0)),
         sum(x.s * coalesce(x.credit_amount, 0)),
         sum(x.s)::integer,
         pg_backend_pid()
  FROM x
  WHERE x.tags IS NOT NULL
  GROUP BY 1, 2, 3, 4, 5
  ORDER BY 1, 2, 3, 4, 5
  ON CONFLICT (company_id, fiscal_period_id, account_number, entry_date, tags, slot) DO UPDATE
  SET debit      = t.debit + EXCLUDED.debit,
      credit     = t.credit + EXCLUDED.credit,
      line_count = t.line_count + EXCLUDED.line_count;

  -- The locators. Their rows are per verifikat, so concurrent writers only
  -- meet on the same verifikat: no slots needed. A row whose lines are all
  -- gone is removed.
  WITH x AS (
    SELECT r.*
    FROM jsonb_to_recordset(p_lines) AS r(
      company_id uuid, fiscal_period_id uuid, entry_date date, voucher_number integer,
      journal_entry_id uuid, account_number text, s integer)
    WHERE EXISTS (SELECT 1 FROM public.companies c WHERE c.id = r.company_id)
  )
  INSERT INTO public.ledger_account_entries AS t
    (company_id, fiscal_period_id, account_number, entry_date, voucher_number, journal_entry_id, line_count)
  SELECT x.company_id, x.fiscal_period_id, x.account_number, x.entry_date, x.voucher_number, x.journal_entry_id,
         sum(x.s)::integer
  FROM x
  GROUP BY 1, 2, 3, 4, 5, 6
  ORDER BY 1, 2, 3, 4, 5, 6
  ON CONFLICT (company_id, fiscal_period_id, account_number, entry_date, voucher_number, journal_entry_id) DO UPDATE
  SET line_count = t.line_count + EXCLUDED.line_count;

  WITH x AS (
    SELECT r.*
    FROM jsonb_to_recordset(p_lines) AS r(
      company_id uuid, fiscal_period_id uuid, entry_date date, voucher_number integer,
      journal_entry_id uuid, account_number text, dimensions jsonb, s integer)
    WHERE EXISTS (SELECT 1 FROM public.companies c WHERE c.id = r.company_id)
  )
  INSERT INTO public.ledger_dimension_entries AS t
    (company_id, fiscal_period_id, dim_no, code, account_number, entry_date, voucher_number, journal_entry_id, line_count)
  SELECT x.company_id, x.fiscal_period_id, d.key, d.value #>> '{}', x.account_number, x.entry_date,
         x.voucher_number, x.journal_entry_id, sum(x.s)::integer
  FROM x
  CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(x.dimensions) = 'object' THEN x.dimensions ELSE '{}'::jsonb END) d
  WHERE jsonb_typeof(d.value) = 'string'
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
  ORDER BY 1, 2, 3, 4, 5, 6, 7, 8
  ON CONFLICT (company_id, fiscal_period_id, dim_no, code, account_number, entry_date, voucher_number, journal_entry_id) DO UPDATE
  SET line_count = t.line_count + EXCLUDED.line_count;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) l WHERE (l ->> 's')::integer < 0) THEN
    DELETE FROM public.ledger_account_entries t
    USING (
      SELECT DISTINCT r.company_id, r.fiscal_period_id, r.account_number, r.entry_date, r.voucher_number, r.journal_entry_id
      FROM jsonb_to_recordset(p_lines) AS r(
        company_id uuid, fiscal_period_id uuid, entry_date date, voucher_number integer,
        journal_entry_id uuid, account_number text, s integer)
      WHERE r.s < 0
    ) k
    WHERE t.company_id = k.company_id
      AND t.fiscal_period_id = k.fiscal_period_id
      AND t.account_number = k.account_number
      AND t.entry_date = k.entry_date
      AND t.voucher_number = k.voucher_number
      AND t.journal_entry_id = k.journal_entry_id
      AND t.line_count <= 0;

    DELETE FROM public.ledger_dimension_entries t
    USING (
      SELECT DISTINCT r.company_id, r.fiscal_period_id, d.key AS dim_no, d.value #>> '{}' AS code,
             r.account_number, r.entry_date, r.voucher_number, r.journal_entry_id
      FROM jsonb_to_recordset(p_lines) AS r(
        company_id uuid, fiscal_period_id uuid, entry_date date, voucher_number integer,
        journal_entry_id uuid, account_number text, dimensions jsonb, s integer)
      CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(r.dimensions) = 'object' THEN r.dimensions ELSE '{}'::jsonb END) d
      WHERE r.s < 0
        AND jsonb_typeof(d.value) = 'string'
    ) k
    WHERE t.company_id = k.company_id
      AND t.fiscal_period_id = k.fiscal_period_id
      AND t.dim_no = k.dim_no
      AND t.code = k.code
      AND t.account_number = k.account_number
      AND t.entry_date = k.entry_date
      AND t.voucher_number = k.voucher_number
      AND t.journal_entry_id = k.journal_entry_id
      AND t.line_count <= 0;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.ledger_days_apply_lines(jsonb) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Building a company, folding its slots, checking it
-- ---------------------------------------------------------------------------

-- Recompute one company's ledger_tagset_days rows from the journal and list
-- it as built. Takes the company's summary lock exclusively, as
-- build_ledger_account_days does: a writer in flight finishes first, a new
-- one waits, and the build gives up after lock_timeout (the cron retries).
-- Once the company's other summaries are built, its locator names every
-- verifikat with a tagged line, so only those are read.
CREATE OR REPLACE FUNCTION public.build_ledger_tagset_days(p_company_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
SET lock_timeout TO '2s'
SET work_mem TO '256MB'
AS $$
DECLARE
  v_rows integer;
BEGIN
  PERFORM pg_advisory_xact_lock(public.ledger_account_days_lock_key(p_company_id));

  DELETE FROM public.ledger_tagset_days WHERE company_id = p_company_id;

  IF public.ledger_account_days_ready(p_company_id) THEN
    INSERT INTO public.ledger_tagset_days
      (company_id, fiscal_period_id, account_number, entry_date, tags, debit, credit, line_count)
    SELECT e.company_id, e.fiscal_period_id, l.account_number, e.entry_date, t.tags,
           sum(coalesce(l.debit_amount, 0)), sum(coalesce(l.credit_amount, 0)), count(*)::integer
    FROM (
      SELECT DISTINCT d.journal_entry_id
      FROM public.ledger_dimension_entries d
      WHERE d.company_id = p_company_id
    ) x
    JOIN public.journal_entries e ON e.id = x.journal_entry_id
    JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
    CROSS JOIN LATERAL (SELECT public.ledger_line_tags(l.dimensions) AS tags) t
    WHERE e.company_id = p_company_id
      AND e.status IN ('posted', 'reversed')
      AND t.tags IS NOT NULL
    GROUP BY 1, 2, 3, 4, 5;
  ELSE
    INSERT INTO public.ledger_tagset_days
      (company_id, fiscal_period_id, account_number, entry_date, tags, debit, credit, line_count)
    SELECT e.company_id, e.fiscal_period_id, l.account_number, e.entry_date, t.tags,
           sum(coalesce(l.debit_amount, 0)), sum(coalesce(l.credit_amount, 0)), count(*)::integer
    FROM public.journal_entries e
    JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
    CROSS JOIN LATERAL (SELECT public.ledger_line_tags(l.dimensions) AS tags) t
    WHERE e.company_id = p_company_id
      AND e.status IN ('posted', 'reversed')
      AND t.tags IS NOT NULL
    GROUP BY 1, 2, 3, 4, 5;
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  INSERT INTO public.ledger_tagset_days_companies (company_id, built_at)
  VALUES (p_company_id, now())
  ON CONFLICT (company_id) DO UPDATE SET built_at = EXCLUDED.built_at;

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.build_ledger_tagset_days(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.build_ledger_tagset_days(uuid) TO service_role;

COMMENT ON FUNCTION public.build_ledger_tagset_days(uuid) IS
  'Recomputes a company''s ledger_tagset_days rows from the journal under the company''s summary lock and marks it built. Service role only (the build cron).';

-- Companies the build cron still has to build. Only companies whose other
-- summaries are built already, so the build reads through the locator.
CREATE OR REPLACE FUNCTION public.ledger_tagset_days_pending(p_limit integer)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT r.company_id
  FROM public.ledger_account_days_companies r
  WHERE NOT EXISTS (
    SELECT 1 FROM public.ledger_tagset_days_companies t WHERE t.company_id = r.company_id
  )
  ORDER BY r.company_id
  LIMIT greatest(coalesce(p_limit, 0), 0)
$$;

REVOKE ALL ON FUNCTION public.ledger_tagset_days_pending(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ledger_tagset_days_pending(integer) TO service_role;

-- Fold one company's slot rows into slot 0 (sums unchanged) and drop keys
-- whose lines are all gone, under the company's summary lock taken shared,
-- exactly as compact_ledger_account_days does for the other summaries.
CREATE OR REPLACE FUNCTION public.compact_ledger_tagset_days(p_company_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
SET lock_timeout TO '2s'
AS $$
DECLARE
  v_rows integer;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(public.ledger_account_days_lock_key(p_company_id));

  WITH moved AS (
    DELETE FROM public.ledger_tagset_days
    WHERE company_id = p_company_id AND slot <> 0
    RETURNING *
  )
  INSERT INTO public.ledger_tagset_days AS t
    (company_id, fiscal_period_id, account_number, entry_date, tags, debit, credit, line_count, slot)
  SELECT m.company_id, m.fiscal_period_id, m.account_number, m.entry_date, m.tags,
         sum(m.debit), sum(m.credit), sum(m.line_count)::integer, 0
  FROM moved m
  GROUP BY 1, 2, 3, 4, 5
  ORDER BY 1, 2, 3, 4, 5
  ON CONFLICT (company_id, fiscal_period_id, account_number, entry_date, tags, slot) DO UPDATE
  SET debit      = t.debit + EXCLUDED.debit,
      credit     = t.credit + EXCLUDED.credit,
      line_count = t.line_count + EXCLUDED.line_count;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  DELETE FROM public.ledger_tagset_days
  WHERE company_id = p_company_id AND slot = 0 AND line_count = 0;

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.compact_ledger_tagset_days(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compact_ledger_tagset_days(uuid) TO service_role;

-- Companies with tag set slot rows to fold.
CREATE OR REPLACE FUNCTION public.ledger_tagset_days_unfolded(p_limit integer)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT DISTINCT t.company_id
  FROM public.ledger_tagset_days t
  WHERE t.slot <> 0
  ORDER BY t.company_id
  LIMIT greatest(coalesce(p_limit, 0), 0)
$$;

REVOKE ALL ON FUNCTION public.ledger_tagset_days_unfolded(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ledger_tagset_days_unfolded(integer) TO service_role;

-- Every key where the stored rows and the journal disagree, for one company.
-- Empty when the summary is right. For tests and for checking a company by
-- hand; it reads the company's whole journal, so not for request paths.
CREATE OR REPLACE FUNCTION public.ledger_tagset_days_drift(p_company_id uuid)
RETURNS TABLE (
  fiscal_period_id uuid,
  account_number text,
  entry_date date,
  tags jsonb,
  stored_debit numeric,
  journal_debit numeric,
  stored_credit numeric,
  journal_credit numeric,
  stored_line_count integer,
  journal_line_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  WITH journal AS (
    SELECT e.fiscal_period_id, l.account_number, e.entry_date, t.tags,
           sum(coalesce(l.debit_amount, 0)) AS debit,
           sum(coalesce(l.credit_amount, 0)) AS credit,
           count(*)::integer AS line_count
    FROM public.journal_entries e
    JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
    CROSS JOIN LATERAL (SELECT public.ledger_line_tags(l.dimensions) AS tags) t
    WHERE e.company_id = p_company_id
      AND e.status IN ('posted', 'reversed')
      AND t.tags IS NOT NULL
    GROUP BY 1, 2, 3, 4
  ),
  stored AS (
    SELECT k.*
    FROM (
      SELECT s.fiscal_period_id, s.account_number, s.entry_date, s.tags,
             sum(s.debit) AS debit, sum(s.credit) AS credit, sum(s.line_count)::integer AS line_count
      FROM public.ledger_tagset_days s
      WHERE s.company_id = p_company_id
      GROUP BY 1, 2, 3, 4
    ) k
    WHERE k.line_count <> 0 OR (k.debit, k.credit) <> (0, 0)
  )
  SELECT coalesce(s.fiscal_period_id, j.fiscal_period_id),
         coalesce(s.account_number, j.account_number),
         coalesce(s.entry_date, j.entry_date),
         coalesce(s.tags, j.tags),
         s.debit, j.debit, s.credit, j.credit, s.line_count, j.line_count
  FROM stored s
  FULL JOIN journal j
    ON j.fiscal_period_id = s.fiscal_period_id
   AND j.account_number = s.account_number
   AND j.entry_date = s.entry_date
   AND j.tags = s.tags
  WHERE (s.debit, s.credit, s.line_count) IS DISTINCT FROM (j.debit, j.credit, j.line_count)
  ORDER BY 1, 2, 3, 4
$$;

REVOKE ALL ON FUNCTION public.ledger_tagset_days_drift(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ledger_tagset_days_drift(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Readers
-- ---------------------------------------------------------------------------

-- The dimension cross report's tagged pass (generateDimensionCross): per
-- result account (3000-8999), value of dimension p_dim_a (NULL: no tag on
-- it) and value of p_dim_b (NULL likewise), the debit and credit of the
-- lines that carry a tag on at least one of the two, over the entry set
-- behind the resultatrapport, the same as get_dimension_pnl_buckets: this
-- period, posted or reversed, inside [p_from_date, p_to_date], without the
-- opening-balance entry and the year-end chain (year_end_chain_entry_ids).
-- Values as stored: the report trims and merges them, and puts the lines
-- with neither tag in the untagged x untagged cell as the remainder of the
-- resultatrapport. From ledger_tagset_days once the company's rows are
-- built, from the lines otherwise (through the locator when the company's
-- other summaries are built). Returns jsonb (no PostgREST max-rows cap).
CREATE OR REPLACE FUNCTION public.get_dimension_cross_buckets(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_dim_a text,
  p_dim_b text,
  p_from_date date,
  p_to_date date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO ''
SET plan_cache_mode TO force_custom_plan
AS $$
DECLARE
  v_exclude_ids uuid[];
BEGIN
  IF p_dim_a IS NULL OR p_dim_b IS NULL OR p_dim_a = p_dim_b THEN
    RAISE EXCEPTION 'get_dimension_cross_buckets: two different dimensions are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(array_remove(ARRAY[fp.opening_balance_entry_id], NULL), '{}'::uuid[])
         || public.year_end_chain_entry_ids(p_company_id, p_fiscal_period_id)
    INTO v_exclude_ids
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id;
  v_exclude_ids := coalesce(v_exclude_ids, '{}'::uuid[]);

  IF public.ledger_tagset_days_ready(p_company_id) THEN
    RETURN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'account_number', t.account_number, 'code_a', t.code_a, 'code_b', t.code_b,
               'debit', t.debit, 'credit', t.credit) ORDER BY t.account_number, t.code_a, t.code_b), '[]'::jsonb)
      FROM (
        SELECT s.account_number, s.code_a, s.code_b, sum(s.debit) AS debit, sum(s.credit) AS credit
        FROM (
          SELECT d.account_number, d.tags ->> p_dim_a AS code_a, d.tags ->> p_dim_b AS code_b,
                 d.debit, d.credit, d.line_count
          FROM public.ledger_tagset_days d
          WHERE d.company_id = p_company_id
            AND d.fiscal_period_id = p_fiscal_period_id
            AND d.account_number >= '3000' AND d.account_number < '9000'
            AND (p_from_date IS NULL OR d.entry_date >= p_from_date)
            AND (p_to_date IS NULL OR d.entry_date <= p_to_date)
            AND (d.tags ? p_dim_a OR d.tags ? p_dim_b)
          UNION ALL
          -- The left-out entries' lines, negated (they are in the stored rows).
          SELECT l.account_number,
                 CASE WHEN jsonb_typeof(l.dimensions -> p_dim_a) = 'string' THEN l.dimensions ->> p_dim_a END,
                 CASE WHEN jsonb_typeof(l.dimensions -> p_dim_b) = 'string' THEN l.dimensions ->> p_dim_b END,
                 -coalesce(l.debit_amount, 0), -coalesce(l.credit_amount, 0), -1
          FROM (SELECT DISTINCT u.id FROM unnest(v_exclude_ids) AS u(id)) ex
          JOIN public.journal_entries e ON e.id = ex.id
          JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
          WHERE e.company_id = p_company_id
            AND e.fiscal_period_id = p_fiscal_period_id
            AND e.status IN ('posted', 'reversed')
            AND (p_from_date IS NULL OR e.entry_date >= p_from_date)
            AND (p_to_date IS NULL OR e.entry_date <= p_to_date)
            AND l.account_number >= '3000' AND l.account_number < '9000'
            AND (jsonb_typeof(l.dimensions -> p_dim_a) = 'string' OR jsonb_typeof(l.dimensions -> p_dim_b) = 'string')
        ) s
        GROUP BY 1, 2, 3
        HAVING sum(s.line_count) > 0
      ) t
    );
  END IF;

  IF public.ledger_account_days_ready(p_company_id) THEN
    RETURN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'account_number', t.account_number, 'code_a', t.code_a, 'code_b', t.code_b,
               'debit', t.debit, 'credit', t.credit) ORDER BY t.account_number, t.code_a, t.code_b), '[]'::jsonb)
      FROM (
        SELECT l.account_number,
               CASE WHEN jsonb_typeof(l.dimensions -> p_dim_a) = 'string' THEN l.dimensions ->> p_dim_a END AS code_a,
               CASE WHEN jsonb_typeof(l.dimensions -> p_dim_b) = 'string' THEN l.dimensions ->> p_dim_b END AS code_b,
               sum(coalesce(l.debit_amount, 0)) AS debit, sum(coalesce(l.credit_amount, 0)) AS credit
        FROM (
          -- The verifikat with a line tagged on either dimension.
          SELECT DISTINCT d.journal_entry_id
          FROM public.ledger_dimension_entries d
          WHERE d.company_id = p_company_id
            AND d.fiscal_period_id = p_fiscal_period_id
            AND d.dim_no IN (p_dim_a, p_dim_b)
            AND d.account_number >= '3000' AND d.account_number < '9000'
            AND (p_from_date IS NULL OR d.entry_date >= p_from_date)
            AND (p_to_date IS NULL OR d.entry_date <= p_to_date)
        ) x
        JOIN public.journal_entries e ON e.id = x.journal_entry_id
        JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
        WHERE e.company_id = p_company_id
          AND e.fiscal_period_id = p_fiscal_period_id
          AND e.status IN ('posted', 'reversed')
          AND e.id <> ALL (v_exclude_ids)
          AND l.account_number >= '3000' AND l.account_number < '9000'
          AND (jsonb_typeof(l.dimensions -> p_dim_a) = 'string' OR jsonb_typeof(l.dimensions -> p_dim_b) = 'string')
        GROUP BY 1, 2, 3
      ) t
    );
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'account_number', t.account_number, 'code_a', t.code_a, 'code_b', t.code_b,
             'debit', t.debit, 'credit', t.credit) ORDER BY t.account_number, t.code_a, t.code_b), '[]'::jsonb)
    FROM (
      SELECT l.account_number,
             CASE WHEN jsonb_typeof(l.dimensions -> p_dim_a) = 'string' THEN l.dimensions ->> p_dim_a END AS code_a,
             CASE WHEN jsonb_typeof(l.dimensions -> p_dim_b) = 'string' THEN l.dimensions ->> p_dim_b END AS code_b,
             sum(coalesce(l.debit_amount, 0)) AS debit, sum(coalesce(l.credit_amount, 0)) AS credit
      FROM public.journal_entries e
      JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
      WHERE e.company_id = p_company_id
        AND e.fiscal_period_id = p_fiscal_period_id
        AND e.status IN ('posted', 'reversed')
        AND (p_from_date IS NULL OR e.entry_date >= p_from_date)
        AND (p_to_date IS NULL OR e.entry_date <= p_to_date)
        AND e.id <> ALL (v_exclude_ids)
        AND l.account_number >= '3000' AND l.account_number < '9000'
        AND (jsonb_typeof(l.dimensions -> p_dim_a) = 'string' OR jsonb_typeof(l.dimensions -> p_dim_b) = 'string')
      GROUP BY 1, 2, 3
    ) t
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_dimension_cross_buckets(uuid, uuid, text, text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dimension_cross_buckets(uuid, uuid, text, text, date, date) TO authenticated, service_role;

-- The lines behind one cell of the cross report, a page at a time: the
-- lines of the same entry set on result accounts in [p_account_from,
-- p_account_to] (NULL: 3000 and every class 8 account), whose code on
-- p_dim_a is p_code_a and on p_dim_b is p_code_b, both read by
-- dimension_tag_code as the report merges them; a NULL code is the "no tag"
-- row or column (no key, a non-string value, or only blanks). In line order (entry date, voucher
-- number, line id) after the cursor, at most p_limit, with has_more. A cell
-- with a value is read through that value's locator once the company is
-- built. SECURITY INVOKER: RLS applies to the caller.
CREATE OR REPLACE FUNCTION public.get_dimension_cross_lines(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_dim_a text,
  p_code_a text,
  p_dim_b text,
  p_code_b text,
  p_account_from text,
  p_account_to text,
  p_from_date date,
  p_to_date date,
  p_after_date date,
  p_after_voucher integer,
  p_after_line_id uuid,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO ''
SET plan_cache_mode TO force_custom_plan
AS $$
DECLARE
  v_code_a text := public.dimension_code_trim(p_code_a);
  v_code_b text := public.dimension_code_trim(p_code_b);
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_from text := greatest(coalesce(p_account_from, '3000'), '3000');
  v_exclude_ids uuid[];
  v_walk_dim text;
  v_walk_code text;
  v_lines jsonb;
BEGIN
  IF p_dim_a IS NULL OR p_dim_b IS NULL OR p_dim_a = p_dim_b THEN
    RAISE EXCEPTION 'get_dimension_cross_lines: two different dimensions are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(array_remove(ARRAY[fp.opening_balance_entry_id], NULL), '{}'::uuid[])
         || public.year_end_chain_entry_ids(p_company_id, p_fiscal_period_id)
    INTO v_exclude_ids
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id;
  v_exclude_ids := coalesce(v_exclude_ids, '{}'::uuid[]);

  -- A value narrows the read to the verifikat tagged with it.
  IF public.ledger_account_days_ready(p_company_id) THEN
    IF v_code_a IS NOT NULL THEN
      v_walk_dim := p_dim_a; v_walk_code := v_code_a;
    ELSIF v_code_b IS NOT NULL THEN
      v_walk_dim := p_dim_b; v_walk_code := v_code_b;
    END IF;
  END IF;

  SELECT coalesce(jsonb_agg(r.line ORDER BY r.entry_date, r.voucher_number, r.line_id), '[]'::jsonb) INTO v_lines
  FROM (
    SELECT e.entry_date, e.voucher_number, l.id AS line_id, jsonb_build_object(
             'line_id', l.id,
             'journal_entry_id', e.id,
             'entry_date', e.entry_date,
             'voucher_series', e.voucher_series,
             'voucher_number', e.voucher_number,
             'description', e.description,
             'line_description', l.line_description,
             'account_number', l.account_number,
             'debit_amount', l.debit_amount,
             'credit_amount', l.credit_amount,
             'dimensions', l.dimensions) AS line
    FROM public.journal_entries e
    JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
    WHERE e.company_id = p_company_id
      AND e.fiscal_period_id = p_fiscal_period_id
      AND e.status IN ('posted', 'reversed')
      AND (p_from_date IS NULL OR e.entry_date >= p_from_date)
      AND (p_to_date IS NULL OR e.entry_date <= p_to_date)
      AND e.id <> ALL (v_exclude_ids)
      AND l.account_number >= v_from
      AND CASE WHEN p_account_to IS NULL THEN l.account_number < '9000'
               ELSE l.account_number <= p_account_to AND l.account_number < '9000' END
      -- NULL-safe: a line without the key reads NULL, the untagged code.
      AND public.dimension_tag_code(l.dimensions, p_dim_a) IS NOT DISTINCT FROM v_code_a
      AND public.dimension_tag_code(l.dimensions, p_dim_b) IS NOT DISTINCT FROM v_code_b
      AND (p_after_date IS NULL
           OR (e.entry_date, e.voucher_number, l.id) > (p_after_date, p_after_voucher, p_after_line_id))
      AND (v_walk_dim IS NULL OR e.id IN (
            SELECT d.journal_entry_id
            FROM public.ledger_dimension_entries d
            WHERE d.company_id = p_company_id
              AND d.fiscal_period_id = p_fiscal_period_id
              AND d.dim_no = v_walk_dim
              AND public.dimension_code_trim(d.code) = v_walk_code
              AND d.account_number >= v_from
              AND d.account_number < '9000'
              AND (p_from_date IS NULL OR d.entry_date >= p_from_date)
              AND (p_to_date IS NULL OR d.entry_date <= p_to_date)))
    ORDER BY e.entry_date, e.voucher_number, l.id
    LIMIT v_limit + 1
  ) r;

  RETURN jsonb_build_object(
    'lines', (SELECT coalesce(jsonb_agg(x.value ORDER BY x.ordinality), '[]'::jsonb)
              FROM jsonb_array_elements(v_lines) WITH ORDINALITY x
              WHERE x.ordinality <= v_limit),
    'has_more', jsonb_array_length(v_lines) > v_limit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_dimension_cross_lines(uuid, uuid, text, text, text, text, text, text, date, date, date, integer, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dimension_cross_lines(uuid, uuid, text, text, text, text, text, text, date, date, date, integer, uuid, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
