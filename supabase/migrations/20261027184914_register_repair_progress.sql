-- crm#1436: progress of the one-off repair of imported customer and supplier
-- cards (lib/repair-imported-registers.ts).
-- pg-test: covered-by tests/pg/register-repair-progress.pg.test.ts
--
-- Older imports saved Fortnox customers and suppliers from the short list
-- (no type, active flag, VAT number, country or terms) and read Visma's and
-- Bokio's records under the wrong field names. The register-repair cron reads
-- every imported card's record again and writes what the import writes today,
-- only where the card is still empty or still holds the old import's value.
-- One row per company and provider: the cursor, the outcome, and every card
-- it changed with what the card held before, which is the whole revert (a
-- personnummer moved into personal_number is not copied here: it is read back
-- from the card). Dropped together with the cron.

CREATE TABLE public.register_repair_progress (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('fortnox', 'visma', 'bokio')),
  -- Where the next run starts (`<resource>:<source id>`); NULL before the first run.
  next_key text,
  -- NULL while the company still has cards to read; else why it is finished.
  outcome text CHECK (outcome IN ('done', 'no_consent', 'consent_expired', 'failed', 'stuck', 'archived', 'migration_reset')),
  attempts integer NOT NULL DEFAULT 0,
  -- Cards changed, by kind (filled, private, foreign, terms, currency, archived).
  counts jsonb NOT NULL DEFAULT '{}',
  -- One entry per changed card: {resource, id, kinds, filled: [columns], was: {column: value}}.
  changed jsonb NOT NULL DEFAULT '[]',
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, provider)
);

COMMENT ON TABLE public.register_repair_progress IS
  'crm#1436 one-off: per company and provider, the cursor and outcome of the imported-register repair cron, and the cards it changed.';

ALTER TABLE public.register_repair_progress ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.register_repair_progress TO service_role;
-- no-grant: authenticated on public.register_repair_progress (service-role only: written by the repair cron)
-- no-grant: anon on public.register_repair_progress (service-role only: written by the repair cron)

NOTIFY pgrst, 'reload schema';
