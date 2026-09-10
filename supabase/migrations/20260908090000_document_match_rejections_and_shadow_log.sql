-- Migration: document_match_rejections + match_shadow_log
--
-- Two tables for the underlag matcher that runs at arrival.
--
-- document_match_rejections: a pair (document, transaction) a human said no
-- to, from any surface. The receipt hunt already remembers rejections through
-- pending_operations; a manual "Avbryt matchning" in Underlag remembered
-- nothing, so the same wrong pairing could be proposed again. Append-only:
-- a "no" is a decision with a date, never edited.
--
-- match_shadow_log: every decision the matcher makes, whether it acted on it
-- or not, with the score components and, once known, what the human did.
-- This is how thresholds get set from measured precision instead of by hand,
-- and how a segment earns automation. Not audit-triggered: it is itself a
-- log and would double its own writes.

CREATE TABLE public.document_match_rejections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES public.document_attachments(id) ON DELETE CASCADE,
  transaction_id  uuid NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  source          text NOT NULL CHECK (source IN ('unmatch', 'proposal_rejected', 'picker')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, document_id, transaction_id)
);

ALTER TABLE public.document_match_rejections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company document_match_rejections"
  ON public.document_match_rejections FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company document_match_rejections"
  ON public.document_match_rejections FOR INSERT
  WITH CHECK (company_id IN (SELECT user_company_ids()));
-- No UPDATE or DELETE policy: a rejection is append-only.

CREATE INDEX idx_document_match_rejections_company_id
  ON public.document_match_rejections (company_id);
CREATE INDEX idx_document_match_rejections_transaction
  ON public.document_match_rejections (company_id, transaction_id);

CREATE TRIGGER audit_document_match_rejections
  AFTER INSERT OR UPDATE OR DELETE ON public.document_match_rejections
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TRIGGER document_match_rejections_no_update
  BEFORE UPDATE ON public.document_match_rejections
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_immutable();
CREATE TRIGGER document_match_rejections_no_delete
  BEFORE DELETE ON public.document_match_rejections
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_immutable();


CREATE TABLE public.match_shadow_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Who or what ran the matcher. Null for the cron and the bank-sync hook.
  user_id           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  run_id            text NOT NULL,
  trigger           text NOT NULL CHECK (trigger IN ('arrival', 'bank_sync', 'cron', 'manual')),
  inbox_item_id     uuid REFERENCES public.invoice_inbox_items(id) ON DELETE SET NULL,
  document_id       uuid REFERENCES public.document_attachments(id) ON DELETE SET NULL,
  transaction_id    uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  -- normalizeCounterpartyName of the transaction, the segment automation is earned on.
  counterparty_key  text,
  confidence        numeric,
  calibrated_p      numeric,
  components        jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision          text NOT NULL CHECK (decision IN ('link', 'propose', 'skip')),
  decided_by        text NOT NULL CHECK (decided_by IN ('matcher', 'adjudicator', 'veto', 'autonomy')),
  reason            text,
  -- false = the decision was only logged (shadow), true = it was carried out.
  acted             boolean NOT NULL DEFAULT false,
  -- Filled in later from what the human did with the same pair.
  human_outcome     text CHECK (human_outcome IN ('agree', 'disagree', 'rejected')),
  outcome_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.match_shadow_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company match_shadow_log"
  ON public.match_shadow_log FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company match_shadow_log"
  ON public.match_shadow_log FOR INSERT
  WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company match_shadow_log"
  ON public.match_shadow_log FOR UPDATE
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company match_shadow_log"
  ON public.match_shadow_log FOR DELETE
  USING (company_id IN (SELECT user_company_ids()));

CREATE INDEX idx_match_shadow_log_company_created
  ON public.match_shadow_log (company_id, created_at DESC);
CREATE INDEX idx_match_shadow_log_transaction
  ON public.match_shadow_log (transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX idx_match_shadow_log_inbox_item
  ON public.match_shadow_log (inbox_item_id) WHERE inbox_item_id IS NOT NULL;
CREATE INDEX idx_match_shadow_log_pending_outcome
  ON public.match_shadow_log (company_id) WHERE human_outcome IS NULL;

CREATE TRIGGER set_updated_at_match_shadow_log
  BEFORE UPDATE ON public.match_shadow_log
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
