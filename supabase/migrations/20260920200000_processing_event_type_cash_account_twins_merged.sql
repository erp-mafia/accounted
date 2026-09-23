-- Register the behandlingshistorik event type emitted by
-- healTwinCashAccounts (lib/cash-accounts/heal-twins.ts), driven by
-- scripts/heal-twin-cash-accounts.ts.
--
-- Merging twin cash_accounts rows re-points bank_connections.accounts_data at
-- the kept ledger, which changes which BAS account future bank transactions
-- land on, and may delete the retired row. That is a change to processing that
-- BFNAR 2013:2 p. 9.16 requires in the change log. processing_history.event_type
-- has an FK to this catalog, so an unregistered type could not be written (see
-- lib/processing-history/append.ts and tests/pg/processing-event-types.pg.test.ts).

INSERT INTO public.processing_event_types (event_type)
VALUES ('CashAccountTwinsMerged')
ON CONFLICT (event_type) DO NOTHING;
