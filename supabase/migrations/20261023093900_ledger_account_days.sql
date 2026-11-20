-- ledger_account_days and ledger_dimension_days: the posted ledger's sums per
-- company, fiscal period, account and entry date (and per SIE dimension
-- value), kept in step by triggers, so a report reads a few thousand rows
-- instead of every journal line.
--
-- Why: every report summed journal_entry_lines at read time. A year of
-- 50 000 verifikat is 150 000 lines, and a company can hold several such
-- years. get_trial_balance_aggregates took ~850 ms for that year under
-- the lines' RLS policy, which re-checks the parent entry once per line, and
-- still ~200 ms index-only with no RLS at all; a resultatrapport reads two
-- years and a KPI page three aggregates, so they took 3-4 s. The sum of a
-- day's lines per account does not change once the day is booked, so it is
-- stored instead of recomputed.
--
-- What the rows hold, exactly (s = the lines of posted and reversed entries):
--   ledger_account_days, per (company_id, fiscal_period_id, account_number,
--   entry_date): sum(coalesce(debit_amount, 0)), sum(coalesce(credit_amount, 0)),
--   sum(greatest(debit_amount - credit_amount, 0)),
--   sum(greatest(credit_amount - debit_amount, 0)), count(*).
--   ledger_dimension_days: the same sums per (company_id, fiscal_period_id,
--   dim_no, code, account_number, entry_date) over every string-valued key of
--   each line's dimensions bag, so a line tagged with two dimensions counts in
--   two rows, once per dimension. code is the value as stored (not trimmed).
-- Posted AND reversed is the set every report sums: a stornerad verifikat and
-- its storno net to zero inside it. net_debit / net_credit split each line by
-- its own sign (a line whose difference is NULL counts in neither), which is
-- the per-line split the KPI monthly figures make for class 8.
--
-- ledger_account_entries locates the verifikat behind those sums: one row per
-- verifikat and account it books, ordered by day and voucher number, so one
-- account's lines (a huvudbok page, a drill-down) are an index range away
-- instead of a probe of every verifikat in the year. ledger_dimension_entries
-- does the same per dimension value, for the lines tagged with it.
--
-- A report that leaves entries out (the IB verifikat, the year-end chain, the
-- resultatavslut) subtracts their lines, read directly: those sets are a
-- handful of entries per period. A filter on one dimension value reads
-- ledger_dimension_days; a filter on several (a line must carry all) keeps
-- the line-level path, since per-dimension sums cannot be intersected.
--
-- Writers never wait on each other: a row's key carries a slot, the backend
-- that wrote it (pg_backend_pid()), so two transactions posting on the same
-- account and day add to two rows instead of queueing on one, as two
-- postings in an unheld period never queue today
-- (tests/pg/sie-observer-concurrency.pg.test.ts). Readers sum the slots;
-- compact_ledger_account_days() folds them into slot 0, run by the build cron.
--
-- Derived data only: no API role writes it, the journal stays the record
-- (BFL), and build_ledger_account_days() recomputes a company from the
-- journal at any time. ledger_account_days_drift() lists any row that
-- disagrees with the journal.
--
-- Rollout without a write freeze: summing the whole journal takes ~11 s for
-- 5.6M lines, and doing it here would hold the trigger locks on both journal
-- tables that long (writes would hit the 8 s lock_timeout). So a company's
-- rows are read only once it is listed in ledger_account_days_companies.
-- Companies without journal entries are listed here, new companies when they
-- are created, and the rest by the build cron
-- (/api/reports/ledger-account-days/build/cron), one company per transaction.
-- Until then a company's reports keep the line-level path they have today.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE public.ledger_account_days (
  company_id       uuid    NOT NULL,
  fiscal_period_id uuid    NOT NULL,
  account_number   text    NOT NULL,
  entry_date       date    NOT NULL,
  debit            numeric NOT NULL DEFAULT 0,
  credit           numeric NOT NULL DEFAULT 0,
  net_debit        numeric NOT NULL DEFAULT 0,
  net_credit       numeric NOT NULL DEFAULT 0,
  line_count       integer NOT NULL DEFAULT 0,
  slot             integer NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, fiscal_period_id, account_number, entry_date, slot),
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE
);

CREATE TABLE public.ledger_dimension_days (
  company_id       uuid    NOT NULL,
  fiscal_period_id uuid    NOT NULL,
  dim_no           text    NOT NULL,
  code             text    NOT NULL,
  account_number   text    NOT NULL,
  entry_date       date    NOT NULL,
  debit            numeric NOT NULL DEFAULT 0,
  credit           numeric NOT NULL DEFAULT 0,
  net_debit        numeric NOT NULL DEFAULT 0,
  net_credit       numeric NOT NULL DEFAULT 0,
  line_count       integer NOT NULL DEFAULT 0,
  slot             integer NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, fiscal_period_id, dim_no, code, account_number, entry_date, slot),
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE
);

CREATE TABLE public.ledger_account_entries (
  company_id       uuid    NOT NULL,
  fiscal_period_id uuid    NOT NULL,
  account_number   text    NOT NULL,
  entry_date       date    NOT NULL,
  voucher_number   integer NOT NULL,
  journal_entry_id uuid    NOT NULL,
  line_count       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, fiscal_period_id, account_number, entry_date, voucher_number, journal_entry_id),
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE
);

-- The rows compaction still has to fold, per company.
CREATE INDEX ledger_account_days_unfolded ON public.ledger_account_days (company_id) WHERE slot <> 0;
CREATE INDEX ledger_dimension_days_unfolded ON public.ledger_dimension_days (company_id) WHERE slot <> 0;

-- The rows go with their company (ON DELETE CASCADE); the delta function
-- skips a company whose row is already gone, which is what a company delete
-- cascading through the journal looks like from inside it. A key whose lines
-- are all gone sums to zero (line_count 0) until compaction removes it; every
-- reader requires line_count > 0 before it reports an account.

COMMENT ON TABLE public.ledger_account_days IS
  'Sums of posted/reversed journal lines per company, fiscal period, account and entry date. Derived from the journal by triggers; read by report RPCs once the company is in ledger_account_days_companies.';
CREATE TABLE public.ledger_dimension_entries (
  company_id       uuid    NOT NULL,
  fiscal_period_id uuid    NOT NULL,
  dim_no           text    NOT NULL,
  code             text    NOT NULL,
  account_number   text    NOT NULL,
  entry_date       date    NOT NULL,
  voucher_number   integer NOT NULL,
  journal_entry_id uuid    NOT NULL,
  line_count       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, fiscal_period_id, dim_no, code, account_number, entry_date, voucher_number, journal_entry_id),
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE
);

COMMENT ON TABLE public.ledger_dimension_entries IS
  'ledger_account_entries per dimension value: one row per posted/reversed verifikat, account and dimension value its lines on the account are tagged with (code as stored), with how many. Derived from the journal by triggers.';
COMMENT ON TABLE public.ledger_account_entries IS
  'One row per posted/reversed verifikat and account it has lines on (with how many), keyed by day and voucher number: where an account''s lines are. Derived from the journal by triggers.';
COMMENT ON TABLE public.ledger_dimension_days IS
  'ledger_account_days split by SIE dimension value: one row per (dimension, value, account, day) over every string-valued key of each line''s dimensions bag. Derived from the journal by triggers.';

ALTER TABLE public.ledger_account_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_dimension_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_account_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_dimension_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company ledger_account_days"
  ON public.ledger_account_days FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "view own-company ledger_dimension_days"
  ON public.ledger_dimension_days FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "view own-company ledger_account_entries"
  ON public.ledger_account_entries FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "view own-company ledger_dimension_entries"
  ON public.ledger_dimension_entries FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

-- Read-only for the API roles: only the SECURITY DEFINER trigger functions
-- and the builder below write them.
GRANT SELECT ON TABLE public.ledger_account_days TO authenticated, service_role;
GRANT SELECT ON TABLE public.ledger_dimension_days TO authenticated, service_role;
GRANT SELECT ON TABLE public.ledger_account_entries TO authenticated, service_role;
GRANT SELECT ON TABLE public.ledger_dimension_entries TO authenticated, service_role;

CREATE TABLE public.ledger_account_days_companies (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  built_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ledger_account_days_companies IS
  'Companies whose ledger_account_days and ledger_dimension_days rows are complete: built from the journal by build_ledger_account_days(), or created after the summaries existed.';

ALTER TABLE public.ledger_account_days_companies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company ledger_account_days_companies"
  ON public.ledger_account_days_companies FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.ledger_account_days_companies TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Writing deltas
-- ---------------------------------------------------------------------------

-- The per-company lock the builder takes exclusively and every delta shared,
-- so a build never interleaves with a change to the same company's journal:
-- a writer that got here first commits before the build reads the journal,
-- and one that comes later waits and applies its delta on the rebuilt rows.
CREATE OR REPLACE FUNCTION public.ledger_account_days_lock_key(p_company_id uuid)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $$
  SELECT hashtextextended('ledger_account_days:' || p_company_id::text, 0)
$$;

-- Adds signed journal lines to the summaries and the locator. p_lines is a
-- jsonb array of {company_id, fiscal_period_id, entry_date, voucher_number,
-- journal_entry_id, account_number, debit_amount, credit_amount, dimensions,
-- s}: a line with s = 1 is added, s = -1 removed,
-- under the key of the entry it belongs to (counting entries only; callers
-- filter), in this backend's slot. The one place the per-row arithmetic
-- lives, for the triggers.
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

-- Lines added, changed or removed under an entry that counts (posted or
-- reversed): inline rättelse, imports that write posted entries, a dimension
-- retag. Lines of drafts change nothing until the entry is posted (the
-- entries trigger adds them then). A line whose entry is gone was deleted by
-- the entry's cascade, which the entry's own delete trigger already subtracted.
CREATE OR REPLACE FUNCTION public.ledger_days_on_lines()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_lines jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT jsonb_agg(jsonb_build_object(
             'company_id', e.company_id, 'fiscal_period_id', e.fiscal_period_id, 'entry_date', e.entry_date,
             'voucher_number', e.voucher_number, 'journal_entry_id', e.id,
             'account_number', n.account_number, 'debit_amount', n.debit_amount,
             'credit_amount', n.credit_amount, 'dimensions', n.dimensions, 's', 1))
      INTO v_lines
    FROM new_lines n
    JOIN public.journal_entries e ON e.id = n.journal_entry_id
    WHERE e.status IN ('posted', 'reversed');
  ELSIF TG_OP = 'DELETE' THEN
    SELECT jsonb_agg(jsonb_build_object(
             'company_id', e.company_id, 'fiscal_period_id', e.fiscal_period_id, 'entry_date', e.entry_date,
             'voucher_number', e.voucher_number, 'journal_entry_id', e.id,
             'account_number', o.account_number, 'debit_amount', o.debit_amount,
             'credit_amount', o.credit_amount, 'dimensions', o.dimensions, 's', -1))
      INTO v_lines
    FROM old_lines o
    JOIN public.journal_entries e ON e.id = o.journal_entry_id
    WHERE e.status IN ('posted', 'reversed');
  ELSE
    SELECT jsonb_agg(jsonb_build_object(
             'company_id', e.company_id, 'fiscal_period_id', e.fiscal_period_id, 'entry_date', e.entry_date,
             'voucher_number', e.voucher_number, 'journal_entry_id', e.id,
             'account_number', x.account_number, 'debit_amount', x.debit_amount,
             'credit_amount', x.credit_amount, 'dimensions', x.dimensions, 's', x.s))
      INTO v_lines
    FROM (
      SELECT o.journal_entry_id, o.account_number, o.debit_amount, o.credit_amount, o.dimensions, -1 AS s
      FROM old_lines o
      UNION ALL
      SELECT n.journal_entry_id, n.account_number, n.debit_amount, n.credit_amount, n.dimensions, 1 AS s
      FROM new_lines n
    ) x
    JOIN public.journal_entries e ON e.id = x.journal_entry_id
    WHERE e.status IN ('posted', 'reversed');
  END IF;

  PERFORM public.ledger_days_apply_lines(v_lines);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.ledger_days_on_lines() FROM PUBLIC, anon, authenticated;

-- An entry starting or stopping to count (draft -> posted, posted ->
-- cancelled), or a counting entry moving to another day or period (metadata
-- rättelse): its lines leave the old key and join the new one. posted <->
-- reversed changes nothing: both count. The voucher number is part of the
-- locator's key; a posted entry's number never changes, but the comparison
-- keeps the locator right whatever path writes it.
CREATE OR REPLACE FUNCTION public.ledger_days_on_entries()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_lines jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
           'company_id', k.company_id, 'fiscal_period_id', k.fiscal_period_id, 'entry_date', k.entry_date,
           'voucher_number', k.voucher_number, 'journal_entry_id', k.id,
           'account_number', l.account_number, 'debit_amount', l.debit_amount,
           'credit_amount', l.credit_amount, 'dimensions', l.dimensions, 's', k.s))
    INTO v_lines
  FROM (
    SELECT o.id, o.company_id, o.fiscal_period_id, o.entry_date, o.voucher_number, -1 AS s
    FROM old_entries o
    JOIN new_entries n ON n.id = o.id
    WHERE o.status IN ('posted', 'reversed')
      AND ((n.status IN ('posted', 'reversed')) IS NOT TRUE
           OR (o.company_id, o.fiscal_period_id, o.entry_date, o.voucher_number)
              IS DISTINCT FROM (n.company_id, n.fiscal_period_id, n.entry_date, n.voucher_number))
    UNION ALL
    SELECT n.id, n.company_id, n.fiscal_period_id, n.entry_date, n.voucher_number, 1 AS s
    FROM old_entries o
    JOIN new_entries n ON n.id = o.id
    WHERE n.status IN ('posted', 'reversed')
      AND ((o.status IN ('posted', 'reversed')) IS NOT TRUE
           OR (o.company_id, o.fiscal_period_id, o.entry_date, o.voucher_number)
              IS DISTINCT FROM (n.company_id, n.fiscal_period_id, n.entry_date, n.voucher_number))
  ) k
  JOIN public.journal_entry_lines l ON l.journal_entry_id = k.id;

  PERFORM public.ledger_days_apply_lines(v_lines);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.ledger_days_on_entries() FROM PUBLIC, anon, authenticated;

-- A counting entry deleted (delete_last_voucher, reset_fiscal_year, a
-- cascade from its company): subtract its lines while they still exist, since
-- the cascade removes them before any AFTER trigger could read them. Named zz_
-- so it runs after every other BEFORE DELETE trigger: one that skips the
-- delete (returns NULL) or refuses it stops this one from running too.
CREATE OR REPLACE FUNCTION public.ledger_days_on_entry_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_lines jsonb;
BEGIN
  IF OLD.status IN ('posted', 'reversed') THEN
    SELECT jsonb_agg(jsonb_build_object(
             'company_id', OLD.company_id, 'fiscal_period_id', OLD.fiscal_period_id, 'entry_date', OLD.entry_date,
             'voucher_number', OLD.voucher_number, 'journal_entry_id', OLD.id,
             'account_number', l.account_number, 'debit_amount', l.debit_amount,
             'credit_amount', l.credit_amount, 'dimensions', l.dimensions, 's', -1))
      INTO v_lines
    FROM public.journal_entry_lines l
    WHERE l.journal_entry_id = OLD.id;
    PERFORM public.ledger_days_apply_lines(v_lines);
  END IF;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.ledger_days_on_entry_delete() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER ledger_days_lines_insert
  AFTER INSERT ON public.journal_entry_lines
  REFERENCING NEW TABLE AS new_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.ledger_days_on_lines();

CREATE TRIGGER ledger_days_lines_update
  AFTER UPDATE ON public.journal_entry_lines
  REFERENCING OLD TABLE AS old_lines NEW TABLE AS new_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.ledger_days_on_lines();

CREATE TRIGGER ledger_days_lines_delete
  AFTER DELETE ON public.journal_entry_lines
  REFERENCING OLD TABLE AS old_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.ledger_days_on_lines();

CREATE TRIGGER ledger_days_entries_update
  AFTER UPDATE ON public.journal_entries
  REFERENCING OLD TABLE AS old_entries NEW TABLE AS new_entries
  FOR EACH STATEMENT EXECUTE FUNCTION public.ledger_days_on_entries();

CREATE TRIGGER zz_ledger_days_entry_delete
  BEFORE DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.ledger_days_on_entry_delete();

-- An inserted entry has no lines yet (the lines reference it), so INSERT on
-- journal_entries needs no trigger: the lines trigger counts them.

-- ---------------------------------------------------------------------------
-- Building a company and checking it
-- ---------------------------------------------------------------------------

-- Recompute one company's rows in the summaries and the locators from the
-- journal and mark it built. Takes the company's lock exclusively (a delta in
-- flight finishes first, a new one waits) and gives up after lock_timeout
-- rather than queue behind a long import: the cron retries it on its next
-- run. The company's lines are read once for all four tables, since the
-- company's writers wait for the whole build (about 3 s for 60 000
-- verifikat).
CREATE OR REPLACE FUNCTION public.build_ledger_account_days(p_company_id uuid)
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

  DELETE FROM public.ledger_account_days WHERE company_id = p_company_id;
  DELETE FROM public.ledger_dimension_days WHERE company_id = p_company_id;
  DELETE FROM public.ledger_account_entries WHERE company_id = p_company_id;
  DELETE FROM public.ledger_dimension_entries WHERE company_id = p_company_id;

  WITH lines AS MATERIALIZED (
    SELECT e.company_id, e.fiscal_period_id, e.entry_date, e.voucher_number, e.id AS journal_entry_id,
           l.account_number, l.debit_amount, l.credit_amount, l.dimensions
    FROM public.journal_entries e
    JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
    WHERE e.company_id = p_company_id
      AND e.status IN ('posted', 'reversed')
  ),
  tags AS MATERIALIZED (
    SELECT x.*, d.key AS dim_no, d.value #>> '{}' AS code
    FROM lines x
    CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(x.dimensions) = 'object' THEN x.dimensions ELSE '{}'::jsonb END) d
    WHERE jsonb_typeof(d.value) = 'string'
  ),
  account_days AS (
    INSERT INTO public.ledger_account_days
      (company_id, fiscal_period_id, account_number, entry_date,
       debit, credit, net_debit, net_credit, line_count)
    SELECT x.company_id, x.fiscal_period_id, x.account_number, x.entry_date,
           sum(coalesce(x.debit_amount, 0)),
           sum(coalesce(x.credit_amount, 0)),
           sum(greatest(x.debit_amount - x.credit_amount, 0)),
           sum(greatest(x.credit_amount - x.debit_amount, 0)),
           count(*)::integer
    FROM lines x
    GROUP BY 1, 2, 3, 4
    RETURNING 1
  ),
  dimension_days AS (
    INSERT INTO public.ledger_dimension_days
      (company_id, fiscal_period_id, dim_no, code, account_number, entry_date,
       debit, credit, net_debit, net_credit, line_count)
    SELECT t.company_id, t.fiscal_period_id, t.dim_no, t.code, t.account_number, t.entry_date,
           sum(coalesce(t.debit_amount, 0)),
           sum(coalesce(t.credit_amount, 0)),
           sum(greatest(t.debit_amount - t.credit_amount, 0)),
           sum(greatest(t.credit_amount - t.debit_amount, 0)),
           count(*)::integer
    FROM tags t
    GROUP BY 1, 2, 3, 4, 5, 6
    RETURNING 1
  ),
  account_entries AS (
    INSERT INTO public.ledger_account_entries
      (company_id, fiscal_period_id, account_number, entry_date, voucher_number, journal_entry_id, line_count)
    SELECT x.company_id, x.fiscal_period_id, x.account_number, x.entry_date, x.voucher_number, x.journal_entry_id,
           count(*)::integer
    FROM lines x
    GROUP BY 1, 2, 3, 4, 5, 6
    RETURNING 1
  ),
  dimension_entries AS (
    INSERT INTO public.ledger_dimension_entries
      (company_id, fiscal_period_id, dim_no, code, account_number, entry_date, voucher_number, journal_entry_id, line_count)
    SELECT t.company_id, t.fiscal_period_id, t.dim_no, t.code, t.account_number, t.entry_date, t.voucher_number,
           t.journal_entry_id, count(*)::integer
    FROM tags t
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM account_days)::integer
    INTO v_rows
  FROM (SELECT count(*) FROM dimension_days) dd,
       (SELECT count(*) FROM account_entries) ae,
       (SELECT count(*) FROM dimension_entries) de;

  INSERT INTO public.ledger_account_days_companies (company_id, built_at)
  VALUES (p_company_id, now())
  ON CONFLICT (company_id) DO UPDATE SET built_at = EXCLUDED.built_at;

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.build_ledger_account_days(uuid) FROM PUBLIC, anon, authenticated;

-- A build runs longer than PostgREST's 8 s for the largest companies; it
-- gets the 30 s the SIE import's chunk writer gets. Restated from
-- 20261012100200 with build_ledger_account_days added.
CREATE OR REPLACE FUNCTION public.pre_request_statement_timeout() RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_path text := coalesce(current_setting('request.path', true), '');
BEGIN
  IF v_path ~ '/rpc/(import_sie_chunk|reconcile_sie_import|build_ledger_account_days)$' THEN
    PERFORM set_config('statement_timeout', '30s', true);
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.build_ledger_account_days(uuid) TO service_role;

COMMENT ON FUNCTION public.build_ledger_account_days(uuid) IS
  'Recomputes a company''s ledger_account_days, ledger_dimension_days, ledger_account_entries and ledger_dimension_entries rows from the journal under the company''s summary lock and marks it built. Service role only (the build cron).';

-- Fold one company's slot rows into slot 0 (sums unchanged) and drop keys
-- whose lines are all gone. Takes the company's summary lock shared, like a
-- writer: a build waits for it and it waits for a build. A writer adding to
-- a slot row meanwhile only makes the DELETE wait for that writer's commit,
-- and a slot row written after the DELETE started stays for the next run.
CREATE OR REPLACE FUNCTION public.compact_ledger_account_days(p_company_id uuid)
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
    DELETE FROM public.ledger_account_days
    WHERE company_id = p_company_id AND slot <> 0
    RETURNING *
  )
  INSERT INTO public.ledger_account_days AS t
    (company_id, fiscal_period_id, account_number, entry_date,
     debit, credit, net_debit, net_credit, line_count, slot)
  SELECT m.company_id, m.fiscal_period_id, m.account_number, m.entry_date,
         sum(m.debit), sum(m.credit), sum(m.net_debit), sum(m.net_credit), sum(m.line_count)::integer, 0
  FROM moved m
  GROUP BY 1, 2, 3, 4
  ORDER BY 1, 2, 3, 4
  ON CONFLICT (company_id, fiscal_period_id, account_number, entry_date, slot) DO UPDATE
  SET debit      = t.debit + EXCLUDED.debit,
      credit     = t.credit + EXCLUDED.credit,
      net_debit  = t.net_debit + EXCLUDED.net_debit,
      net_credit = t.net_credit + EXCLUDED.net_credit,
      line_count = t.line_count + EXCLUDED.line_count;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  WITH moved AS (
    DELETE FROM public.ledger_dimension_days
    WHERE company_id = p_company_id AND slot <> 0
    RETURNING *
  )
  INSERT INTO public.ledger_dimension_days AS t
    (company_id, fiscal_period_id, dim_no, code, account_number, entry_date,
     debit, credit, net_debit, net_credit, line_count, slot)
  SELECT m.company_id, m.fiscal_period_id, m.dim_no, m.code, m.account_number, m.entry_date,
         sum(m.debit), sum(m.credit), sum(m.net_debit), sum(m.net_credit), sum(m.line_count)::integer, 0
  FROM moved m
  GROUP BY 1, 2, 3, 4, 5, 6
  ORDER BY 1, 2, 3, 4, 5, 6
  ON CONFLICT (company_id, fiscal_period_id, dim_no, code, account_number, entry_date, slot) DO UPDATE
  SET debit      = t.debit + EXCLUDED.debit,
      credit     = t.credit + EXCLUDED.credit,
      net_debit  = t.net_debit + EXCLUDED.net_debit,
      net_credit = t.net_credit + EXCLUDED.net_credit,
      line_count = t.line_count + EXCLUDED.line_count;

  -- A key whose lines are all gone carries nothing (no line, zero sums).
  DELETE FROM public.ledger_account_days
  WHERE company_id = p_company_id AND slot = 0 AND line_count = 0;
  DELETE FROM public.ledger_dimension_days
  WHERE company_id = p_company_id AND slot = 0 AND line_count = 0;

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.compact_ledger_account_days(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compact_ledger_account_days(uuid) TO service_role;

-- Companies with slot rows to fold.
CREATE OR REPLACE FUNCTION public.ledger_account_days_unfolded(p_limit integer)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT u.company_id
  FROM (
    SELECT a.company_id FROM public.ledger_account_days a WHERE a.slot <> 0
    UNION
    SELECT d.company_id FROM public.ledger_dimension_days d WHERE d.slot <> 0
  ) u
  ORDER BY u.company_id
  LIMIT greatest(coalesce(p_limit, 0), 0)
$$;

REVOKE ALL ON FUNCTION public.ledger_account_days_unfolded(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ledger_account_days_unfolded(integer) TO service_role;

-- Companies the build cron still has to build (not listed as built yet),
-- smallest first, with how many verifikat each has: a company's writers wait
-- for its build, so the cron builds the large ones at night.
CREATE OR REPLACE FUNCTION public.ledger_account_days_pending(p_limit integer)
RETURNS TABLE (company_id uuid, entry_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT p.id, p.n
  FROM (
    SELECT c.id, (SELECT count(*) FROM public.journal_entries e WHERE e.company_id = c.id) AS n
    FROM public.companies c
    WHERE NOT EXISTS (
      SELECT 1 FROM public.ledger_account_days_companies r WHERE r.company_id = c.id
    )
  ) p
  ORDER BY p.n, p.id
  LIMIT greatest(coalesce(p_limit, 0), 0)
$$;

REVOKE ALL ON FUNCTION public.ledger_account_days_pending(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ledger_account_days_pending(integer) TO service_role;

-- Every key where a stored row and the journal disagree, for one company, in
-- both summaries (dim_no and code are NULL for ledger_account_days) and both
-- locators (journal_entry_id set, sums NULL; dim_no and code NULL for
-- ledger_account_entries). Empty when all four are right. For tests and for checking a company by hand;
-- it reads the company's whole journal, so not for request paths.
CREATE OR REPLACE FUNCTION public.ledger_account_days_drift(p_company_id uuid)
RETURNS TABLE (
  fiscal_period_id uuid,
  dim_no text,
  code text,
  account_number text,
  entry_date date,
  journal_entry_id uuid,
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
  WITH lines AS (
    SELECT e.fiscal_period_id, e.entry_date, l.account_number, l.debit_amount, l.credit_amount, l.dimensions
    FROM public.journal_entries e
    JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
    WHERE e.company_id = p_company_id
      AND e.status IN ('posted', 'reversed')
  ),
  journal AS (
    SELECT x.fiscal_period_id, NULL::text AS dim_no, NULL::text AS code, x.account_number, x.entry_date,
           sum(coalesce(x.debit_amount, 0)) AS debit,
           sum(coalesce(x.credit_amount, 0)) AS credit,
           sum(greatest(x.debit_amount - x.credit_amount, 0)) AS net_debit,
           sum(greatest(x.credit_amount - x.debit_amount, 0)) AS net_credit,
           count(*)::integer AS line_count
    FROM lines x
    GROUP BY 1, 2, 3, 4, 5
    UNION ALL
    SELECT x.fiscal_period_id, d.key, d.value #>> '{}', x.account_number, x.entry_date,
           sum(coalesce(x.debit_amount, 0)),
           sum(coalesce(x.credit_amount, 0)),
           sum(greatest(x.debit_amount - x.credit_amount, 0)),
           sum(greatest(x.credit_amount - x.debit_amount, 0)),
           count(*)::integer
    FROM lines x
    CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(x.dimensions) = 'object' THEN x.dimensions ELSE '{}'::jsonb END) d
    WHERE jsonb_typeof(d.value) = 'string'
    GROUP BY 1, 2, 3, 4, 5
  ),
  stored AS (
    SELECT k.*
    FROM (
      SELECT a.fiscal_period_id, NULL::text AS dim_no, NULL::text AS code, a.account_number, a.entry_date,
             sum(a.debit) AS debit, sum(a.credit) AS credit, sum(a.net_debit) AS net_debit,
             sum(a.net_credit) AS net_credit, sum(a.line_count)::integer AS line_count
      FROM public.ledger_account_days a
      WHERE a.company_id = p_company_id
      GROUP BY 1, 2, 3, 4, 5
      UNION ALL
      SELECT d.fiscal_period_id, d.dim_no, d.code, d.account_number, d.entry_date,
             sum(d.debit), sum(d.credit), sum(d.net_debit), sum(d.net_credit), sum(d.line_count)::integer
      FROM public.ledger_dimension_days d
      WHERE d.company_id = p_company_id
      GROUP BY 1, 2, 3, 4, 5
    ) k
    WHERE k.line_count <> 0 OR (k.debit, k.credit, k.net_debit, k.net_credit) <> (0, 0, 0, 0)
  ),
  stored_locator AS (
    SELECT a.fiscal_period_id, NULL::text AS dim_no, NULL::text AS code, a.account_number, a.entry_date,
           a.voucher_number, a.journal_entry_id, a.line_count
    FROM public.ledger_account_entries a
    WHERE a.company_id = p_company_id
    UNION ALL
    SELECT d.fiscal_period_id, d.dim_no, d.code, d.account_number, d.entry_date,
           d.voucher_number, d.journal_entry_id, d.line_count
    FROM public.ledger_dimension_entries d
    WHERE d.company_id = p_company_id
  ),
  journal_locator AS (
    SELECT e.fiscal_period_id, NULL::text AS dim_no, NULL::text AS code, l.account_number, e.entry_date,
           e.voucher_number, e.id AS journal_entry_id, count(*)::integer AS line_count
    FROM public.journal_entries e
    JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
    WHERE e.company_id = p_company_id
      AND e.status IN ('posted', 'reversed')
    GROUP BY 1, 2, 3, 4, 5, 6, 7
    UNION ALL
    SELECT e.fiscal_period_id, d.key, d.value #>> '{}', l.account_number, e.entry_date,
           e.voucher_number, e.id, count(*)::integer
    FROM public.journal_entries e
    JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
    CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(l.dimensions) = 'object' THEN l.dimensions ELSE '{}'::jsonb END) d
    WHERE e.company_id = p_company_id
      AND e.status IN ('posted', 'reversed')
      AND jsonb_typeof(d.value) = 'string'
    GROUP BY 1, 2, 3, 4, 5, 6, 7
  )
  SELECT coalesce(s.fiscal_period_id, j.fiscal_period_id),
         coalesce(s.dim_no, j.dim_no),
         coalesce(s.code, j.code),
         coalesce(s.account_number, j.account_number),
         coalesce(s.entry_date, j.entry_date),
         NULL::uuid,
         s.debit, j.debit, s.credit, j.credit, s.line_count, j.line_count
  FROM stored s
  FULL JOIN journal j
    ON j.fiscal_period_id = s.fiscal_period_id
   AND j.dim_no IS NOT DISTINCT FROM s.dim_no
   AND j.code IS NOT DISTINCT FROM s.code
   AND j.account_number = s.account_number
   AND j.entry_date = s.entry_date
  WHERE (s.debit, s.credit, s.net_debit, s.net_credit, s.line_count)
        IS DISTINCT FROM (j.debit, j.credit, j.net_debit, j.net_credit, j.line_count)
  UNION ALL
  SELECT coalesce(s.fiscal_period_id, j.fiscal_period_id),
         coalesce(s.dim_no, j.dim_no),
         coalesce(s.code, j.code),
         coalesce(s.account_number, j.account_number),
         coalesce(s.entry_date, j.entry_date),
         coalesce(s.journal_entry_id, j.journal_entry_id),
         NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, s.line_count, j.line_count
  FROM stored_locator s
  FULL JOIN journal_locator j
    ON j.fiscal_period_id = s.fiscal_period_id
   AND j.dim_no IS NOT DISTINCT FROM s.dim_no
   AND j.code IS NOT DISTINCT FROM s.code
   AND j.account_number = s.account_number
   AND j.entry_date = s.entry_date
   AND j.voucher_number = s.voucher_number
   AND j.journal_entry_id = s.journal_entry_id
  WHERE s.line_count IS DISTINCT FROM j.line_count
  ORDER BY 1, 2, 3, 4, 5, 6
$$;

REVOKE ALL ON FUNCTION public.ledger_account_days_drift(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ledger_account_days_drift(uuid) TO service_role;

-- New companies start complete: every line they ever get passes the triggers.
CREATE OR REPLACE FUNCTION public.ledger_days_on_company_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  INSERT INTO public.ledger_account_days_companies (company_id)
  VALUES (NEW.id)
  ON CONFLICT (company_id) DO NOTHING;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.ledger_days_on_company_insert() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER ledger_days_company_insert
  AFTER INSERT ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.ledger_days_on_company_insert();

-- Existing companies without a journal entry are complete already (empty).
-- The trigger locks above keep the journal still until this migration
-- commits, so no first entry can slip in between.
INSERT INTO public.ledger_account_days_companies (company_id)
SELECT c.id
FROM public.companies c
WHERE NOT EXISTS (SELECT 1 FROM public.journal_entries e WHERE e.company_id = c.id)
ON CONFLICT (company_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Readers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ledger_account_days_ready(p_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.ledger_account_days_companies r WHERE r.company_id = p_company_id
  )
$$;

REVOKE ALL ON FUNCTION public.ledger_account_days_ready(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ledger_account_days_ready(uuid) TO authenticated, service_role;

-- The rows that sum to a period's totals per account and day with some of
-- its entries left out: the stored rows, and the left-out entries' own lines
-- negated. Callers group them. p_exclude_ids may name anything; only the
-- period's posted/reversed entries are subtracted, since only those are in
-- the stored rows. SECURITY INVOKER: RLS applies to the caller on both the
-- rows and the subtracted lines. No SET clause, so the planner inlines it
-- into the caller's query and aggregates once.
CREATE OR REPLACE FUNCTION public.ledger_period_account_days(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_exclude_ids uuid[]
)
RETURNS TABLE (
  account_number text,
  entry_date date,
  debit numeric,
  credit numeric,
  net_debit numeric,
  net_credit numeric,
  line_count integer
)
LANGUAGE sql
STABLE
AS $$
  SELECT d.account_number, d.entry_date, d.debit, d.credit, d.net_debit, d.net_credit, d.line_count
  FROM public.ledger_account_days d
  WHERE d.company_id = p_company_id
    AND d.fiscal_period_id = p_fiscal_period_id
  UNION ALL
  SELECT l.account_number, e.entry_date,
         -coalesce(l.debit_amount, 0),
         -coalesce(l.credit_amount, 0),
         -greatest(l.debit_amount - l.credit_amount, 0),
         -greatest(l.credit_amount - l.debit_amount, 0),
         -1
  FROM unnest(coalesce(p_exclude_ids, '{}'::uuid[])) AS ex(id)
  JOIN public.journal_entries e ON e.id = ex.id
  JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
  WHERE e.company_id = p_company_id
    AND e.fiscal_period_id = p_fiscal_period_id
    AND e.status IN ('posted', 'reversed')
$$;

REVOKE ALL ON FUNCTION public.ledger_period_account_days(uuid, uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ledger_period_account_days(uuid, uuid, uuid[]) TO authenticated, service_role;

-- The same for one dimension: the rows that sum to a period's totals per
-- account, value and day for dimension p_dim_no (every value, or only
-- p_code), with the left-out entries' lines that carry it negated.
CREATE OR REPLACE FUNCTION public.ledger_period_dimension_days(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_dim_no text,
  p_code text,
  p_exclude_ids uuid[]
)
RETURNS TABLE (
  code text,
  account_number text,
  entry_date date,
  debit numeric,
  credit numeric,
  net_debit numeric,
  net_credit numeric,
  line_count integer
)
LANGUAGE sql
STABLE
AS $$
  SELECT d.code, d.account_number, d.entry_date, d.debit, d.credit, d.net_debit, d.net_credit, d.line_count
  FROM public.ledger_dimension_days d
  WHERE d.company_id = p_company_id
    AND d.fiscal_period_id = p_fiscal_period_id
    AND d.dim_no = p_dim_no
    AND (p_code IS NULL OR d.code = p_code)
  UNION ALL
  SELECT l.dimensions ->> p_dim_no, l.account_number, e.entry_date,
         -coalesce(l.debit_amount, 0),
         -coalesce(l.credit_amount, 0),
         -greatest(l.debit_amount - l.credit_amount, 0),
         -greatest(l.credit_amount - l.debit_amount, 0),
         -1
  FROM unnest(coalesce(p_exclude_ids, '{}'::uuid[])) AS ex(id)
  JOIN public.journal_entries e ON e.id = ex.id
  JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
  WHERE e.company_id = p_company_id
    AND e.fiscal_period_id = p_fiscal_period_id
    AND e.status IN ('posted', 'reversed')
    AND jsonb_typeof(l.dimensions -> p_dim_no) = 'string'
    AND (p_code IS NULL OR l.dimensions ->> p_dim_no = p_code)
$$;

REVOKE ALL ON FUNCTION public.ledger_period_dimension_days(uuid, uuid, text, text, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ledger_period_dimension_days(uuid, uuid, text, text, uuid[]) TO authenticated, service_role;

-- The entries of a period that 'exclude-all-year-end' leaves out: every
-- year_end entry, and every storno or rättelse of a reversed year_end entry
-- (company-wide: the chain can cross periods). The same set as the
-- line-level paths below and excludeYearEndChain in lib/reports/trial-balance.ts.
CREATE OR REPLACE FUNCTION public.year_end_chain_entry_ids(
  p_company_id uuid,
  p_fiscal_period_id uuid
)
RETURNS uuid[]
LANGUAGE sql
STABLE
SET search_path TO ''
AS $$
  WITH ye_reversed AS (
    SELECT y.id
    FROM public.journal_entries y
    WHERE y.company_id = p_company_id
      AND y.source_type = 'year_end'
      AND y.status = 'reversed'
  )
  SELECT coalesce(array_agg(DISTINCT e.id), '{}'::uuid[])
  FROM public.journal_entries e
  WHERE e.company_id = p_company_id
    AND e.fiscal_period_id = p_fiscal_period_id
    AND e.status IN ('posted', 'reversed')
    AND e.id IN (
      SELECT a.id FROM public.journal_entries a
      WHERE a.company_id = p_company_id AND a.source_type = 'year_end'
      UNION
      SELECT b.id FROM public.journal_entries b
      WHERE b.reverses_id IN (SELECT id FROM ye_reversed)
      UNION
      SELECT c.id FROM public.journal_entries c
      WHERE c.correction_of_id IN (SELECT id FROM ye_reversed)
    )
$$;

REVOKE ALL ON FUNCTION public.year_end_chain_entry_ids(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.year_end_chain_entry_ids(uuid, uuid) TO authenticated, service_role;

-- get_trial_balance_aggregates: the stored rows when the company is built and
-- the filter is at most one dimension value; otherwise the line-level query,
-- unchanged from 20260924202408. Every path returns the same set: an account
-- appears in a bucket exactly when at least one of its included lines falls
-- in it.
CREATE OR REPLACE FUNCTION public.get_trial_balance_aggregates(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_closing_mode text,
  p_from_date date DEFAULT NULL,
  p_to_date date DEFAULT NULL,
  p_exclude_entry_id uuid DEFAULT NULL,
  p_dimensions jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
SET work_mem TO '32MB'
AS $$
DECLARE
  v_period_start date;
  v_closing_entry_id uuid;
  v_is_closed boolean;
  v_closed_externally boolean;
  v_exclude_closing_ids uuid[] := '{}'::uuid[];
  v_roll_start date := NULL;
  v_exclude_ids uuid[];
  v_dim_no text;
  v_code text;
  v_summary boolean := false;
BEGIN
  IF p_closing_mode IS NULL
     OR p_closing_mode NOT IN ('include', 'exclude-final', 'exclude-all-year-end') THEN
    RAISE EXCEPTION 'get_trial_balance_aggregates: unknown closing mode %', p_closing_mode
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT fp.period_start, fp.closing_entry_id, fp.is_closed, fp.closed_externally
    INTO v_period_start, v_closing_entry_id, v_is_closed, v_closed_externally
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id;

  IF p_closing_mode = 'exclude-final' THEN
    IF v_is_closed IS TRUE
       AND v_closing_entry_id IS NULL
       AND v_closed_externally IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'Closed fiscal period is missing closing_entry_id; statutory pre-closing balances cannot be generated safely'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Posted entries only, so a reversed closing stays with its storno.
    v_exclude_closing_ids := public.result_closing_entry_ids(p_company_id, p_fiscal_period_id);
  END IF;

  IF p_from_date IS NOT NULL
     AND v_period_start IS NOT NULL
     AND p_from_date > v_period_start THEN
    v_roll_start := v_period_start;
  END IF;

  -- The summaries answer no filter and a filter on one string value; a
  -- filter on several values (a line must carry all of them) needs the lines.
  IF public.ledger_account_days_ready(p_company_id) THEN
    IF p_dimensions IS NULL THEN
      v_summary := true;
    ELSIF jsonb_typeof(p_dimensions) = 'object' THEN
      IF NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_dimensions)) THEN
        v_summary := true;
      ELSIF (SELECT count(*) FROM jsonb_object_keys(p_dimensions)) = 1 THEN
        SELECT d.key, d.value #>> '{}' INTO v_dim_no, v_code
        FROM jsonb_each(p_dimensions) d
        WHERE jsonb_typeof(d.value) = 'string';
        v_summary := v_dim_no IS NOT NULL;
      END IF;
    END IF;
  END IF;

  IF v_summary THEN
    v_exclude_ids := v_exclude_closing_ids
      || CASE WHEN p_exclude_entry_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[p_exclude_entry_id] END
      || CASE WHEN p_closing_mode = 'exclude-all-year-end'
              THEN public.year_end_chain_entry_ids(p_company_id, p_fiscal_period_id)
              ELSE '{}'::uuid[] END;

    RETURN (
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'bucket', t.bucket,
            'account_number', t.account_number,
            'debit', t.debit,
            'credit', t.credit
          )
          ORDER BY t.bucket, t.account_number
        ),
        '[]'::jsonb
      )
      FROM (
        SELECT b.bucket, b.account_number, sum(b.debit) AS debit, sum(b.credit) AS credit
        FROM (
          SELECT CASE
                   WHEN v_roll_start IS NOT NULL
                        AND d.entry_date >= v_roll_start
                        AND d.entry_date < p_from_date
                     THEN 'rollforward'
                   WHEN (p_from_date IS NULL OR d.entry_date >= p_from_date)
                        AND (p_to_date IS NULL OR d.entry_date <= p_to_date)
                     THEN 'period'
                   ELSE NULL
                 END AS bucket,
                 d.account_number, d.debit, d.credit, d.line_count
          FROM (
            SELECT a.account_number, a.entry_date, a.debit, a.credit, a.line_count
            FROM public.ledger_period_account_days(p_company_id, p_fiscal_period_id, v_exclude_ids) a
            WHERE v_dim_no IS NULL
            UNION ALL
            SELECT m.account_number, m.entry_date, m.debit, m.credit, m.line_count
            FROM public.ledger_period_dimension_days(p_company_id, p_fiscal_period_id, v_dim_no, v_code, v_exclude_ids) m
            WHERE v_dim_no IS NOT NULL
          ) d
        ) b
        WHERE b.bucket IS NOT NULL
        GROUP BY b.bucket, b.account_number
        HAVING sum(b.line_count) > 0
      ) t
    );
  END IF;

  RETURN (
  WITH ye_reversed AS (
    -- Company-wide, no period filter: a storno in this period can reverse a
    -- year-end entry from another period (mirrors the wave-1 fetch in
    -- lib/reports/trial-balance.ts).
    SELECT e.id
    FROM public.journal_entries e
    WHERE p_closing_mode = 'exclude-all-year-end'
      AND e.company_id = p_company_id
      AND e.source_type = 'year_end'
      AND e.status = 'reversed'
  ),
  entries AS (
    SELECT e.id, e.entry_date
    FROM public.journal_entries e
    WHERE e.company_id = p_company_id
      AND e.fiscal_period_id = p_fiscal_period_id
      AND e.status IN ('posted', 'reversed')
      AND (p_exclude_entry_id IS NULL OR e.id <> p_exclude_entry_id)
      AND (
        p_closing_mode <> 'exclude-all-year-end'
        OR (
          e.source_type IS DISTINCT FROM 'year_end'
          AND (e.reverses_id IS NULL
               OR e.reverses_id NOT IN (SELECT y.id FROM ye_reversed y))
          AND (e.correction_of_id IS NULL
               OR e.correction_of_id NOT IN (SELECT y.id FROM ye_reversed y))
        )
      )
      AND e.id <> ALL (v_exclude_closing_ids)
  ),
  bucketed AS (
    SELECT e.id,
           CASE
             WHEN v_roll_start IS NOT NULL
                  AND e.entry_date >= v_roll_start
                  AND e.entry_date < p_from_date
               THEN 'rollforward'
             WHEN (p_from_date IS NULL OR e.entry_date >= p_from_date)
                  AND (p_to_date IS NULL OR e.entry_date <= p_to_date)
               THEN 'period'
             ELSE NULL
           END AS bucket
    FROM entries e
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'bucket', t.bucket,
        'account_number', t.account_number,
        'debit', t.debit,
        'credit', t.credit
      )
      ORDER BY t.bucket, t.account_number
    ),
    '[]'::jsonb
  )
  FROM (
    SELECT b.bucket,
           l.account_number,
           sum(l.debit_amount) AS debit,
           sum(l.credit_amount) AS credit
    FROM public.journal_entry_lines l
    JOIN bucketed b ON b.id = l.journal_entry_id
    WHERE b.bucket IS NOT NULL
      AND (p_dimensions IS NULL OR l.dimensions @> p_dimensions)
    GROUP BY b.bucket, l.account_number
  ) t
  );
END;
$$;

COMMENT ON FUNCTION public.get_trial_balance_aggregates(uuid, uuid, text, date, date, uuid, jsonb) IS
  'Per-account debit/credit sums for a fiscal period (period + rollforward buckets) under one ClosingEntryMode; the SQL side of generateTrialBalance. Issue #2470. exclude-final drops result_closing_entry_ids. Reads ledger_account_days / ledger_dimension_days once the company is built and the filter is at most one dimension value.';

-- get_kpi_report_aggregates: the same split. The line-level query is
-- unchanged from 20261023081500 (årets resultat, 8990-8999, left out of the
-- monthly buckets), and the summary path reads the same predicate.
CREATE OR REPLACE FUNCTION public.get_kpi_report_aggregates(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_ob_entry_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_ob uuid[] := CASE WHEN p_ob_entry_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[p_ob_entry_id] END;
  v_ob_and_year_end uuid[];
BEGIN
  IF public.ledger_account_days_ready(p_company_id) THEN
    v_ob_and_year_end := v_ob || public.year_end_chain_entry_ids(p_company_id, p_fiscal_period_id);

    RETURN (
      WITH tb AS (
        SELECT d.account_number, sum(d.debit) AS debit, sum(d.credit) AS credit
        FROM public.ledger_period_account_days(p_company_id, p_fiscal_period_id, v_ob) d
        GROUP BY d.account_number
        HAVING sum(d.line_count) > 0
      ),
      ex_year_end AS (
        SELECT d.account_number, d.entry_date, d.debit, d.credit, d.net_debit, d.net_credit, d.line_count
        FROM public.ledger_period_account_days(p_company_id, p_fiscal_period_id, v_ob_and_year_end) d
      ),
      tb_ex_year_end AS (
        SELECT x.account_number, sum(x.debit) AS debit, sum(x.credit) AS credit
        FROM ex_year_end x
        GROUP BY x.account_number
        HAVING sum(x.line_count) > 0
      ),
      monthly AS (
        -- Per line: class 3 credit - debit, class 4-7 debit - credit, class 8
        -- (not årets resultat, 8990-8999) by its own sign; net_credit -
        -- net_debit is the line
        -- difference with NULL differences left out, as the line query sums.
        SELECT EXTRACT(YEAR FROM x.entry_date)::int AS year,
               EXTRACT(MONTH FROM x.entry_date)::int AS month,
               (
                 COALESCE(sum(x.net_credit - x.net_debit) FILTER (WHERE x.account_number ~ '^3'), 0)
                 + COALESCE(sum(x.net_credit) FILTER (WHERE x.account_number ~ '^8' AND x.account_number NOT BETWEEN '8990' AND '8999'), 0)
               )::float8 AS income,
               (
                 COALESCE(sum(x.net_debit - x.net_credit) FILTER (WHERE x.account_number ~ '^[4-7]'), 0)
                 + COALESCE(sum(x.net_debit) FILTER (WHERE x.account_number ~ '^8' AND x.account_number NOT BETWEEN '8990' AND '8999'), 0)
               )::float8 AS expenses
        FROM ex_year_end x
        WHERE x.account_number ~ '^[3-8]'
        GROUP BY 1, 2
        HAVING sum(x.line_count) > 0
      )
      SELECT jsonb_build_object(
        'tb', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'account_number', t.account_number,
            'debit', t.debit::float8,
            'credit', t.credit::float8
          ) ORDER BY t.account_number)
          FROM tb t
        ), '[]'::jsonb),
        'tb_ex_year_end', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'account_number', t.account_number,
            'debit', t.debit::float8,
            'credit', t.credit::float8
          ) ORDER BY t.account_number)
          FROM tb_ex_year_end t
        ), '[]'::jsonb),
        'ob', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'account_number', t.account_number,
            'debit', t.debit,
            'credit', t.credit
          ) ORDER BY t.account_number)
          FROM (
            -- No status filter: getOpeningBalances only checks id + company_id.
            SELECT l.account_number,
                   sum(l.debit_amount)::float8 AS debit,
                   sum(l.credit_amount)::float8 AS credit
            FROM public.journal_entry_lines l
            JOIN public.journal_entries e
              ON e.id = l.journal_entry_id
             AND e.id = p_ob_entry_id
             AND e.company_id = p_company_id
            GROUP BY l.account_number
          ) t
        ), '[]'::jsonb),
        'monthly', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'year', m.year,
            'month', m.month,
            'income', m.income,
            'expenses', m.expenses
          ) ORDER BY m.year, m.month)
          FROM monthly m
        ), '[]'::jsonb)
      )
    );
  END IF;

  RETURN (
WITH period_entries AS (
  SELECT id, entry_date, status, source_type, reverses_id, correction_of_id
  FROM public.journal_entries
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id
    AND status IN ('posted', 'reversed')
),
tb_entries AS (
  SELECT * FROM period_entries
  WHERE p_ob_entry_id IS NULL OR id <> p_ob_entry_id
),
ye_reversed AS (
  -- Company-wide (no period filter), mirroring the wave-1 fetch in
  -- lib/reports/trial-balance.ts: a storno in this period can reverse a
  -- year-end entry from another period.
  SELECT id
  FROM public.journal_entries
  WHERE company_id = p_company_id
    AND source_type = 'year_end'
    AND status = 'reversed'
),
tb_ex_ye_entries AS (
  SELECT * FROM tb_entries
  WHERE source_type IS DISTINCT FROM 'year_end'
    AND (reverses_id IS NULL
         OR reverses_id NOT IN (SELECT id FROM ye_reversed))
    AND (correction_of_id IS NULL
         OR correction_of_id NOT IN (SELECT id FROM ye_reversed))
)
SELECT jsonb_build_object(
  'tb', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'account_number', t.account_number,
      'debit', t.debit,
      'credit', t.credit
    ) ORDER BY t.account_number)
    FROM (
      SELECT l.account_number,
             sum(l.debit_amount)::float8 AS debit,
             sum(l.credit_amount)::float8 AS credit
      FROM public.journal_entry_lines l
      JOIN tb_entries e ON e.id = l.journal_entry_id
      GROUP BY l.account_number
    ) t
  ), '[]'::jsonb),
  'tb_ex_year_end', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'account_number', t.account_number,
      'debit', t.debit,
      'credit', t.credit
    ) ORDER BY t.account_number)
    FROM (
      SELECT l.account_number,
             sum(l.debit_amount)::float8 AS debit,
             sum(l.credit_amount)::float8 AS credit
      FROM public.journal_entry_lines l
      JOIN tb_ex_ye_entries e ON e.id = l.journal_entry_id
      GROUP BY l.account_number
    ) t
  ), '[]'::jsonb),
  'ob', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'account_number', t.account_number,
      'debit', t.debit,
      'credit', t.credit
    ) ORDER BY t.account_number)
    FROM (
      -- No status filter: getOpeningBalances only checks id + company_id.
      SELECT l.account_number,
             sum(l.debit_amount)::float8 AS debit,
             sum(l.credit_amount)::float8 AS credit
      FROM public.journal_entry_lines l
      JOIN public.journal_entries e
        ON e.id = l.journal_entry_id
       AND e.id = p_ob_entry_id
       AND e.company_id = p_company_id
      GROUP BY l.account_number
    ) t
  ), '[]'::jsonb),
  'monthly', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'year', m.year,
      'month', m.month,
      'income', m.income,
      'expenses', m.expenses
    ) ORDER BY m.year, m.month)
    FROM (
      SELECT EXTRACT(YEAR FROM e.entry_date)::int AS year,
             EXTRACT(MONTH FROM e.entry_date)::int AS month,
             (
               COALESCE(sum(CASE
                 WHEN l.account_number ~ '^3'
                 THEN l.credit_amount - l.debit_amount
               END), 0)
               + COALESCE(sum(CASE
                 WHEN l.account_number ~ '^8'
                  AND l.account_number NOT BETWEEN '8990' AND '8999'
                  AND (l.credit_amount - l.debit_amount) >= 0
                 THEN l.credit_amount - l.debit_amount
               END), 0)
             )::float8 AS income,
             (
               COALESCE(sum(CASE
                 WHEN l.account_number ~ '^[4-7]'
                 THEN l.debit_amount - l.credit_amount
               END), 0)
               + COALESCE(sum(CASE
                 WHEN l.account_number ~ '^8'
                  AND l.account_number NOT BETWEEN '8990' AND '8999'
                  AND (l.credit_amount - l.debit_amount) < 0
                 THEN l.debit_amount - l.credit_amount
               END), 0)
             )::float8 AS expenses
      FROM public.journal_entry_lines l
      -- The same entry set as tb_ex_year_end, with NO extra status predicate:
      -- posted AND reversed originals, minus the undone year-end chain. A
      -- reversed original and its storno then cancel within the year exactly
      -- as they do in the year total, so sum(months) = Nettoresultat. Matches
      -- lib/reports/monthly-breakdown.ts.
      JOIN tb_ex_ye_entries e
        ON e.id = l.journal_entry_id
      WHERE l.account_number ~ '^[3-8]'
      GROUP BY 1, 2
    ) m
  ), '[]'::jsonb)
)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_kpi_report_aggregates(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_kpi_report_aggregates(uuid, uuid, uuid) TO authenticated, service_role;

-- The dimension P&L's tagged pass (generateDimensionPnl): per account and
-- value of dimension p_dim_no, the debit and credit of the lines the trial
-- balance behind its Totalt column sums ('exclude-all-year-end' without the
-- IB entry: this period, posted or reversed, inside [p_from_date, p_to_date],
-- no opening-balance entry, no year_end entry or its storno chain), per value
-- as stored: the report trims and merges them (JavaScript trim). From
-- ledger_dimension_days once the company is built, from the lines otherwise.
-- Returns jsonb (no PostgREST max-rows cap).
CREATE OR REPLACE FUNCTION public.get_dimension_pnl_buckets(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_dim_no text,
  p_from_date date,
  p_to_date date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO ''
AS $$
DECLARE
  v_exclude_ids uuid[];
BEGIN
  SELECT coalesce(array_remove(ARRAY[fp.opening_balance_entry_id], NULL), '{}'::uuid[])
         || public.year_end_chain_entry_ids(p_company_id, p_fiscal_period_id)
    INTO v_exclude_ids
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id;

  IF public.ledger_account_days_ready(p_company_id) THEN
    RETURN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'account_number', t.account_number, 'code', t.code,
               'debit', t.debit, 'credit', t.credit) ORDER BY t.account_number, t.code), '[]'::jsonb)
      FROM (
        SELECT d.account_number, d.code, sum(d.debit) AS debit, sum(d.credit) AS credit
        FROM public.ledger_period_dimension_days(p_company_id, p_fiscal_period_id, p_dim_no, NULL, v_exclude_ids) d
        WHERE (p_from_date IS NULL OR d.entry_date >= p_from_date)
          AND (p_to_date IS NULL OR d.entry_date <= p_to_date)
        GROUP BY 1, 2
        HAVING sum(d.line_count) > 0
      ) t
    );
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'account_number', t.account_number, 'code', t.code,
             'debit', t.debit, 'credit', t.credit) ORDER BY t.account_number, t.code), '[]'::jsonb)
    FROM (
      SELECT l.account_number, l.dimensions ->> p_dim_no AS code,
             sum(coalesce(l.debit_amount, 0)) AS debit, sum(coalesce(l.credit_amount, 0)) AS credit
      FROM public.journal_entries e
      JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
      WHERE e.company_id = p_company_id
        AND e.fiscal_period_id = p_fiscal_period_id
        AND e.status IN ('posted', 'reversed')
        AND (p_from_date IS NULL OR e.entry_date >= p_from_date)
        AND (p_to_date IS NULL OR e.entry_date <= p_to_date)
        AND e.id <> ALL (coalesce(v_exclude_ids, '{}'::uuid[]))
        AND jsonb_typeof(l.dimensions -> p_dim_no) = 'string'
      GROUP BY 1, 2
    ) t
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_dimension_pnl_buckets(uuid, uuid, text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dimension_pnl_buckets(uuid, uuid, text, date, date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
