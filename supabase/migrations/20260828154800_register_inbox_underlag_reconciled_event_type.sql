-- Register the behandlingshistorik event written by the inbox-underlag
-- reconciliation pass (lib/transactions/inbox-underlag-reconcile.ts, run
-- daily from app/api/extensions/invoice-inbox/underlag-reconcile/cron and
-- manually from scripts/backfill-inbox-booked-underlag.ts): one event per
-- transaction whose matched inbox item's document this run linked to the
-- verifikat that booked it (#1548).
--
-- processing_history.event_type has an FK to processing_event_types, so an
-- unregistered type fails the insert. The append is best-effort by design
-- (the repair itself is done either way), which is exactly how the script's
-- previous 'InboxUnderlagBackfilled' type went unnoticed: it was never
-- registered, so every append it attempted failed. Registering here makes
-- the repair trail durable (BFNAR 2013:2 kap 8).
--
-- Catalog row only: aggregate_type 'BankTransaction' is already permitted by
-- the aggregate_type CHECK, so no constraint change is needed.

INSERT INTO public.processing_event_types (event_type) VALUES
  ('InboxUnderlagReconciled')
ON CONFLICT (event_type) DO NOTHING;

NOTIFY pgrst, 'reload schema';
