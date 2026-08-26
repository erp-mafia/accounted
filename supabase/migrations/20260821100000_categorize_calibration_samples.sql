-- Migration: categorize_calibration_samples — the measurement loop for the
-- auto-booking cascade's confidence (RIP-4 step 4).
--
-- The Tier-2 selector emits a raw combined confidence, but a raw score is not
-- calibrated until it is measured against reality. Every time a user books (or
-- edits) an AI proposal, we log one sample: the confidence the model reported
-- and whether the proposed account was the one actually booked. Fitting an
-- isotonic calibrator (lib/agent/categorize/calibration.ts) over these turns
-- "0.9" into a probability that really means 90%.
--
-- Append-only: a calibration corpus you can edit is a calibration corpus you
-- can lie to. No UPDATE/DELETE policy. Company-scoped for RLS + attribution;
-- the fit job reads across companies with the service role (the model's
-- calibration is a property of the model, not one tenant).

CREATE TABLE public.categorize_calibration_samples (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- The raw combined confidence the selector reported, in [0,1].
  confidence        numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  -- Self-consistency agreement fraction and the model's stated confidence,
  -- kept for later analysis of which signal calibrates best.
  agreement         numeric,
  model_confidence  text,

  -- Where the proposal came from ('counterparty_template' | 'mapping_rule' |
  -- 'history' | 'pattern' | 'category'), for per-source reliability.
  source            text,

  -- The label: proposed vs what was actually booked.
  proposed_account  text,
  booked_account    text NOT NULL,
  was_correct       boolean NOT NULL,

  -- The transaction's absolute amount, so the auto-book amount cap can be
  -- tuned against real outcomes.
  amount            numeric,

  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Fit job reads recent samples, newest first.
CREATE INDEX idx_calib_samples_company_created
  ON public.categorize_calibration_samples (company_id, created_at DESC);

ALTER TABLE public.categorize_calibration_samples ENABLE ROW LEVEL SECURITY;

CREATE POLICY "categorize_calibration_samples_select"
  ON public.categorize_calibration_samples
  FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "categorize_calibration_samples_insert"
  ON public.categorize_calibration_samples
  FOR INSERT
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

-- No UPDATE / DELETE policies: the corpus is append-only.

NOTIFY pgrst, 'reload schema';
