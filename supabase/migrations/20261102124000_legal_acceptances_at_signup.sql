-- legal_acceptances: also written at signup.
--
-- The register page says that creating an account accepts the terms and the
-- DPA. Until now nothing recorded that: the only writer was the acceptance
-- prompt, which is switched off (LegalAcceptanceGate PROMPT_ENABLED = false,
-- founder decision 2026-10-22). POST /api/auth/signup and the BankID signup
-- completion now write one row per accepted document at its current version
-- (src/lib/legal/documents.ts) with method 'signup', company_id NULL, through
-- the service role: the new person has no session before the confirmation
-- mail is clicked.
--
-- Only the method CHECK changes. The table stays append-only, the grants and
-- policies are untouched, and nothing here touches the bookkeeping.
--
-- pg-test: tests/pg/legal-acceptances-and-data-choices.pg.test.ts

ALTER TABLE public.legal_acceptances DROP CONSTRAINT legal_acceptances_method_check;
ALTER TABLE public.legal_acceptances ADD CONSTRAINT legal_acceptances_method_check
  CHECK (method IN ('accept_all', 'accept_documents', 'signup'));

COMMENT ON TABLE public.legal_acceptances IS
  'Append-only: who accepted which legal document version, when, and how (method). Written by POST /api/legal/accept (the acceptance prompt) and at signup (method signup).';
