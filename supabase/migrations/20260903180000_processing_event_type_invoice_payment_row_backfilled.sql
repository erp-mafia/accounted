-- Register the behandlingshistorik event type emitted by
-- scripts/backfill-invoice-payment-rows.ts (#2019).
--
-- The backfill writes invoice_payments rows outside the normal settlement
-- flow, and those rows feed the kontantmetod bokslut cut-off, so the run is a
-- change to processing that BFL 5 kap 11 § / BFNAR 2013:2 p. 9.16 require in
-- the change log. processing_history.event_type has an FK to this catalog and
-- every append is best-effort, so an unregistered type would be lost silently
-- (see lib/processing-history/append.ts and
-- tests/pg/processing-event-types.pg.test.ts).

INSERT INTO public.processing_event_types (event_type)
VALUES ('InvoicePaymentRowBackfilled')
ON CONFLICT (event_type) DO NOTHING;
