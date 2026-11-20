-- A deleted inbox item can be put back (Senast borttagna).
--
-- Deleting an inbox item removes its row and keeps the document in the
-- archive. The decision row the delete already writes (kind 'inbox_item',
-- outcome 'dismissed') names the document, who decided and when, but not the
-- item itself, and the document cannot stand in for it: an e-invoice (Peppol)
-- or a billing invoice has its reading on the item alone, and the sender,
-- subject and mail text, the door it came through and the keys a redelivery
-- is recognised by live nowhere else. Usage counts the items a month holds
-- by created_at, so a re-created item would also be charged a second time.
--
--   * suggestion_log.removed_item: the item's row as it was deleted, written
--     in the same INSERT as the rest of the decision, so the table stays
--     append-only (suggestion_log_append_only is unchanged). Restoring
--     inserts that row again under its own id: the primary key lets it happen
--     once, and "restored" is read from the item existing, never stored.
--   * The copy lives as long as the decision does: it goes with its document
--     (ON DELETE CASCADE), so deleting the document from the archive removes
--     the kept item, its mail text included.
--   * The partial index is the list of deleted items, newest first, and how
--     a restore finds the copy.
--
-- No backfill: an item deleted before this migration left no copy and cannot
-- be put back. The code is live a few minutes before this runs: its write
-- retries without the column (PGRST204) and its reads answer "nothing
-- deleted" (42703).
-- pg-test: covered-by tests/pg/suggestion-log-removed-item.pg.test.ts

-- Never queue every write behind a long transaction: fail the migration job
-- instead and retry.
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.suggestion_log
  ADD COLUMN removed_item jsonb,
  -- Only the decision that deleted an inbox item carries one, and it is a row.
  ADD CONSTRAINT suggestion_log_removed_item CHECK (
    removed_item IS NULL
    OR (kind = 'inbox_item' AND outcome = 'dismissed' AND jsonb_typeof(removed_item) = 'object')
  );

COMMENT ON COLUMN public.suggestion_log.removed_item IS
  'On the decision that deleted an inbox item: the invoice_inbox_items row as it was, so the item can be put back under its own id (lib/operations/inbox-restore.ts). NULL on every other decision and on deletions recorded before 20261117192013.';

CREATE INDEX idx_suggestion_log_removed_items
  ON public.suggestion_log (company_id, created_at DESC)
  WHERE removed_item IS NOT NULL;

NOTIFY pgrst, 'reload schema';
