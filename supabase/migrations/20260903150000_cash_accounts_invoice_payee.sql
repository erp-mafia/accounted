-- Named invoice payee accounts.
--
-- Until now a company had exactly one set of payment instructions per invoice
-- currency (company_settings.invoice_payment_accounts, keyed SEK/EUR/...), and
-- the invoice picked them by currency alone. A company with two SEK bank
-- accounts, or two bankgiro numbers, had nowhere to put the second one.
--
-- cash_accounts is already the per-company bank-account entity (name, IBAN,
-- currency, ledger account, primary flag). This migration makes it the single
-- source for what a customer pays to:
--
--   1. Payee columns on cash_accounts (bankgiro, plusgiro, clearing + account,
--      BIC, Swish, foreign routing) plus invoice_payee: "may be printed on an
--      invoice". bg_pg (one text for both giro kinds) was never read or
--      written anywhere and is dropped; verified NULL on every prod and
--      staging row on 2026-09-03.
--   2. invoice_payee_defaults: which cash account an invoice in a given
--      currency prints when the invoice itself does not choose. One account
--      may be the default for several currencies: a SEK account with an IBAN
--      is the normal EUR payee, so "default for EUR must be an EUR account"
--      would be wrong.
--   3. A mirror: whenever a default account or its payee fields change, the
--      old company_settings.invoice_payment_accounts map and the legacy SEK
--      columns are rewritten from it. Every existing reader (PDF, email,
--      reminders, Peppol, v1 settings, MCP) keeps working unchanged, and the
--      three writers that only touched the legacy columns can no longer
--      drift from what the PDF prints.
--   4. Backfill from today's map onto existing cash accounts. No rows are
--      created: a currency entry with no matching account stays in the map
--      as the fallback the resolver already honours.
--
-- The mirror runs SECURITY DEFINER because company_settings updates are
-- admin-gated by RLS while cash_accounts writes are member-level (bank sync
-- touches them). It trusts nothing from the session: it only re-derives the
-- map from rows the caller was already allowed to write.

-- ============================================================
-- 1. Payee columns
-- ============================================================

ALTER TABLE public.cash_accounts
  ADD COLUMN IF NOT EXISTS bank_name              text,
  ADD COLUMN IF NOT EXISTS clearing_number        text,
  ADD COLUMN IF NOT EXISTS account_number         text,
  -- Raw BBAN as the ASPSP sent it (Swedish: clearing + account, no separator).
  ADD COLUMN IF NOT EXISTS bban                   text,
  ADD COLUMN IF NOT EXISTS bankgiro               text,
  ADD COLUMN IF NOT EXISTS plusgiro               text,
  ADD COLUMN IF NOT EXISTS swish                  text,
  ADD COLUMN IF NOT EXISTS bic                    text,
  ADD COLUMN IF NOT EXISTS bank_code              text,
  ADD COLUMN IF NOT EXISTS foreign_account_number text,
  ADD COLUMN IF NOT EXISTS invoice_payee          boolean NOT NULL DEFAULT false;

ALTER TABLE public.cash_accounts DROP COLUMN IF EXISTS bg_pg;

COMMENT ON COLUMN public.cash_accounts.invoice_payee IS
  'True when this account may be printed as the payee on customer invoices. Only owner/admin may change payee fields.';
COMMENT ON COLUMN public.cash_accounts.bban IS
  'Raw BBAN from the bank connection (Swedish: clearing number followed by account number). Prefill only; clearing_number/account_number are what prints.';

-- (id, company_id) target so child tables can prove same-company membership
-- with one composite FK (same pattern as parties in 20260902160000).
ALTER TABLE public.cash_accounts
  ADD CONSTRAINT cash_accounts_id_company_unique UNIQUE (id, company_id);

-- ============================================================
-- 2. Per-currency defaults
-- ============================================================

CREATE TABLE public.invoice_payee_defaults (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  currency        text NOT NULL CHECK (currency IN ('SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK')),
  cash_account_id uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, currency),
  CONSTRAINT invoice_payee_defaults_same_company
    FOREIGN KEY (cash_account_id, company_id)
    REFERENCES public.cash_accounts(id, company_id) ON DELETE CASCADE
);

CREATE INDEX idx_invoice_payee_defaults_cash_account
  ON public.invoice_payee_defaults (cash_account_id);

ALTER TABLE public.invoice_payee_defaults ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invoice_payee_defaults_select" ON public.invoice_payee_defaults
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "invoice_payee_defaults_insert" ON public.invoice_payee_defaults
  FOR INSERT WITH CHECK (public.user_is_company_admin(company_id));
CREATE POLICY "invoice_payee_defaults_update" ON public.invoice_payee_defaults
  FOR UPDATE
  USING (public.user_is_company_admin(company_id))
  WITH CHECK (public.user_is_company_admin(company_id));
CREATE POLICY "invoice_payee_defaults_delete" ON public.invoice_payee_defaults
  FOR DELETE USING (public.user_is_company_admin(company_id));

CREATE TRIGGER invoice_payee_defaults_updated_at
  BEFORE UPDATE ON public.invoice_payee_defaults
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Behandlingshistorik: which account customer invoices pay to is a
-- behandlingsregel (BFNAR 2013:2 p. 9.16), same as the voucher-series
-- override on cash_accounts (20260902124513).
CREATE TRIGGER audit_invoice_payee_defaults
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_payee_defaults
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

DROP TRIGGER IF EXISTS audit_cash_accounts_invoice_payee ON public.cash_accounts;
CREATE TRIGGER audit_cash_accounts_invoice_payee
  AFTER UPDATE ON public.cash_accounts
  FOR EACH ROW
  WHEN (
    OLD.bank_name IS DISTINCT FROM NEW.bank_name
    OR OLD.clearing_number IS DISTINCT FROM NEW.clearing_number
    OR OLD.account_number IS DISTINCT FROM NEW.account_number
    OR OLD.bankgiro IS DISTINCT FROM NEW.bankgiro
    OR OLD.plusgiro IS DISTINCT FROM NEW.plusgiro
    OR OLD.swish IS DISTINCT FROM NEW.swish
    OR OLD.bic IS DISTINCT FROM NEW.bic
    OR OLD.bank_code IS DISTINCT FROM NEW.bank_code
    OR OLD.foreign_account_number IS DISTINCT FROM NEW.foreign_account_number
    OR OLD.invoice_payee IS DISTINCT FROM NEW.invoice_payee
  )
  EXECUTE FUNCTION public.write_audit_log();

-- ============================================================
-- 3. Mirror into company_settings
-- ============================================================

-- The payee fields of one cash account in the exact shape
-- company_settings.invoice_payment_accounts stores per currency
-- (InvoicePaymentAccount in types/index.ts). Null fields are stripped, same
-- as the 20260722191000 backfill did.
CREATE OR REPLACE FUNCTION public.cash_account_payee_json(p_cash_account_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'bank_name',              NULLIF(btrim(ca.bank_name), ''),
    'clearing_number',        NULLIF(btrim(ca.clearing_number), ''),
    'account_number',         NULLIF(btrim(ca.account_number), ''),
    'bankgiro',               NULLIF(btrim(ca.bankgiro), ''),
    'plusgiro',               NULLIF(btrim(ca.plusgiro), ''),
    'swish',                  NULLIF(btrim(ca.swish), ''),
    'iban',                   NULLIF(upper(regexp_replace(ca.iban, '\s', '', 'g')), ''),
    'bic',                    NULLIF(upper(regexp_replace(ca.bic, '\s', '', 'g')), ''),
    'bank_code',              NULLIF(regexp_replace(ca.bank_code, '\s', '', 'g'), ''),
    'foreign_account_number', NULLIF(regexp_replace(ca.foreign_account_number, '\s', '', 'g'), '')
  ))
  FROM public.cash_accounts ca
  WHERE ca.id = p_cash_account_id;
$$;

-- Rewrite the company's invoice_payment_accounts map and legacy SEK columns
-- from its invoice_payee_defaults. Currencies with no default row keep
-- whatever the map already held (the resolver's fallback); currencies with
-- one are overwritten from the account.
CREATE OR REPLACE FUNCTION public.mirror_invoice_payee_defaults(p_company_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_map jsonb;
  v_sek jsonb;
BEGIN
  SELECT COALESCE(cs.invoice_payment_accounts, '{}'::jsonb)
    INTO v_map
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COALESCE(v_map || jsonb_object_agg(d.currency, public.cash_account_payee_json(d.cash_account_id)), v_map)
    INTO v_map
    FROM public.invoice_payee_defaults d
   WHERE d.company_id = p_company_id;

  v_sek := v_map -> 'SEK';

  UPDATE public.company_settings cs
     SET invoice_payment_accounts = v_map,
         bank_name       = v_sek ->> 'bank_name',
         clearing_number = v_sek ->> 'clearing_number',
         account_number  = v_sek ->> 'account_number',
         bankgiro        = v_sek ->> 'bankgiro',
         plusgiro        = v_sek ->> 'plusgiro',
         swish           = v_sek ->> 'swish',
         iban            = v_sek ->> 'iban',
         bic             = v_sek ->> 'bic'
   WHERE cs.company_id = p_company_id
     AND (
       cs.invoice_payment_accounts IS DISTINCT FROM v_map
       OR cs.bank_name       IS DISTINCT FROM (v_sek ->> 'bank_name')
       OR cs.clearing_number IS DISTINCT FROM (v_sek ->> 'clearing_number')
       OR cs.account_number  IS DISTINCT FROM (v_sek ->> 'account_number')
       OR cs.bankgiro        IS DISTINCT FROM (v_sek ->> 'bankgiro')
       OR cs.plusgiro        IS DISTINCT FROM (v_sek ->> 'plusgiro')
       OR cs.swish           IS DISTINCT FROM (v_sek ->> 'swish')
       OR cs.iban            IS DISTINCT FROM (v_sek ->> 'iban')
       OR cs.bic             IS DISTINCT FROM (v_sek ->> 'bic')
     );
END;
$$;

REVOKE ALL ON FUNCTION public.mirror_invoice_payee_defaults(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.trg_mirror_invoice_payee_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM public.mirror_invoice_payee_defaults(NEW.company_id);
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND (TG_OP = 'DELETE' OR OLD.company_id IS DISTINCT FROM NEW.company_id) THEN
    PERFORM public.mirror_invoice_payee_defaults(OLD.company_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER mirror_invoice_payee_defaults_on_defaults
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_payee_defaults
  FOR EACH ROW EXECUTE FUNCTION public.trg_mirror_invoice_payee_defaults();

-- Payee-field edits on an account that is a default for some currency must
-- reach the mirror too. Bank sync churn (balances, names) never fires this.
CREATE TRIGGER mirror_invoice_payee_defaults_on_cash_account
  AFTER UPDATE ON public.cash_accounts
  FOR EACH ROW
  WHEN (
    OLD.bank_name IS DISTINCT FROM NEW.bank_name
    OR OLD.clearing_number IS DISTINCT FROM NEW.clearing_number
    OR OLD.account_number IS DISTINCT FROM NEW.account_number
    OR OLD.bankgiro IS DISTINCT FROM NEW.bankgiro
    OR OLD.plusgiro IS DISTINCT FROM NEW.plusgiro
    OR OLD.swish IS DISTINCT FROM NEW.swish
    OR OLD.iban IS DISTINCT FROM NEW.iban
    OR OLD.bic IS DISTINCT FROM NEW.bic
    OR OLD.bank_code IS DISTINCT FROM NEW.bank_code
    OR OLD.foreign_account_number IS DISTINCT FROM NEW.foreign_account_number
  )
  EXECUTE FUNCTION public.trg_mirror_invoice_payee_defaults();

-- ============================================================
-- 4. Backfill from today's map (no row creation)
-- ============================================================

-- One row per (company, currency) that has payment instructions today: the
-- map entry, or for SEK the legacy columns when the map has no SEK key.
CREATE TEMP TABLE payee_backfill_entries AS
SELECT cs.company_id, k.key AS currency, k.value AS payee
  FROM public.company_settings cs
  CROSS JOIN LATERAL jsonb_each(cs.invoice_payment_accounts) k
 WHERE cs.invoice_payment_accounts <> '{}'::jsonb
UNION ALL
SELECT cs.company_id, 'SEK',
       jsonb_strip_nulls(jsonb_build_object(
         'bank_name',       NULLIF(btrim(cs.bank_name), ''),
         'clearing_number', NULLIF(btrim(cs.clearing_number), ''),
         'account_number',  NULLIF(btrim(cs.account_number), ''),
         'bankgiro',        NULLIF(btrim(cs.bankgiro), ''),
         'plusgiro',        NULLIF(btrim(cs.plusgiro), ''),
         'swish',           NULLIF(btrim(cs.swish), ''),
         'iban',            NULLIF(btrim(cs.iban), ''),
         'bic',             NULLIF(btrim(cs.bic), '')
       ))
  FROM public.company_settings cs
 WHERE NOT (COALESCE(cs.invoice_payment_accounts, '{}'::jsonb) ? 'SEK')
   AND COALESCE(
         NULLIF(btrim(cs.bank_name), ''), NULLIF(btrim(cs.clearing_number), ''),
         NULLIF(btrim(cs.account_number), ''), NULLIF(btrim(cs.bankgiro), ''),
         NULLIF(btrim(cs.plusgiro), ''), NULLIF(btrim(cs.swish), ''),
         NULLIF(btrim(cs.iban), ''), NULLIF(btrim(cs.bic), '')
       ) IS NOT NULL;

-- Target account per entry: primary in that currency, else IBAN match, else
-- the only enabled account in that currency. Ambiguous or absent: no target.
CREATE TEMP TABLE payee_backfill_targets AS
SELECT e.company_id, e.currency, e.payee,
       COALESCE(
         (SELECT ca.id FROM public.cash_accounts ca
           WHERE ca.company_id = e.company_id AND ca.enabled AND ca.currency = e.currency AND ca.is_primary
           LIMIT 1),
         (SELECT ca.id FROM public.cash_accounts ca
           WHERE ca.company_id = e.company_id AND ca.enabled AND ca.currency = e.currency
             AND e.payee ->> 'iban' IS NOT NULL
             AND upper(regexp_replace(ca.iban, '\s', '', 'g')) = upper(regexp_replace(e.payee ->> 'iban', '\s', '', 'g'))
           ORDER BY ca.created_at, ca.id
           LIMIT 1),
         (SELECT (array_agg(ca.id))[1] FROM public.cash_accounts ca
           WHERE ca.company_id = e.company_id AND ca.enabled AND ca.currency = e.currency
           HAVING count(*) = 1)
       ) AS cash_account_id
  FROM payee_backfill_entries e;

-- Copy payee fields into NULL columns only: a connected account's IBAN is
-- the bank's word and wins over a typed one.
UPDATE public.cash_accounts ca
   SET bank_name              = COALESCE(ca.bank_name, t.payee ->> 'bank_name'),
       clearing_number        = COALESCE(ca.clearing_number, t.payee ->> 'clearing_number'),
       account_number         = COALESCE(ca.account_number, t.payee ->> 'account_number'),
       bankgiro               = COALESCE(ca.bankgiro, t.payee ->> 'bankgiro'),
       plusgiro               = COALESCE(ca.plusgiro, t.payee ->> 'plusgiro'),
       swish                  = COALESCE(ca.swish, t.payee ->> 'swish'),
       iban                   = COALESCE(ca.iban, t.payee ->> 'iban'),
       bic                    = COALESCE(ca.bic, t.payee ->> 'bic'),
       bank_code              = COALESCE(ca.bank_code, t.payee ->> 'bank_code'),
       foreign_account_number = COALESCE(ca.foreign_account_number, t.payee ->> 'foreign_account_number'),
       invoice_payee          = true
  FROM payee_backfill_targets t
 WHERE t.cash_account_id = ca.id;

INSERT INTO public.invoice_payee_defaults (company_id, currency, cash_account_id)
SELECT t.company_id, t.currency, t.cash_account_id
  FROM payee_backfill_targets t
 WHERE t.cash_account_id IS NOT NULL
ON CONFLICT (company_id, currency) DO NOTHING;

DO $$
DECLARE
  v_total integer;
  v_landed integer;
BEGIN
  SELECT count(*), count(cash_account_id) INTO v_total, v_landed FROM payee_backfill_targets;
  RAISE NOTICE 'invoice payee backfill: % of % currency entries landed on a cash account; the rest stay in company_settings.invoice_payment_accounts as fallback',
    v_landed, v_total;
END;
$$;

DROP TABLE payee_backfill_targets;
DROP TABLE payee_backfill_entries;

NOTIFY pgrst, 'reload schema';
