-- Register the behandlingshistorik event type for bank rows set aside as
-- copies of another channel's rows of the same movements, after a ledger move
-- put both channels on one account (lib/transactions/channel-twins.ts,
-- crm#1701).
--
-- processing_history.event_type has an FK to processing_event_types, and the
-- append is best-effort, so an unregistered type would lose the record
-- silently (see 20260901110000). The payload carries the cash account id, the
-- reason, and the transaction ids set aside with the ids they duplicate,
-- never texts.

INSERT INTO public.processing_event_types (event_type) VALUES
  ('BankTransactionTwinsIgnored')
ON CONFLICT (event_type) DO NOTHING;
