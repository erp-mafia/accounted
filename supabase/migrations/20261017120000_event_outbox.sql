-- Event outbox, step E2: the tables, in shadow mode only.
--
-- Today every event consumer runs inline in the request that emits
-- (lib/events/bus.ts, Promise.allSettled). The outbox is where a consumer
-- will be delivered from instead, after the request, once it is flipped to
-- async (step E3, one consumer at a time, each with its idempotency key).
-- The design choices:
--   - a table of its own, not event_log: event_log is the public feed
--     (GET /api/events) and internal events stay out of it;
--   - a few seconds (the after() kick) up to one minute (the cron) of
--     latency is accepted for an async consumer;
--   - at-least-once: a rare duplicate after a crash is accepted.
--
-- event_outbox     one row per emitted event that has a consumer other than
--                  event-log (which stays inline and synchronous for good).
-- event_deliveries one row per (event, consumer): the unit that is claimed,
--                  leased, retried and finished.
--
-- A delivery's life (functions in 20261017120100):
--   pending  due when lease_until is NULL or past (lease_until doubles as
--            "not before" after a failure: the retry backoff)
--   claimed  leased until lease_until; an expired lease is claimed again
--   done     finished; never claimed again
--   dead     gave up (the attempts ran out); never claimed again
--
-- In E2 (EVENT_OUTBOX_MODE=shadow) every handler still runs inline exactly as
-- before; the bus also enqueues the event here after the handlers settled,
-- recording in inline_result what the same consumer did inline, and the
-- dispatcher (/api/events/dispatch/cron) marks claimed deliveries done
-- without running anything. Comparing the two per consumer, event type and
-- hour (event_outbox_shadow_counts) is the switch-on check for E3. With the
-- mode off (the default) nothing writes here.
--
-- Service role only: RLS on with no policy, nothing granted to anon or
-- authenticated. Payloads are raw event payloads and may hold personal data
-- (names, e-mail addresses, the acting user's id), so retention is short:
-- prune_event_outbox deletes finished events after 7 days and dead ones
-- after 30 (event_log keeps the same payloads for 30), and a company's rows
-- go with the company (ON DELETE CASCADE). Never exported in the archive.
--
-- pg-test: tests/pg/event-outbox.pg.test.ts, tests/pg/full-archive-coverage.pg.test.ts,
--          tests/pg/sandbox-teardown-coverage.pg.test.ts, tests/pg/account-erasure.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

CREATE TABLE public.event_outbox (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The company the event belongs to (its payload's companyId), when it has
  -- one that exists; enqueue_event stores NULL for any other value.
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  event_type text NOT NULL
    CHECK (event_type ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$' AND length(event_type) <= 100),
  payload    jsonb NOT NULL,
  -- A natural key for an event more than one writer can produce (the shape
  -- of event_log.dedupe_key): the second enqueue writes nothing.
  dedupe_key text UNIQUE CHECK (dedupe_key IS NULL OR length(dedupe_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.event_outbox IS
  'Events with a consumer delivered from the outbox (event_deliveries). Service-role only; raw payloads, pruned after 7 days (30 with a dead delivery); never exported.';
COMMENT ON COLUMN public.event_outbox.payload IS
  'The event payload as emitted (CoreEvent.payload). May hold personal data: retention is prune_event_outbox''s.';

-- prune_event_outbox walks by age; the cascade from companies by company.
CREATE INDEX event_outbox_created_at ON public.event_outbox (created_at);
CREATE INDEX event_outbox_company ON public.event_outbox (company_id) WHERE company_id IS NOT NULL;

CREATE TABLE public.event_deliveries (
  outbox_id     bigint NOT NULL REFERENCES public.event_outbox(id) ON DELETE CASCADE,
  -- EventConsumer.id (lib/events/consumers.ts): a core consumer, or ext:<extension id>.
  consumer_id   text NOT NULL
    CHECK (consumer_id ~ '^(ext:)?[a-z0-9_][a-z0-9_-]*$' AND length(consumer_id) <= 100),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'done', 'dead')),
  -- Claims so far; also the fencing token a finish call must present.
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- claimed: the lease runs out at this time. pending: not due before it
  -- (retry backoff), or due at once when NULL.
  lease_until   timestamptz,
  last_error    text CHECK (last_error IS NULL OR length(last_error) <= 1000),
  -- Shadow mode (E2) only: what the same consumer did inline in the emitting
  -- request. ok or failed: it ran (its promise settled that way);
  -- not_subscribed: the consumer index lists it but nothing on the bus ran it.
  -- NULL when the bus enqueued without running the consumer inline.
  inline_result text CHECK (inline_result IN ('ok', 'failed', 'not_subscribed')),
  done_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (outbox_id, consumer_id),
  CONSTRAINT event_deliveries_claimed_lease CHECK (status <> 'claimed' OR lease_until IS NOT NULL),
  CONSTRAINT event_deliveries_done_at CHECK ((status = 'done') = (done_at IS NOT NULL))
);

COMMENT ON TABLE public.event_deliveries IS
  'One delivery of an event_outbox row to one event consumer: pending, claimed (leased), done or dead. Service-role only.';
COMMENT ON COLUMN public.event_deliveries.inline_result IS
  'Shadow mode (EVENT_OUTBOX_MODE=shadow): what the same consumer did inline in the emitting request (ok, failed, not_subscribed). Compared with the deliveries by event_outbox_shadow_counts.';

-- The claim scans live deliveries only, oldest event first.
CREATE INDEX event_deliveries_live
  ON public.event_deliveries (outbox_id, consumer_id)
  WHERE status IN ('pending', 'claimed');

ALTER TABLE public.event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_deliveries ENABLE ROW LEVEL SECURITY;
-- No policies: service role only. The revokes keep anon and authenticated
-- out even if a policy is ever added by mistake.
REVOKE ALL ON TABLE public.event_outbox FROM anon, authenticated;
REVOKE ALL ON TABLE public.event_deliveries FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.event_outbox TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.event_deliveries TO service_role;
-- no-grant: authenticated on public.event_outbox (service-role only: raw internal event payloads, written and read by the server)
-- no-grant: anon on public.event_outbox (service-role only: raw internal event payloads, written and read by the server)
-- no-grant: authenticated on public.event_deliveries (service-role only: the outbox dispatcher's work queue)
-- no-grant: anon on public.event_deliveries (service-role only: the outbox dispatcher's work queue)

NOTIFY pgrst, 'reload schema';
