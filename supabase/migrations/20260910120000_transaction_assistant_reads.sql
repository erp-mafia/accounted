-- Migration: transaction_assistant_reads: the assistant's read of one
-- unbooked transaction, kept so the review opens with it instead of
-- fetching it while the person waits.
--
-- One row per transaction (UNIQUE on transaction_id), rewritten when the
-- underlag changes: underlag_key is the transaction's document_id at read
-- time, so a receipt matched later makes the row stale and the next pass
-- reads again. Written by the categorize route as the member and by the
-- ten-minute cron as the service role; read by the suggestions route for
-- the row chip and the review header.
--
-- A derived cache, not a business record: no audit trigger, and the row
-- dies with its transaction.

CREATE TABLE public.transaction_assistant_reads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  transaction_id   uuid NOT NULL UNIQUE REFERENCES public.transactions(id) ON DELETE CASCADE,

  -- The transaction's document_id when the read was made; null = no underlag.
  underlag_key     text,
  has_underlag     boolean NOT NULL DEFAULT false,

  -- The pick: null account = nothing fits (needs a person).
  account          text,
  category         text,
  vat_treatment    text,
  reverse_charge   boolean NOT NULL DEFAULT false,
  confidence       numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  model_confidence text,
  agreement        numeric,
  from_candidate   boolean NOT NULL DEFAULT false,
  reasoning        text NOT NULL DEFAULT '',
  candidates       jsonb NOT NULL DEFAULT '[]'::jsonb,
  model            text,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_transaction_assistant_reads_company
  ON public.transaction_assistant_reads (company_id, updated_at DESC);

ALTER TABLE public.transaction_assistant_reads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company transaction_assistant_reads"
  ON public.transaction_assistant_reads FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "insert own-company transaction_assistant_reads"
  ON public.transaction_assistant_reads FOR INSERT
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "update own-company transaction_assistant_reads"
  ON public.transaction_assistant_reads FOR UPDATE
  USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "delete own-company transaction_assistant_reads"
  ON public.transaction_assistant_reads FOR DELETE
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER set_updated_at_transaction_assistant_reads
  BEFORE UPDATE ON public.transaction_assistant_reads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
