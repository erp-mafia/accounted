-- Register the behandlingshistorik event type for a verifikat booked past
-- acknowledged booking-time warnings (lib/bookkeeping/voucher-warnings-guard.ts).
--
-- processing_history.event_type has an FK to processing_event_types, and the
-- append is best-effort, so an unregistered type would lose the record
-- silently (see 20260901110000). The payload carries the warning codes and the
-- ids they pointed at, never texts.

INSERT INTO public.processing_event_types (event_type) VALUES
  ('VoucherWarningsAcknowledged')
ON CONFLICT (event_type) DO NOTHING;
