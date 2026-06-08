-- Migration: stream invoice_inbox_items changes via Supabase realtime
--
-- The dokumentinkorg (InvoiceInboxWorkspace) only refetched on mount and on
-- explicit in-component actions. When an inbox item was resolved "out of
-- band" — the in-app agent sheet committing a staged
-- create_supplier_invoice_from_inbox / book-direct operation, the /pending
-- approval page committing one, or another browser tab booking it — none of
-- those paths call the component's fetchItems(). The booked underlag stayed
-- in "Att göra" until the user manually reloaded the page (issue #600).
-- Adding the table to supabase_realtime lets the browser subscribe via
-- supabase.channel('postgres_changes') and refresh as the
-- created_supplier_invoice_id / created_journal_entry_id FKs land.
--
-- This mirrors 20260520120100_pending_ops_realtime_publication.sql, which
-- fixed the identical staleness on the /pending page.
--
-- RLS already restricts invoice_inbox_items to company members
-- (20260223150836_invoice_inbox.sql, refreshed by the multi-tenant refactor
-- in 20260330130000), and realtime respects the same row-level access — a
-- member of company A only receives change events for rows where their RLS
-- predicate evaluates true. Default replica identity (primary key) is
-- sufficient: the client only refetches, never inspecting the old/new record.

-- Idempotent: ALTER PUBLICATION ... ADD TABLE errors if the table is already a
-- member (SQLSTATE 42710). Guard so a re-apply is a no-op — e.g. a Supabase
-- preview branch that partially applied an earlier revision of this migration
-- (the ALTER ran, but the schema_migrations bookkeeping insert failed), leaving
-- the table already in the publication on the next attempt.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'invoice_inbox_items'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.invoice_inbox_items;
  END IF;
END $$;
