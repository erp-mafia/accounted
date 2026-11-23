-- The event outbox is kept: its comments stop stating a retention that no
-- longer holds.
--
-- From 2026-11-23 the events cleanup cron (/api/events/cleanup/cron) deletes
-- no business event from event_log and no row from the event outbox
-- (event_outbox, event_deliveries). Only agent telemetry (mcp.*, agent.*) is
-- still deleted, after 180 days. prune_event_outbox and prune_delivery_events
-- stay in the database and nothing calls them. A company's rows still go with
-- the company (ON DELETE CASCADE).
--
-- Comments only: no table, function, policy or constraint changes.
-- pg-test: skip (comments only)

SELECT set_config('lock_timeout', '5s', true);

COMMENT ON TABLE public.event_outbox IS
  'Events with a consumer delivered from the outbox (event_deliveries). Service-role only; raw payloads, kept (no job prunes them; they go with their company); never exported.';
COMMENT ON COLUMN public.event_outbox.payload IS
  'The event payload as emitted (CoreEvent.payload). May hold personal data: kept with the row, which goes with its company.';

NOTIFY pgrst, 'reload schema';
