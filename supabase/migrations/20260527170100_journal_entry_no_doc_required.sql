-- =============================================================================
-- journal_entry_no_doc_required — sidecar metadata for the "Saknade underlag"
-- list.
--
-- Some posted entries legitimately don't have a separate kvitto:
--   * Bankavgifter (auto-debited fees)
--   * Räntor (bank interest charges/credits)
--   * Interna överföringar mellan egna konton
--   * Skatteinbetalningar till Skatteverket
--   * Lönebetalningar (the verifikation IS the underlag)
--
-- We can't add a column on journal_entries because the
-- enforce_journal_entry_immutability trigger (migration 17) blocks UPDATE on
-- posted rows. Sidecar table keeps the verifikation untouched while letting
-- the bookkeeper record "no underlag needed" as auditable metadata.
--
-- Toggleable (no immutability trigger) so users can undo a mis-flag. The
-- created_by / created_at columns provide the audit trail; the audit_log
-- trigger captures DELETEs.
-- =============================================================================

CREATE TABLE public.journal_entry_no_doc_required (
  journal_entry_id uuid PRIMARY KEY REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reason           text CHECK (reason IS NULL OR char_length(reason) <= 200),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_jenodoc_company ON public.journal_entry_no_doc_required(company_id);

ALTER TABLE public.journal_entry_no_doc_required ENABLE ROW LEVEL SECURITY;

-- SELECT: any company member can see exemptions in their companies
CREATE POLICY "jenodoc_select" ON public.journal_entry_no_doc_required
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

-- INSERT/UPDATE/DELETE: gated on membership only — viewer guard is enforced
-- application-side via requireWritePermission() in the API route. This matches
-- the booking_template_library and similar tables.
CREATE POLICY "jenodoc_insert" ON public.journal_entry_no_doc_required
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "jenodoc_update" ON public.journal_entry_no_doc_required
  FOR UPDATE
  USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "jenodoc_delete" ON public.journal_entry_no_doc_required
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.journal_entry_no_doc_required
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
