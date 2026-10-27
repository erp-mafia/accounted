-- Invoice reminders before the switch-on (accounted#104): what a failed send
-- means, a reservation that never finished, the daily run's reads, and who
-- may write the ledger.
--
--   invoice_reminders.outcome_unknown
--     On a failed row only. false: the provider refused the send, nothing
--     went out, and the next decision takes the same row back and tries
--     again (one row per invoice and level stays the rule). true: the mail
--     may have gone out (no answer, a server error after the provider took
--     it, a send interrupted before its outcome was recorded), so the ladder
--     stops for a person. NULL on a failed row reads as unknown.
--
--   invoice_reminders.reserved_at
--     When the current attempt was reserved: set on the reservation and
--     again when a refused row is taken back. NULL on the old sender's rows.
--
--   sweep_interrupted_invoice_reminders(p_reserved_before)
--     A row still reserved long after any send path could be running (the
--     process died mid-send, or the sent update failed) is marked failed
--     with an unknown outcome, so it stops reading as in flight forever and
--     shows in the daily batch for a person. Archived migration-reset source
--     companies are left untouched.
--
--   list_reminder_batch_companies()
--     The companies the daily run visits: reminders on, stamped, and not
--     archived, a migration-reset source or a sandbox (the companyInactive
--     rule of src/lib/reminders/facts.ts). Says whether the person who
--     turned automatic sending on is still an owner or administrator.
--
--   list_reminder_candidate_invoices(p_company_id, p_due_on_or_before, p_enabled_on)
--     The invoices the run decides: issued, still open, due early enough,
--     and either dated on or after the day reminders went on or already
--     holding a reminder row. Every other invoice is one the policy never
--     reminds by itself and never lists (policy.ts), so it is not read.
--
--   REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON invoice_reminders FROM anon, authenticated
--     Every write runs on the service role (dispatch.ts, the answer page,
--     the delivery webhook); a member's direct write could delete a sent
--     level-1 row and the ladder would send level 1 again.
--
-- The three functions are service-role only. Schema only, no data UPDATE.
--
-- pg-test: tests/pg/invoice-reminders-outcome-and-grants.pg.test.ts

ALTER TABLE public.invoice_reminders
  ADD COLUMN IF NOT EXISTS outcome_unknown boolean,
  ADD COLUMN IF NOT EXISTS reserved_at timestamptz;

-- New reservations are stamped; the existing rows keep NULL.
ALTER TABLE public.invoice_reminders ALTER COLUMN reserved_at SET DEFAULT now();

ALTER TABLE public.invoice_reminders
  DROP CONSTRAINT IF EXISTS invoice_reminders_outcome_shape;
ALTER TABLE public.invoice_reminders
  ADD CONSTRAINT invoice_reminders_outcome_shape CHECK (outcome_unknown IS NULL OR status = 'failed');

COMMENT ON COLUMN public.invoice_reminders.outcome_unknown IS
  'Failed rows only. false: the provider refused the send and nothing went out (the next decision tries the same row again); true or NULL: it may have gone out, and the ladder stops for a person.';
COMMENT ON COLUMN public.invoice_reminders.reserved_at IS
  'When the current send attempt was reserved; a row reserved longer than any send runs is swept to failed with an unknown outcome.';

-- authenticated reads every column but action_token (tests/pg/credential-columns.pg.test.ts).
GRANT SELECT (outcome_unknown, reserved_at) ON public.invoice_reminders TO authenticated;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.invoice_reminders FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.sweep_interrupted_invoice_reminders(p_reserved_before timestamptz)
RETURNS TABLE (company_id uuid, swept integer)
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, public
AS $$
  WITH swept AS (
    UPDATE public.invoice_reminders AS r
    SET status = 'failed',
        failed_at = now(),
        error_code = 'SEND_INTERRUPTED',
        outcome_unknown = true
    WHERE r.status = 'reserved'
      AND COALESCE(r.reserved_at, r.created_at) < p_reserved_before
      AND NOT EXISTS (
        SELECT 1 FROM public.company_migration_resets AS m WHERE m.source_company_id = r.company_id
      )
    RETURNING r.company_id
  )
  SELECT s.company_id, count(*)::integer
  FROM swept AS s
  GROUP BY s.company_id;
$$;

REVOKE ALL ON FUNCTION public.sweep_interrupted_invoice_reminders(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_interrupted_invoice_reminders(timestamptz) TO service_role;

COMMENT ON FUNCTION public.sweep_interrupted_invoice_reminders(timestamptz) IS
  'Marks reminders still reserved before p_reserved_before as failed with an unknown outcome (SEND_INTERRUPTED); returns the count per company. Service role only.';

CREATE OR REPLACE FUNCTION public.list_reminder_batch_companies()
RETURNS TABLE (
  company_id uuid,
  reminders_automatic_at timestamptz,
  reminders_automatic_by uuid,
  automatic_by_admin boolean
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT
    cs.company_id,
    cs.reminders_automatic_at,
    cs.reminders_automatic_by,
    EXISTS (
      SELECT 1
      FROM public.company_members AS member
      WHERE member.company_id = cs.company_id
        AND member.user_id = cs.reminders_automatic_by
        AND member.role IN ('owner', 'admin')
    )
  FROM public.company_settings AS cs
  JOIN public.companies AS c ON c.id = cs.company_id
  WHERE cs.send_invoice_reminders IS TRUE
    AND cs.reminders_enabled_at IS NOT NULL
    AND c.archived_at IS NULL
    AND cs.is_sandbox IS NOT TRUE
    AND NOT EXISTS (
      SELECT 1 FROM public.company_migration_resets AS m WHERE m.source_company_id = cs.company_id
    );
$$;

REVOKE ALL ON FUNCTION public.list_reminder_batch_companies() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_reminder_batch_companies() TO service_role;

COMMENT ON FUNCTION public.list_reminder_batch_companies() IS
  'The companies the daily reminder run visits: reminders on and stamped, not archived, not a migration-reset source, not a sandbox. Service role only.';

CREATE OR REPLACE FUNCTION public.list_reminder_candidate_invoices(
  p_company_id uuid,
  p_due_on_or_before date,
  p_enabled_on date
)
RETURNS TABLE (id uuid, due_date date)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT i.id, i.due_date
  FROM public.invoices AS i
  WHERE i.company_id = p_company_id
    AND i.status IN ('sent', 'overdue', 'partially_paid')
    AND i.due_date <= p_due_on_or_before
    AND (
      i.invoice_date >= p_enabled_on
      OR EXISTS (SELECT 1 FROM public.invoice_reminders AS r WHERE r.invoice_id = i.id)
    );
$$;

REVOKE ALL ON FUNCTION public.list_reminder_candidate_invoices(uuid, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_reminder_candidate_invoices(uuid, date, date) TO service_role;

COMMENT ON FUNCTION public.list_reminder_candidate_invoices(uuid, date, date) IS
  'Open issued invoices of a company due on or before p_due_on_or_before, dated on or after p_enabled_on or already holding a reminder row: the ones the daily reminder run decides. Service role only.';

NOTIFY pgrst, 'reload schema';
