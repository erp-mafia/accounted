-- Events are kept; what can name a person leaves an event after 30 days.
--
-- From 2026-11-23 the events cleanup cron (/api/events/cleanup/cron) deletes
-- no business event from event_log and no row from the event outbox
-- (event_outbox, event_deliveries); their rows go only with their company
-- (ON DELETE CASCADE). An event carries the records it is about as they were
-- emitted: a customer with name and e-mail address, an invoice with its
-- customer and lines, a bank transaction with its text. Those details have
-- their home in the record itself, where the register's rättelse and radering
-- work. In an event they are kept for 30 days, the window in which the
-- webhooks retry and a receiver catches up through GET /api/events, and then
-- removed. What happened, when, on which record, by which user (as an id) and
-- with which amounts stays for good.
--
-- 1. public.event_data_without_personal_details(jsonb) is the one definition
--    of what stays. Walking every object and array:
--      - numbers, booleans and null;
--      - uuids (record and user ids) and ISO dates and timestamps, under any
--        key except a birth date;
--      - a code (no space, at most 64 characters) under a key whose values
--        are codes: statuses, types, sources, methods, currencies, VAT
--        treatment, voucher series, units, countries;
--      - a BAS account number (four digits) under an account key;
--      - keys of identifier shape (letters, digits, _ . : -).
--    Every other string becomes null: names, e-mail addresses, phone numbers,
--    addresses, personnummer and organisation numbers, references, file
--    names, descriptions and other free text. A key that is not of
--    identifier shape is dropped with its value. A new field is removed until
--    its key is listed here, never kept by default.
--
-- 2. personal_details_removed_at on event_log and event_outbox: when the
--    removal ran; NULL until then. Indexed, for the rows still to do, by
--    20261124000100 and 20261124000200 (built CONCURRENTLY).
--
-- 3. event_log stays append-only. event_log_no_update (audit_log_immutable)
--    refused every UPDATE; event_log_append_only allows exactly one: setting
--    personal_details_removed_at once, with every other column unchanged. The
--    trigger then writes data itself, as event_data_without_personal_details
--    of the stored data, so no caller can put anything else there. DELETE is
--    unchanged (a company's rows, agent telemetry past 180 days).
--
-- 4. remove_event_personal_details(p_limit) does one batch of both tables:
--    event_log business events (agent telemetry, mcp.* and agent.*, keeps
--    its own 180-day limit) and event_outbox rows older than 30 days. An
--    outbox row with a delivery still pending or claimed keeps its payload
--    until the delivery is done or dead: the consumer runs on the payload.
--    The 30 days are defined here, not by the caller. Service role only.
--
-- 5. The comments on event_outbox state what is kept.
--
-- pg-test: tests/pg/event-personal-details.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.event_log ADD COLUMN personal_details_removed_at timestamptz;
ALTER TABLE public.event_outbox ADD COLUMN personal_details_removed_at timestamptz;

-- 1. What stays of an event's data.
CREATE OR REPLACE FUNCTION public.event_data_without_personal_details(p_value jsonb, p_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
DECLARE
  v_text text;
  v_out jsonb;
BEGIN
  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      SELECT coalesce(jsonb_object_agg(e.key, public.event_data_without_personal_details(e.value, e.key)), '{}'::jsonb)
        INTO v_out
        FROM jsonb_each(p_value) AS e
       WHERE e.key ~ '^[A-Za-z0-9_.:-]{1,64}$';
      RETURN v_out;
    WHEN 'array' THEN
      -- An element is judged under the key of its array.
      SELECT coalesce(jsonb_agg(public.event_data_without_personal_details(e.value, p_key) ORDER BY e.n), '[]'::jsonb)
        INTO v_out
        FROM jsonb_array_elements(p_value) WITH ORDINALITY AS e(value, n);
      RETURN v_out;
    WHEN 'string' THEN
      v_text := p_value #>> '{}';
      IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR (v_text ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$'
             AND coalesce(p_key, '') !~* 'birth')
         OR (p_key = ANY ('{status,previous_status,previousStatus,new_status,newStatus,admission_state,
                            type,kind,document_type,documentKind,kind_hint,line_type,entity_type,customer_type,
                            supplier_type,deduction_type,payment_reference_type,committed_actor_type,
                            committed_auth_role,role,source,source_type,import_source,intake_source,upload_source,
                            created_via,createdVia,provider,trigger,method,commit_method,transaction_method,
                            reconciliation_method,potential_match_method,link_basis,channel,currency,
                            default_currency,vat_treatment,vatTreatment,moms_ruta,taxCode,tax_code,vat_code,
                            voucher_series,source_voucher_series,unit,category,language,country,legibility,
                            errorClass,error_code,errorCode}'::text[])
             AND v_text ~ '^[A-Za-z0-9_.:-]{1,64}$')
         OR (p_key = ANY ('{account,account_number,accountNumber,default_expense_account,
                            default_revenue_account,revenue_account,expense_account,settlement_account,
                            debit_account,credit_account,vat_account}'::text[])
             AND v_text ~ '^[0-9]{4}$')
      THEN
        RETURN p_value;
      END IF;
      RETURN 'null'::jsonb;
    ELSE
      RETURN p_value;
  END CASE;
END;
$$;

COMMENT ON FUNCTION public.event_data_without_personal_details(jsonb, text) IS
  'What stays of an event''s data after 30 days: numbers, booleans, ids, dates, codes under code keys and BAS accounts under account keys; every other string becomes null and a key not of identifier shape is dropped.';

REVOKE ALL ON FUNCTION public.event_data_without_personal_details(jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.event_data_without_personal_details(jsonb, text) TO service_role;

-- 3. event_log: append-only, apart from the removal.
CREATE OR REPLACE FUNCTION public.event_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.personal_details_removed_at IS NULL
     AND NEW.personal_details_removed_at IS NOT NULL
     AND (to_jsonb(NEW) - 'personal_details_removed_at') = (to_jsonb(OLD) - 'personal_details_removed_at')
  THEN
    NEW.data := public.event_data_without_personal_details(OLD.data);
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'event_log rows cannot be modified; the one change allowed is setting personal_details_removed_at'
    USING ERRCODE = 'check_violation';
END;
$$;

REVOKE ALL ON FUNCTION public.event_log_append_only() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS event_log_no_update ON public.event_log;

CREATE TRIGGER event_log_append_only
  BEFORE UPDATE ON public.event_log
  FOR EACH ROW EXECUTE FUNCTION public.event_log_append_only();

-- 4. One batch of the removal.
CREATE OR REPLACE FUNCTION public.remove_event_personal_details(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_before timestamptz := now() - interval '30 days';
  v_log integer;
  v_outbox integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 10000' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The trigger writes data (event_log_append_only).
  UPDATE public.event_log e
     SET personal_details_removed_at = now()
   WHERE e.sequence IN (
     SELECT x.sequence
       FROM public.event_log x
      WHERE x.personal_details_removed_at IS NULL
        AND x.event_type NOT LIKE 'mcp.%'
        AND x.event_type NOT LIKE 'agent.%'
        AND x.created_at < v_before
      ORDER BY x.created_at
      LIMIT p_limit
        FOR UPDATE SKIP LOCKED
   );
  GET DIAGNOSTICS v_log = ROW_COUNT;

  UPDATE public.event_outbox o
     SET payload = public.event_data_without_personal_details(o.payload),
         personal_details_removed_at = now()
   WHERE o.id IN (
     SELECT x.id
       FROM public.event_outbox x
      WHERE x.personal_details_removed_at IS NULL
        AND x.created_at < v_before
        AND NOT EXISTS (
          SELECT 1 FROM public.event_deliveries d
           WHERE d.outbox_id = x.id
             AND d.status IN ('pending', 'claimed')
        )
      ORDER BY x.created_at
      LIMIT p_limit
        FOR UPDATE SKIP LOCKED
   );
  GET DIAGNOSTICS v_outbox = ROW_COUNT;

  RETURN v_log + v_outbox;
END;
$$;

COMMENT ON FUNCTION public.remove_event_personal_details(integer) IS
  'One batch: up to p_limit event_log business events and p_limit event_outbox rows older than 30 days lose their personal details (event_data_without_personal_details). Returns the rows changed; 0 when none is left. Called by the events cleanup cron.';

REVOKE ALL ON FUNCTION public.remove_event_personal_details(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_event_personal_details(integer) TO service_role;

-- 5. What the comments say.
COMMENT ON TABLE public.event_outbox IS
  'Events with a consumer delivered from the outbox (event_deliveries). Service-role only; kept (rows go with their company); personal details leave the payload 30 days after the event; never exported.';
COMMENT ON COLUMN public.event_outbox.payload IS
  'The event payload as emitted (CoreEvent.payload), with personal data, until remove_event_personal_details replaces it with event_data_without_personal_details(payload), 30 days after the event.';
COMMENT ON COLUMN public.event_outbox.personal_details_removed_at IS
  'When remove_event_personal_details took the personal details out of payload; NULL until then.';
COMMENT ON COLUMN public.event_log.data IS
  'The event payload without userId and companyId, with personal data, until the event is 30 days old; then event_data_without_personal_details(data) (remove_event_personal_details). Agent telemetry keeps its own 180-day limit.';
COMMENT ON COLUMN public.event_log.personal_details_removed_at IS
  'When remove_event_personal_details took the personal details out of data; NULL until then. The one column an UPDATE may set (event_log_append_only).';

NOTIFY pgrst, 'reload schema';
