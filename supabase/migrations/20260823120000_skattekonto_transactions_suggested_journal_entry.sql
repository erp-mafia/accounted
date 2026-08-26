-- Migration: skattekonto_transactions.suggested_journal_entry_id
--
-- Reconciliation proposals for the skattekonto (1630). Until now the "Möjlig
-- dubblett av A 214" hint was recomputed on every page load by
-- findMatchSuggestionsBulk and lived nowhere, so nothing outside the
-- /skattekonto request (worklist counts, the reconciliation summary, agents)
-- could know that a row already has an exact twin in the ledger. Measured on
-- prod 2026-08-20: 757 of 2 397 "open" rows had an exact-amount 1630 line
-- within +-7 days, i.e. the work was already done through another door.
--
-- The sync writes the single best candidate here (one-to-one across rows,
-- AGI period first, then nearest date) and clears it when the row is linked
-- or the candidate stops qualifying. It is a PROPOSAL, never a link:
-- journal_entry_id is the only link, and only a click (or an approved staged
-- operation) moves a proposal into it. Propose-only by design; see
-- DECISIONS.md 2026-08-23.
--
-- ON DELETE SET NULL mirrors journal_entry_id: a deleted draft must not leave
-- a dangling pointer. A proposal is meaningless on a linked row, so the
-- partial index only covers unlinked rows: that is the worklist predicate
-- "rows with a twin" and the count the reconciliation summary reads.
--
-- RLS: the company-scoped SELECT/UPDATE policies on skattekonto_transactions
-- already cover these columns; no policy change.

ALTER TABLE public.skattekonto_transactions
  ADD COLUMN IF NOT EXISTS suggested_journal_entry_id UUID
    REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS suggested_at TIMESTAMPTZ;

COMMENT ON COLUMN public.skattekonto_transactions.suggested_journal_entry_id IS
  'Best exact-twin verifikat proposed by the sync (one-to-one across rows). A proposal, never a link: journal_entry_id is the link.';
COMMENT ON COLUMN public.skattekonto_transactions.suggested_at IS
  'When suggested_journal_entry_id was last written by the sync.';

CREATE INDEX IF NOT EXISTS idx_skattekonto_transactions_suggested_open
  ON public.skattekonto_transactions (company_id)
  WHERE suggested_journal_entry_id IS NOT NULL AND journal_entry_id IS NULL;
