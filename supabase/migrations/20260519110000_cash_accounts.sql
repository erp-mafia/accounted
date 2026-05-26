-- Migration: cash_accounts — first-class entity for routable cash accounts
--
-- Why this exists: bank_connections.accounts_data is a JSONB array storing
-- PSD2 accounts plus their BAS ledger account mapping. That shape is fine for
-- ingest but doesn't support:
--   - per-account reconciliation (today's get_unlinked_1930_lines hardcodes 1930)
--   - a stable foreign key from transactions to "the account that produced this row"
--   - cash-on-hand / Stripe-clearing / BG-PG entries that aren't backed by PSD2
--   - a primary-SEK designation so the skattekonto guesser stops hardcoding 1930
--
-- cash_accounts promotes the routing primitive to its own table. JSONB
-- accounts_data remains the source for PSD2 sync metadata + UI display in this
-- PR; cash_accounts is the canonical source for routing decisions. A follow-up
-- migration after 30 days of stable operation will drop accounts_data.
--
-- Unique constraint is (company_id, ledger_account) per user decision. This
-- enforces today's "one currency per BAS account" assumption (1930=SEK,
-- 1932=EUR, 1933=USD, 1934=GBP). If a future Wise/Revolut multi-currency wallet
-- customer appears, a follow-up migration would split the constraint to add
-- currency as a third key column.
--
-- Partial unique index on (company_id) WHERE is_primary = true gives us
-- at most one primary per company — used by skattekonto-booking's
-- __PRIMARY_SEK__ sentinel resolver and by future multi-currency wallets.

CREATE TABLE public.cash_accounts (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id            UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- bank_connection FK is nullable so manual / cash-on-hand / SIE-imported
  -- accounts can live without a PSD2 connection.
  bank_connection_id    UUID REFERENCES public.bank_connections(id) ON DELETE SET NULL,
  external_uid          TEXT,                                -- PSD2 StoredAccount.uid
  iban                  TEXT,
  bg_pg                 TEXT,                                -- Bankgiro / Plusgiro
  name                  TEXT,
  currency              TEXT NOT NULL CHECK (length(currency) = 3),
  -- BAS account number (string, not int — '1930' not 1930).
  ledger_account        TEXT NOT NULL CHECK (length(ledger_account) >= 4),
  balance               NUMERIC,
  balance_updated_at    TIMESTAMPTZ,
  enabled               BOOLEAN NOT NULL DEFAULT true,
  is_primary            BOOLEAN NOT NULL DEFAULT false,
  source                TEXT NOT NULL DEFAULT 'enable_banking'
                        CHECK (source IN ('enable_banking', 'manual', 'sie_import')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, ledger_account),
  -- For PSD2-backed accounts, (bank_connection_id, external_uid) uniquely
  -- identifies the account inside that connection — guards against duplicate
  -- upserts during sync.
  UNIQUE (company_id, bank_connection_id, external_uid)
);

CREATE INDEX idx_cash_accounts_company ON public.cash_accounts (company_id);
CREATE INDEX idx_cash_accounts_iban
  ON public.cash_accounts (company_id, iban)
  WHERE iban IS NOT NULL;

-- At most one primary per company. Partial unique index — the standard pattern
-- for "exactly one true row per group" (mirrors sie_imports active_partial_unique).
CREATE UNIQUE INDEX idx_cash_accounts_one_primary_per_company
  ON public.cash_accounts (company_id)
  WHERE is_primary = true;

ALTER TABLE public.cash_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cash_accounts_select" ON public.cash_accounts
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "cash_accounts_insert" ON public.cash_accounts
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "cash_accounts_update" ON public.cash_accounts
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "cash_accounts_delete" ON public.cash_accounts
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER cash_accounts_updated_at
  BEFORE UPDATE ON public.cash_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- Backfill from bank_connections.accounts_data
-- ============================================================
--
-- For each enabled StoredAccount in accounts_data, insert a cash_accounts row.
-- Currency defaults to SEK; ledger_account defaults to 1930. ON CONFLICT DO
-- NOTHING means re-running the migration is safe — and the (company_id,
-- ledger_account) conflict naturally collapses duplicates that share a BAS code
-- (older data sometimes had two SEK accounts both pointing to 1930; we keep
-- the first one and the user can re-map later via the AccountPicker).

INSERT INTO public.cash_accounts (
  company_id, bank_connection_id, external_uid, iban, name,
  currency, ledger_account, balance, balance_updated_at, enabled, source
)
SELECT
  bc.company_id,
  bc.id,
  elem->>'uid',
  elem->>'iban',
  elem->>'name',
  COALESCE(UPPER(elem->>'currency'), 'SEK'),
  COALESCE(elem->>'ledger_account', '1930'),
  NULLIF(elem->>'balance', '')::NUMERIC,
  NULLIF(elem->>'balance_updated_at', '')::TIMESTAMPTZ,
  COALESCE((elem->>'enabled')::BOOLEAN, true),
  'enable_banking'
FROM public.bank_connections bc,
     LATERAL jsonb_array_elements(COALESCE(bc.accounts_data, '[]'::jsonb)) AS elem
WHERE bc.company_id IS NOT NULL
  AND elem->>'uid' IS NOT NULL
ON CONFLICT (company_id, ledger_account) DO NOTHING;

-- First SEK row per company becomes primary. Falls back to the oldest cash
-- account of any currency if no SEK row exists. The skattekonto resolver and
-- transfer-pairing will use this row when the __PRIMARY_SEK__ sentinel is hit.
WITH first_sek AS (
  SELECT DISTINCT ON (company_id) id
  FROM public.cash_accounts
  WHERE currency = 'SEK'
  ORDER BY company_id, created_at, id
)
UPDATE public.cash_accounts ca
SET is_primary = true
WHERE ca.id IN (SELECT id FROM first_sek);

-- Companies with no SEK account: pick any account as primary so the sentinel
-- always resolves. Edge case (manual cash-on-hand only, etc.).
WITH primary_missing AS (
  SELECT c.id AS company_id
  FROM public.companies c
  WHERE NOT EXISTS (
    SELECT 1 FROM public.cash_accounts ca
    WHERE ca.company_id = c.id AND ca.is_primary = true
  )
  AND EXISTS (
    SELECT 1 FROM public.cash_accounts ca
    WHERE ca.company_id = c.id
  )
), first_any AS (
  SELECT DISTINCT ON (ca.company_id) ca.id
  FROM public.cash_accounts ca
  JOIN primary_missing pm ON pm.company_id = ca.company_id
  ORDER BY ca.company_id, ca.created_at, ca.id
)
UPDATE public.cash_accounts ca
SET is_primary = true
WHERE ca.id IN (SELECT id FROM first_any);

NOTIFY pgrst, 'reload schema';
