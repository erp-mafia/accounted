-- Register every behandlingshistorik event type the code emits but the
-- catalog is missing (10 of the 18 emitted types).
--
-- processing_history.event_type has an FK to processing_event_types, so an
-- unregistered type fails the insert with 23503, and every appendProcessingHistory
-- call site is best-effort try/catch: the failure is swallowed and the act
-- leaves NO durable record at all. The catalog has been drifting behind the
-- code since the v0.2 seed, and each previous repair (20260626120000,
-- 20260721103000, 20260813033506, 20260828154800) registered only the one type
-- that happened to surface in the production logs, which is why ten were still
-- unwritable. This one backfills the whole emitted set, and
-- lib/processing-history/append.ts now carries the same list as a TypeScript
-- union so a new literal is a compile error until a migration registers it
-- (tests/pg/processing-event-types.pg.test.ts asserts the two stay in sync).
--
-- What was being lost, per BFNAR 2013:2 kap 9 p. 9.16 (behandlingshistorik:
-- the record of how the bookkeeping material was processed):
--   TransactionDocumentReplaced      the BFL 5 kap 5 § rättelse record when a
--                                    transaction's underlag is swapped
--   OAuthClientRevoked               revocation evidence for a connected client
--   PendingOperationRejected         the MCP agent rejection trail (its sibling
--                                    PendingOperationApproved was registered in
--                                    20260721103000; this one was left behind)
--   DocumentExtractionOverridden     provenance for an agent-supplied field
--   DocumentExtractionRetried        re-extraction of an already-ingested doc
--   DocumentDuplicateSkipped         an ingest that adopted an existing item
--   InvoiceDuplicatePaymentDismissed a dismissed double-payment warning
--   InvoiceJournalEntrySkipped       a commit that wrote no verifikat
--   RateLimitedDropped               inbound mail/WhatsApp dropped on the cap
--   AttachmentsTruncated             inbound mail truncated on the 20-file cap
--
-- The events lost so far are unrecoverable: there is no source to reconstruct
-- an append that failed months ago, so there is no backfill of rows to write,
-- only of catalog entries.
--
-- Catalog rows only: every emitter's aggregate_type ('BankTransaction',
-- 'Document', 'System') is already permitted by the aggregate_type CHECK, so
-- no constraint change is needed.
--
-- RateLimitedDropped has TWO emitters and this row switches on both: the
-- inbound-mail one in extensions/general/invoice-inbox/index.ts (payload
-- stripped in this commit, see below) and the WhatsApp intake in
-- extensions/general/whatsapp-inbox/lib/process-inbound.ts, whose payload is
-- counts plus the inbox row id and was left as it is.
--
-- Ordering note: this migration must not reach production ahead of the deploy
-- that strips `from` and `subject` from the RateLimitedDropped and
-- AttachmentsTruncated payloads (extensions/general/invoice-inbox/index.ts).
-- Registering those two types is what switches their inserts on, and the old
-- payloads carried the sender address and the mail subject into an append-only
-- table whose UPDATE is trigger-blocked. Both changes ship in this one commit.

INSERT INTO public.processing_event_types (event_type) VALUES
  ('AttachmentsTruncated'),
  ('DocumentDuplicateSkipped'),
  ('DocumentExtractionOverridden'),
  ('DocumentExtractionRetried'),
  ('InvoiceDuplicatePaymentDismissed'),
  ('InvoiceJournalEntrySkipped'),
  ('OAuthClientRevoked'),
  ('PendingOperationRejected'),
  ('RateLimitedDropped'),
  ('TransactionDocumentReplaced')
ON CONFLICT (event_type) DO NOTHING;

NOTIFY pgrst, 'reload schema';
