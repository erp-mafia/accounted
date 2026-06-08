-- Editable bank-transaction titles: preserve the original bank/PSD2 name.
--
-- The transactions.description column is a mutable working label on the
-- staging/inbox row. It is NOT räkenskapsinformation until the row is booked
-- into a verifikat (journal_entry_id IS NOT NULL); BFL immutability (5 kap 5§)
-- and the storno-only rule attach to the verifikat, not to pre-accounting
-- staging data. We are about to let users edit that label *before* booking.
--
-- Two reasons to keep the bank's original text (normalized once at ingest) in a
-- separate, immutable column (never written by the edit endpoint):
--   1. Recoverability + provenance — an accidental edit is always reversible,
--      and the bank original stays auditable as the basis for "vad
--      affärshändelsen avser" once booked (BFL 5 kap 7§ / god redovisningssed).
--      The raw PSD2 JSON is already archived as a document, so this column is
--      defence-in-depth, not the sole record.
--   2. Dedup safety — contentDedupKey() in lib/transactions/external-id.ts
--      bridges re-imports across sources (PSD2 re-sync ⇄ CSV overlap) using a
--      description prefix. If that bridge read the user-editable description, an
--      edited title could let a genuine re-import slip past as a duplicate.
--      Ingest now keys the bridge off original_description, which never drifts.
--
-- The edit gate (only unbooked + unmatched rows are editable) is enforced in
-- application code (app/api/transactions/[id] PATCH). transactions carry no
-- description-immutability DB trigger today and none is added here; the
-- editable predicate (journal_entry_id IS NULL AND invoice_id IS NULL AND
-- supplier_invoice_id IS NULL) already excludes every booked/matched row.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS original_description text,
  ADD COLUMN IF NOT EXISTS title_edited_at timestamptz;

COMMENT ON COLUMN public.transactions.original_description IS
  'Bank/PSD2-provided description captured at ingest, normalized (empty/whitespace and the legacy "Unknown" sentinel map to the Swedish neutral "Okänd transaktion"). Never overwritten by user title edits; used as the dedup-bridge source and as the "restore original" value.';
COMMENT ON COLUMN public.transactions.title_edited_at IS
  'Set when a user overrides the transaction title (description). NULL = title is still the bank original. Drives the "redigerad" tag and the restore affordance.';

-- Backfill: before this feature shipped, description always held the bank
-- original (every ingest path defaulted it from the source text), so the
-- current description IS the original for every legacy row. This gives each
-- existing row a recoverable original and means the dedup bridge's
-- `original_description ?? description` fallback is only ever exercised by rows
-- created in the brief window before this migration runs.
UPDATE public.transactions
  SET original_description = description
  WHERE original_description IS NULL;

NOTIFY pgrst, 'reload schema';
