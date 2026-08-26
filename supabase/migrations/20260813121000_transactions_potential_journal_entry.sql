-- Migration: persisted journal-entry match suggestions on transactions
--
-- The 4-pass bank matcher proposes matches in a 0.75-0.89 confidence band
-- (auto_fuzzy, auto_date_range) that unattended sweeps must never auto-apply.
-- Until now those proposals were computed and then dropped: the migrator who
-- imported a Fortnox SIE file and connected their bank never saw them. These
-- columns persist the band as reviewable suggestions, mirroring
-- potential_invoice_id / potential_supplier_invoice_id (one candidate per row).
--
-- Suggestions are soft data: nullable columns, no journal writes, fully
-- reversible. Confirming one goes through the ordinary manual-link path
-- (server-side revalidation at click time); rejecting clears the columns.

ALTER TABLE public.transactions
  ADD COLUMN potential_journal_entry_id UUID
    REFERENCES public.journal_entries (id) ON DELETE SET NULL,
  ADD COLUMN potential_match_method TEXT,
  ADD COLUMN potential_match_confidence NUMERIC(3,2);

-- A suggestion is all-or-nothing (id + method + confidence together), and a
-- transaction that is already linked to a journal entry carries no suggestion.
-- The BEFORE-UPDATE trigger below clears the trio whenever a link lands or the
-- row is ignored, so ordinary writers never trip this. ON DELETE SET NULL on
-- the FK nulls only the id; the trigger function also re-nulls method and
-- confidence on any write, and the CHECK is written to tolerate the transient
-- id-only-null state a FK SET NULL leaves behind (method/confidence dangling
-- without an id is inert for every reader, which keys on the id).
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_potential_je_check CHECK (
    potential_journal_entry_id IS NULL
    OR (
      potential_match_method IS NOT NULL
      AND potential_match_confidence IS NOT NULL
      AND journal_entry_id IS NULL
    )
  );

-- The review surface asks "does this company have suggestions?" and lists them;
-- suggestion rows are a small fraction of transactions.
CREATE INDEX idx_transactions_potential_je
  ON public.transactions (company_id)
  WHERE potential_journal_entry_id IS NOT NULL;

-- ============================================================
-- Suggestion invalidation, transaction side
-- ============================================================
-- Clear the suggestion whenever the transaction stops being an open row:
-- booked or linked (journal_entry_id set, by ANY path: categorization,
-- reconciliation, MCP, RPCs) or explicitly ignored. BEFORE trigger so the
-- cleared values land in the same write and the CHECK above always sees a
-- consistent row.

CREATE OR REPLACE FUNCTION public.clear_potential_journal_entry_on_close()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.journal_entry_id IS NOT NULL OR NEW.is_ignored IS TRUE THEN
    NEW.potential_journal_entry_id := NULL;
    NEW.potential_match_method := NULL;
    NEW.potential_match_confidence := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER transactions_clear_potential_je
  BEFORE INSERT OR UPDATE ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.clear_potential_journal_entry_on_close();

-- ============================================================
-- Suggestion invalidation, journal-entry side
-- ============================================================
-- (a) The suggested entry is consumed by another transaction's link: other
--     rows still suggesting it would double-consume the verifikat on bulk
--     confirm, so their suggestions are cleared as soon as any link lands.
--     SECURITY DEFINER: the writer linking their own transaction may not have
--     UPDATE visibility over sibling rows under RLS, but the scope is derived
--     entirely from the row being written (company_id + journal_entry_id),
--     never from caller input.

CREATE OR REPLACE FUNCTION public.clear_sibling_je_suggestions_on_link()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.transactions
  SET potential_journal_entry_id = NULL,
      potential_match_method = NULL,
      potential_match_confidence = NULL
  WHERE company_id = NEW.company_id
    AND potential_journal_entry_id = NEW.journal_entry_id
    AND id <> NEW.id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER transactions_clear_sibling_je_suggestions
  AFTER UPDATE OF journal_entry_id ON public.transactions
  FOR EACH ROW
  WHEN (NEW.journal_entry_id IS NOT NULL
        AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id)
  EXECUTE FUNCTION public.clear_sibling_je_suggestions_on_link();

-- (b) The suggested entry is reversed via storno: it is no longer a live
--     verifikat to settle against, so pending suggestions pointing at it are
--     stale. Same SECURITY DEFINER rationale as above.

CREATE OR REPLACE FUNCTION public.clear_je_suggestions_on_reversal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.transactions
  SET potential_journal_entry_id = NULL,
      potential_match_method = NULL,
      potential_match_confidence = NULL
  WHERE company_id = NEW.company_id
    AND potential_journal_entry_id = NEW.id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER journal_entries_clear_je_suggestions_on_reversal
  AFTER UPDATE OF status ON public.journal_entries
  FOR EACH ROW
  WHEN (NEW.status = 'reversed' AND OLD.status IS DISTINCT FROM 'reversed')
  EXECUTE FUNCTION public.clear_je_suggestions_on_reversal();

-- ============================================================
-- Sweep summaries
-- ============================================================
-- One JSONB per surface so the UI can render "Vi matchade X av Y" without
-- recomputing: {auto_linked, suggested, unmatched, date_from, date_to, ran_at}.

ALTER TABLE public.bank_connections
  ADD COLUMN last_sie_sweep JSONB;

ALTER TABLE public.bank_file_imports
  ADD COLUMN sie_sweep JSONB;

NOTIFY pgrst, 'reload schema';
