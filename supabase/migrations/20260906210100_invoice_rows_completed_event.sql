-- InvoiceRowsCompleted: the behandlingshistorik event for a migrated sales
-- invoice whose rows were written by complete_invoice_rows (migration
-- 20260906135730), from either of its writers: the migration wizard or the
-- hourly row-completion pass (#2291, #2312).
--
-- The pass inserts invoice_items and rewrites the header VAT split on
-- invoices whose stored split held no evidence. It writes no bokföringspost,
-- so BFL 5 kap 5 § (rättelse) does not bind it, but it is automated
-- processing of räkenskapsinformation, which BFL 5 kap 11 § and BFNAR 2013:2
-- p. 9.16 want in the behandlingshistorik: what was processed, when, and by
-- what. Until now the only trail was a log line per invoice in Vercel, and
-- the migration that wrote the invoices in the first place records no event
-- either.
--
-- One event per completed invoice, emitted by lib/invoices/complete-invoice-
-- rows.ts (the one TypeScript call site for the RPC, so a writer cannot reach
-- the RPC without the trail). Payload: the writer, the provider, the consent,
-- the row count, and the header split before and after when it was
-- rewritten. UUIDs, counts, amounts and enum strings only.
--
-- The aggregate is the invoice, which the aggregate_type CHECK did not admit
-- (no invoice-level event existed before). 'Invoice' is added the way
-- 20260423140500 added the AI streams; every value already in the constraint
-- stays. The catalog row goes in as for every other event type:
-- processing_history.event_type has an FK to it and the append is
-- best-effort, so an unregistered type would be lost silently
-- (lib/processing-history/append.ts, tests/pg/processing-event-types.pg.test.ts).
--
-- pg-test: tests/pg/invoice-rows-completed-event.pg.test.ts

ALTER TABLE public.processing_history
  DROP CONSTRAINT IF EXISTS processing_history_aggregate_type_check;

ALTER TABLE public.processing_history
  ADD CONSTRAINT processing_history_aggregate_type_check
  CHECK (aggregate_type IN (
    'Document',
    'BankTransaction',
    'MatchProposal',
    'Verifikation',
    'CounterpartyTemplate',
    'Period',
    'Migration',
    'System',
    'AIProposal',
    'AIRequest',
    'Invoice'
  ));

INSERT INTO public.processing_event_types (event_type)
VALUES ('InvoiceRowsCompleted')
ON CONFLICT (event_type) DO NOTHING;

NOTIFY pgrst, 'reload schema';
