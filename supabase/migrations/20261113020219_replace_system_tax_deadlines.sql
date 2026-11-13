-- Two regenerations of one company's tax deadlines can no longer delete each
-- other's rows.
--
-- generateTaxDeadlinesForUser (src/lib/tax/deadline-generator.ts) inserted
-- the company's new set of system deadlines and then, in a second statement,
-- deleted every other pending system row in the window. Two regenerations
-- that overlap (the nightly repair racing a settings save, or two runs of the
-- cron) each ran "delete everything but mine" after the other's insert, so
-- each deleted the other's fresh rows and the company was left with part of a
-- set or none, until the next nightly repair. No unique key stands in the way:
-- pending rows of one period coexist by design while a set is being replaced
-- (20261109060000).
--
-- replace_system_tax_deadlines does the insert and the delete in one
-- transaction under a per-company advisory lock. A second regeneration waits
-- for the first to commit and then replaces its set whole, so the company
-- always holds exactly one complete set: the one written last. The rows are
-- the generator's own (the same objects it handed PostgREST), inserted with
-- the columns they carry; the delete is the one the generator ran: pending,
-- not dismissed, system rows of the company due inside the window, except the
-- rows just inserted. Completed and dismissed rows are never touched.
--
-- SECURITY INVOKER: the caller keeps the rights it had when this was two
-- statements (the deadlines policies and the company-writer gate).
--
-- pg-test: tests/pg/replace-system-tax-deadlines.pg.test.ts

CREATE OR REPLACE FUNCTION public.replace_system_tax_deadlines(
  p_company_id uuid,
  p_rows jsonb,
  p_from date,
  p_to date
)
RETURNS TABLE(created integer, deleted integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_columns text;
  v_new_ids uuid[] := '{}'::uuid[];
  v_deleted integer := 0;
BEGIN
  IF p_company_id IS NULL OR p_from IS NULL OR p_to IS NULL
     OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'replace_system_tax_deadlines: company, window and a row array are required'
      USING ERRCODE = '22023';
  END IF;

  -- Only this company's system rows: the delete below is scoped the same way,
  -- so a row of another company or a user's own deadline has no business here.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_rows) AS r(item)
     WHERE jsonb_typeof(r.item) <> 'object'
        OR (r.item ->> 'company_id') IS DISTINCT FROM p_company_id::text
        OR (r.item ->> 'source') IS DISTINCT FROM 'system'
  ) THEN
    RAISE EXCEPTION 'replace_system_tax_deadlines: every row must be a system deadline of company %', p_company_id
      USING ERRCODE = '22023';
  END IF;

  -- One regeneration of a company at a time, until this transaction ends.
  PERFORM pg_advisory_xact_lock(hashtextextended('tax-deadlines:' || p_company_id::text, 0));

  IF jsonb_array_length(p_rows) > 0 THEN
    -- The columns the rows carry, as PostgREST's bulk insert reads them; a
    -- column the table does not have fails here (42703), loudly.
    SELECT string_agg(quote_ident(keys.k), ', ' ORDER BY keys.k)
      INTO v_columns
      FROM (
        SELECT DISTINCT jsonb_object_keys(r.item) AS k
          FROM jsonb_array_elements(p_rows) AS r(item)
      ) AS keys;

    EXECUTE format(
      'WITH inserted AS (
         INSERT INTO public.deadlines (%1$s)
         SELECT %1$s FROM jsonb_populate_recordset(NULL::public.deadlines, $1)
         RETURNING id
       )
       SELECT coalesce(array_agg(inserted.id), ''{}''::uuid[]) FROM inserted',
      v_columns
    )
    INTO v_new_ids
    USING p_rows;
  END IF;

  DELETE FROM public.deadlines d
   WHERE d.company_id = p_company_id
     AND d.source = 'system'
     AND d.is_completed = false
     AND d.dismissed_at IS NULL
     AND d.due_date >= p_from
     AND d.due_date <= p_to
     AND NOT (d.id = ANY (v_new_ids));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN QUERY SELECT coalesce(array_length(v_new_ids, 1), 0), v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.replace_system_tax_deadlines(uuid, jsonb, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_system_tax_deadlines(uuid, jsonb, date, date) TO authenticated, service_role;

COMMENT ON FUNCTION public.replace_system_tax_deadlines(uuid, jsonb, date, date)
  IS 'Replaces a company''s pending system tax deadlines in the window with the given set, insert and delete in one transaction under a per-company advisory lock, so overlapping regenerations cannot delete each other''s rows.';

NOTIFY pgrst, 'reload schema';
