-- A kvarskatt deadline already past its due date is replaced on regeneration,
-- not added to (crm#2084).
--
-- The deadline generator (src/lib/tax/deadline-generator.ts) skips every
-- obligation whose date has passed, except a tax assessment notice's
-- kvarskatt: a notice entered after its payment date must still show. But
-- replace_system_tax_deadlines (20261113020219) deletes only the pending rows
-- inside the window, which starts today. The notice's previous pending row
-- lies before it, so it survived next to the new one, and every regeneration
-- (a settings save, a notice created or edited, the nightly repair) added one
-- more pending kvarskatt row for the same notice. No unique key stands in the
-- way: pending rows of one obligation coexist while a set is being replaced.
--
-- The rule now: the delete also takes every pending, not dismissed system row
-- of a notice the new set has a row for, wherever its date falls. A notice is
-- one obligation with the one date Skatteverket set, so its new row replaces
-- all of its old pending ones. Every other row before the window stays, as
-- before: an overdue obligation the new set does not restate (an unfiled moms
-- period) is a missed filing, and a replacement never hides one. That holds
-- even for a period the new set dates later (a helårsmoms period with an
-- overdue row on its EU-trade date), so the identity used is the notice, not
-- tax_deadline_type and tax_period.
--
-- The body is 20261113020219's, with the delete widened as above. Completed
-- and dismissed rows are still never touched.
--
-- pg-test: covered-by tests/pg/replace-system-tax-deadlines.pg.test.ts

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

  -- The pending rows inside the window, and those of a notice the new set
  -- has a row for wherever they fall (a kvarskatt already past due).
  DELETE FROM public.deadlines d
   WHERE d.company_id = p_company_id
     AND d.source = 'system'
     AND d.is_completed = false
     AND d.dismissed_at IS NULL
     AND (
       (d.due_date >= p_from AND d.due_date <= p_to)
       OR d.tax_assessment_notice_id IN (
         SELECT n.tax_assessment_notice_id
           FROM public.deadlines n
          WHERE n.id = ANY (v_new_ids)
            AND n.tax_assessment_notice_id IS NOT NULL
       )
     )
     AND NOT (d.id = ANY (v_new_ids));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN QUERY SELECT coalesce(array_length(v_new_ids, 1), 0), v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.replace_system_tax_deadlines(uuid, jsonb, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_system_tax_deadlines(uuid, jsonb, date, date) TO authenticated, service_role;

COMMENT ON FUNCTION public.replace_system_tax_deadlines(uuid, jsonb, date, date)
  IS 'Replaces a company''s pending system tax deadlines in the window, and the pending rows of every tax assessment notice in the given set wherever they fall, with the given set: insert and delete in one transaction under a per-company advisory lock, so overlapping regenerations cannot delete each other''s rows.';

NOTIFY pgrst, 'reload schema';
