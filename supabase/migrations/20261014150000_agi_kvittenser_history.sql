-- agi_kvittenser: every AGI kvittens Skatteverket returns, kept.
--
-- Why: agi_declarations holds one row per company and redovisningsperiod, and
-- its kvittensnummer/response_data columns hold ONE receipt. A correction is a
-- complete replacement declaration for the same period that gets its own
-- kvittens, and recording it wrote over the original filing's receipt. A
-- received electronic document is kept with the content it had when received
-- and must not be altered (BFL 7 kap. 1 § tredje stycket); a correction must
-- leave the original visible (BFL 5 kap. 5 §). agi_declarations keeps the
-- current state (the latest receipt wins, as before); this table keeps them
-- all.
--
-- Lifecycle:
--   * Append-only: UPDATE is always refused; DELETE passes only through the
--     company cascade (trigger depth > 1) or under gnubok.allow_delete
--     (operator and sandbox-teardown override), as suggestion_log.
--   * No foreign key to agi_declarations: a SET NULL cascade would be an
--     UPDATE (refused above) and RESTRICT would block the sandbox teardown,
--     which deletes declarations before companies. The redovisningsperiod
--     (UNIQUE per company on agi_declarations) names the declaration.
--   * Idempotent: UNIQUE (company_id, uuid_kvittens), so the cron, the
--     post-connect refresh and the panel's "Hämta kvittens" can all record
--     what they read with ON CONFLICT DO NOTHING.
--   * receipt is the kvittens as received from Skatteverket (the same object
--     agi_declarations.response_data has always stored, signatory included).
--
-- Backfill: every receipt agi_declarations holds today is copied in, so the
-- next correction cannot write over it. A receipt that a correction already
-- replaced is not in the database any more; Skatteverket lists every kvittens
-- of a period, and the writers record them all on their next read.
--
-- pg-test: covered-by tests/pg/agi-kvittenser.pg.test.ts

CREATE TABLE public.agi_kvittenser (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  period_year   integer NOT NULL,
  period_month  integer NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  uuid_kvittens text NOT NULL CHECK (length(uuid_kvittens) > 0),
  signerad_tid  timestamptz,
  receipt       jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  recorded_by   text NOT NULL
    CHECK (recorded_by IN ('cron', 'post-connect', 'interactive', 'backfill')),
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agi_kvittenser_company_kvittens_key UNIQUE (company_id, uuid_kvittens)
);

COMMENT ON TABLE public.agi_kvittenser IS
  'Every AGI kvittens Skatteverket returned for a company and redovisningsperiod, as received. Append-only; agi_declarations keeps the latest as the period''s current state.';
COMMENT ON COLUMN public.agi_kvittenser.receipt IS
  'The kvittens as received: uuidKvittens, signeradAv, signeradTid, arbetsgivare, period, underlag.';
COMMENT ON COLUMN public.agi_kvittenser.recorded_by IS
  'Which read recorded it: the kvittens cron, the post-connect refresh, the panel''s interactive check, or the 20261014150000 backfill.';

CREATE INDEX idx_agi_kvittenser_period
  ON public.agi_kvittenser (company_id, period_year, period_month, signerad_tid DESC);

-- Backfill before the triggers below exist: an archived migration-reset
-- source company keeps its receipt too.
INSERT INTO public.agi_kvittenser
  (company_id, period_year, period_month, uuid_kvittens, signerad_tid, receipt, recorded_by, recorded_at)
SELECT
  d.company_id,
  d.period_year,
  d.period_month,
  d.kvittensnummer,
  CASE
    WHEN d.response_data ->> 'signeradTid' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}'
      THEN (d.response_data ->> 'signeradTid')::timestamptz
  END,
  COALESCE(d.response_data, '{}'::jsonb) || jsonb_build_object('uuidKvittens', d.kvittensnummer),
  'backfill',
  COALESCE(d.submitted_at, d.updated_at)
FROM public.agi_declarations d
WHERE d.kvittensnummer IS NOT NULL
  AND length(d.kvittensnummer) > 0
ON CONFLICT (company_id, uuid_kvittens) DO NOTHING;

ALTER TABLE public.agi_kvittenser ENABLE ROW LEVEL SECURITY;

-- Rows are inserted, never changed: nobody gets UPDATE. service_role keeps
-- DELETE for the gnubok.allow_delete path; members read and record.
GRANT SELECT, INSERT, DELETE ON TABLE public.agi_kvittenser TO service_role;
GRANT SELECT, INSERT ON TABLE public.agi_kvittenser TO authenticated;
-- no-grant: anon on public.agi_kvittenser (receipts are read and recorded by members and the cron only)

CREATE POLICY "view own-company agi_kvittenser"
  ON public.agi_kvittenser FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "record own-company agi_kvittenser"
  ON public.agi_kvittenser FOR INSERT
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
  );

CREATE OR REPLACE FUNCTION public.agi_kvittenser_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- A receipt leaves only with its company (the cascade runs at trigger
  -- depth > 1) or under the operator and sandbox-teardown override. UPDATE
  -- has no exception: a receipt is kept as received.
  IF TG_OP = 'DELETE'
     AND (pg_trigger_depth() > 1 OR current_setting('gnubok.allow_delete', true) = 'true') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'agi_kvittenser is append-only: % is not allowed', TG_OP;
END;
$$;

REVOKE ALL ON FUNCTION public.agi_kvittenser_append_only() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.agi_kvittenser
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

-- Archived migration-reset source companies are static (20260818084050).
CREATE TRIGGER agi_kvittenser_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.agi_kvittenser
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

CREATE TRIGGER agi_kvittenser_append_only
  BEFORE UPDATE OR DELETE ON public.agi_kvittenser
  FOR EACH ROW EXECUTE FUNCTION public.agi_kvittenser_append_only();

NOTIFY pgrst, 'reload schema';
