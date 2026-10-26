-- crm#1245: progress of the one-off Fortnox payment-terms backfill.
--
-- Customers and suppliers imported from Fortnox before !747/!874 all got
-- 30-day terms. The fortnox-terms-backfill cron reads each card's terms from
-- Fortnox and writes them where the card is still on 30. A company with tens
-- of thousands of cards takes many runs, so each company's cursor and outcome
-- live here, with the ids of the cards it changed: every one was on 30
-- before, so they are the whole revert. Dropped together with the cron.

CREATE TABLE public.fortnox_terms_backfill_progress (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Where the next run starts (`<resource>:<source id>`); NULL before the first run.
  next_key text,
  -- NULL while the company still has cards to read; else why it is finished.
  outcome text CHECK (outcome IN ('done', 'no_consent', 'consent_expired', 'failed', 'stuck', 'archived', 'migration_reset')),
  attempts integer NOT NULL DEFAULT 0,
  filled_customer_ids uuid[] NOT NULL DEFAULT '{}',
  filled_supplier_ids uuid[] NOT NULL DEFAULT '{}',
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.fortnox_terms_backfill_progress IS
  'crm#1245 one-off: per-company cursor and outcome of the Fortnox payment-terms backfill cron, and the cards it changed from 30.';

ALTER TABLE public.fortnox_terms_backfill_progress ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.fortnox_terms_backfill_progress TO service_role;
-- no-grant: authenticated on public.fortnox_terms_backfill_progress (service-role only: written by the backfill cron)
-- no-grant: anon on public.fortnox_terms_backfill_progress (service-role only: written by the backfill cron)

NOTIFY pgrst, 'reload schema';
