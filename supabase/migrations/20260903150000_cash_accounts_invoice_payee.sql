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
--      payee IBAN, BIC, Swish, foreign routing) plus invoice_payee: "may be
--      printed on an invoice". The payee IBAN is its own column: cash_accounts.iban
--      is the bank's identity of the account (written by every PSD2 sync and
--      used to re-pair accounts on reconnect), while payee_iban is what the
--      company chooses to print; a sync must never rewrite an invoice
--      instruction, and a cleared payee IBAN must stay cleared.
--      bg_pg (one text for both giro kinds) was never read or written anywhere
--      and is dropped; verified NULL on every prod and staging row 2026-09-03.
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
--   4. Payee columns are admin-only at the database, not just in the routes:
--      cash_accounts writes are member-level (bank sync touches them), but
--      where customers are told to pay was admin-only before this migration
--      (company_settings RLS) and must stay so. Revoking an account as payee
--      (invoice_payee = false, admin-only) drops its defaults. Disabling an
--      account (enabled = false, member-level: the bank picker's "Synkas ej")
--      does not: a member must not be able to undo an admin's payee choice;
--      the pick lists exclude disabled accounts and the send gate refuses an
--      invoice that chose one.
--   5. Backfill from today's map onto existing cash accounts, copying each
--      currency entry verbatim (the map entry wins over anything the account
--      knew, including the IBAN): every invoice keeps printing exactly what
--      it printed before. No rows are created: an entry with no matching
--      account stays in the map as the fallback the resolver already honours.
--
-- The mirror runs SECURITY DEFINER because company_settings updates are
-- admin-gated by RLS. The admin guard in (4) is what makes that safe: only an
-- admin (or the service role) can change what the mirror derives from.

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
  ADD COLUMN IF NOT EXISTS payee_iban             text,
  ADD COLUMN IF NOT EXISTS bic                    text,
  ADD COLUMN IF NOT EXISTS bank_code              text,
  ADD COLUMN IF NOT EXISTS foreign_account_number text,
  ADD COLUMN IF NOT EXISTS invoice_payee          boolean NOT NULL DEFAULT false;

ALTER TABLE public.cash_accounts DROP COLUMN IF EXISTS bg_pg;

COMMENT ON COLUMN public.cash_accounts.invoice_payee IS
  'True when this account may be printed as the payee on customer invoices. Payee columns are owner/admin-only (trigger cash_accounts_payee_admin_only).';
COMMENT ON COLUMN public.cash_accounts.bban IS
  'Raw BBAN from the bank connection (Swedish: clearing number followed by account number). Prefill only; clearing_number/account_number are what prints.';
COMMENT ON COLUMN public.cash_accounts.payee_iban IS
  'IBAN printed on customer invoices. Separate from iban (the bank identity written by sync) so a sync never rewrites an invoice instruction.';

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

-- The payee columns, in one place: the audit trigger, the mirror trigger
-- and the admin guard below all fire on exactly this set.
CREATE OR REPLACE FUNCTION public.cash_account_payee_changed(old_row public.cash_accounts, new_row public.cash_accounts)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT old_row.bank_name              IS DISTINCT FROM new_row.bank_name
      OR old_row.clearing_number        IS DISTINCT FROM new_row.clearing_number
      OR old_row.account_number         IS DISTINCT FROM new_row.account_number
      OR old_row.bankgiro               IS DISTINCT FROM new_row.bankgiro
      OR old_row.plusgiro               IS DISTINCT FROM new_row.plusgiro
      OR old_row.swish                  IS DISTINCT FROM new_row.swish
      OR old_row.payee_iban             IS DISTINCT FROM new_row.payee_iban
      OR old_row.bic                    IS DISTINCT FROM new_row.bic
      OR old_row.bank_code              IS DISTINCT FROM new_row.bank_code
      OR old_row.foreign_account_number IS DISTINCT FROM new_row.foreign_account_number
      OR old_row.invoice_payee          IS DISTINCT FROM new_row.invoice_payee
$$;

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
    OR OLD.payee_iban IS DISTINCT FROM NEW.payee_iban
    OR OLD.bic IS DISTINCT FROM NEW.bic
    OR OLD.bank_code IS DISTINCT FROM NEW.bank_code
    OR OLD.foreign_account_number IS DISTINCT FROM NEW.foreign_account_number
    OR OLD.invoice_payee IS DISTINCT FROM NEW.invoice_payee
  )
  EXECUTE FUNCTION public.write_audit_log();

-- ============================================================
-- 3. Admin-only payee columns
-- ============================================================

-- Where customers are told to pay was owner/admin-only before this migration
-- (company_settings RLS, 20260422120000). cash_accounts is member-writable
-- because bank sync runs on the member's session, so the payee columns need
-- their own gate. The service role and migrations (auth.uid() IS NULL) pass;
-- a session that is not owner/admin of the company is refused.
CREATE OR REPLACE FUNCTION public.cash_accounts_payee_admin_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_touches boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_touches := NEW.invoice_payee
      OR COALESCE(NEW.bank_name, NEW.clearing_number, NEW.account_number, NEW.bankgiro,
                  NEW.plusgiro, NEW.swish, NEW.payee_iban, NEW.bic, NEW.bank_code,
                  NEW.foreign_account_number) IS NOT NULL;
  ELSE
    v_touches := public.cash_account_payee_changed(OLD, NEW);
  END IF;
  IF v_touches AND auth.uid() IS NOT NULL AND NOT public.user_is_company_admin(NEW.company_id) THEN
    RAISE EXCEPTION 'INVOICE_PAYEE_ADMIN_ONLY: only owner or admin may change where customer invoices are paid'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cash_accounts_payee_admin_only() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS cash_accounts_payee_admin_only ON public.cash_accounts;
CREATE TRIGGER cash_accounts_payee_admin_only
  BEFORE INSERT OR UPDATE ON public.cash_accounts
  FOR EACH ROW EXECUTE FUNCTION public.cash_accounts_payee_admin_only();

-- ============================================================
-- 4. Mirror into company_settings
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
    'iban',                   NULLIF(upper(regexp_replace(ca.payee_iban, '\s', '', 'g')), ''),
    'bic',                    NULLIF(upper(regexp_replace(ca.bic, '\s', '', 'g')), ''),
    'bank_code',              NULLIF(regexp_replace(ca.bank_code, '\s', '', 'g'), ''),
    'foreign_account_number', NULLIF(regexp_replace(ca.foreign_account_number, '\s', '', 'g'), '')
  ))
  FROM public.cash_accounts ca
  WHERE ca.id = p_cash_account_id;
$$;

-- Rewrite the company's invoice_payment_accounts map and legacy SEK columns
-- from its invoice_payee_defaults.
--   * A currency with a default row is overwritten from the account.
--   * A currency whose default was just removed (p_drop_currency) loses its
--     key: an admin who clears the default means "nothing to print", and
--     the send gate then asks for an account instead of printing a closed one.
--   * Any other currency keeps whatever the map held: entries that never
--     landed on an account stay as the resolver's fallback.
--   * The legacy SEK columns are written only when the map carries a SEK
--     entry (or SEK was just dropped). A company whose only SEK instruction
--     is the legacy columns must not have them nulled by a mirror run that
--     concerns another currency.
CREATE OR REPLACE FUNCTION public.mirror_invoice_payee_defaults(p_company_id uuid, p_drop_currency text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_map jsonb;
  v_sek jsonb;
  v_write_legacy boolean;
BEGIN
  SELECT COALESCE(cs.invoice_payment_accounts, '{}'::jsonb)
    INTO v_map
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_drop_currency IS NOT NULL THEN
    v_map := v_map - p_drop_currency;
  END IF;

  SELECT COALESCE(v_map || jsonb_object_agg(d.currency, public.cash_account_payee_json(d.cash_account_id)), v_map)
    INTO v_map
    FROM public.invoice_payee_defaults d
   WHERE d.company_id = p_company_id;

  v_write_legacy := (v_map ? 'SEK') OR p_drop_currency = 'SEK';
  v_sek := v_map -> 'SEK';

  UPDATE public.company_settings cs
     SET invoice_payment_accounts = v_map,
         bank_name       = CASE WHEN v_write_legacy THEN v_sek ->> 'bank_name'       ELSE cs.bank_name END,
         clearing_number = CASE WHEN v_write_legacy THEN v_sek ->> 'clearing_number' ELSE cs.clearing_number END,
         account_number  = CASE WHEN v_write_legacy THEN v_sek ->> 'account_number'  ELSE cs.account_number END,
         bankgiro        = CASE WHEN v_write_legacy THEN v_sek ->> 'bankgiro'        ELSE cs.bankgiro END,
         plusgiro        = CASE WHEN v_write_legacy THEN v_sek ->> 'plusgiro'        ELSE cs.plusgiro END,
         swish           = CASE WHEN v_write_legacy THEN v_sek ->> 'swish'           ELSE cs.swish END,
         iban            = CASE WHEN v_write_legacy THEN v_sek ->> 'iban'            ELSE cs.iban END,
         bic             = CASE WHEN v_write_legacy THEN v_sek ->> 'bic'             ELSE cs.bic END
   WHERE cs.company_id = p_company_id
     AND (
       cs.invoice_payment_accounts IS DISTINCT FROM v_map
       OR (v_write_legacy AND (
         cs.bank_name       IS DISTINCT FROM (v_sek ->> 'bank_name')
         OR cs.clearing_number IS DISTINCT FROM (v_sek ->> 'clearing_number')
         OR cs.account_number  IS DISTINCT FROM (v_sek ->> 'account_number')
         OR cs.bankgiro        IS DISTINCT FROM (v_sek ->> 'bankgiro')
         OR cs.plusgiro        IS DISTINCT FROM (v_sek ->> 'plusgiro')
         OR cs.swish           IS DISTINCT FROM (v_sek ->> 'swish')
         OR cs.iban            IS DISTINCT FROM (v_sek ->> 'iban')
         OR cs.bic             IS DISTINCT FROM (v_sek ->> 'bic')
       ))
     );
END;
$$;

-- Trigger-only writers: nothing in a session may call them (the anon key
-- would otherwise get an unauthenticated cross-tenant rewrite of
-- company_settings). PUBLIC included: anon is a member of PUBLIC.
REVOKE EXECUTE ON FUNCTION public.mirror_invoice_payee_defaults(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_mirror_invoice_payee_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- An account revoked as payee stops being a default (the defaults DELETE
  -- trigger then drops that currency from the map). invoice_payee is
  -- admin-only (cash_accounts_payee_admin_only), so this cannot be reached
  -- by a member; enabled is member-level and deliberately does not revoke.
  -- The field read sits in its own branch: plpgsql resolves NEW.<field> per
  -- expression, and this function also fires for invoice_payee_defaults
  -- rows, which have no invoice_payee column.
  IF TG_TABLE_NAME = 'cash_accounts' THEN
    IF TG_OP = 'UPDATE' AND NEW.invoice_payee = false AND OLD.invoice_payee = true THEN
      DELETE FROM public.invoice_payee_defaults WHERE cash_account_id = NEW.id;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'invoice_payee_defaults' THEN
    IF TG_OP = 'DELETE' THEN
      PERFORM public.mirror_invoice_payee_defaults(OLD.company_id, OLD.currency);
    ELSIF TG_OP = 'UPDATE' AND OLD.currency IS DISTINCT FROM NEW.currency THEN
      PERFORM public.mirror_invoice_payee_defaults(NEW.company_id, OLD.currency);
    ELSE
      PERFORM public.mirror_invoice_payee_defaults(NEW.company_id);
    END IF;
  ELSE
    PERFORM public.mirror_invoice_payee_defaults(NEW.company_id);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trg_mirror_invoice_payee_defaults() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER mirror_invoice_payee_defaults_on_defaults
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_payee_defaults
  FOR EACH ROW EXECUTE FUNCTION public.trg_mirror_invoice_payee_defaults();

-- Payee-field edits or a revoke on an account that is a default for some
-- currency must reach the mirror too. Bank sync churn (balances, names, the
-- enabled flag, the bank identity iban) never fires this.
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
    OR OLD.payee_iban IS DISTINCT FROM NEW.payee_iban
    OR OLD.bic IS DISTINCT FROM NEW.bic
    OR OLD.bank_code IS DISTINCT FROM NEW.bank_code
    OR OLD.foreign_account_number IS DISTINCT FROM NEW.foreign_account_number
    OR OLD.invoice_payee IS DISTINCT FROM NEW.invoice_payee
  )
  EXECUTE FUNCTION public.trg_mirror_invoice_payee_defaults();

-- ============================================================
-- 5. Backfill from today's map (no row creation)
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

-- Target account per entry: the account whose bank IBAN equals the entry's
-- IBAN, else the primary in that currency, else the only enabled account in
-- that currency. Ambiguous or absent: no target, the entry stays in the map.
CREATE TEMP TABLE payee_backfill_targets AS
SELECT e.company_id, e.currency, e.payee,
       COALESCE(
         (SELECT ca.id FROM public.cash_accounts ca
           WHERE ca.company_id = e.company_id AND ca.enabled AND ca.currency = e.currency
             AND e.payee ->> 'iban' IS NOT NULL
             AND upper(regexp_replace(ca.iban, '\s', '', 'g')) = upper(regexp_replace(e.payee ->> 'iban', '\s', '', 'g'))
           ORDER BY ca.created_at, ca.id
           LIMIT 1),
         (SELECT ca.id FROM public.cash_accounts ca
           WHERE ca.company_id = e.company_id AND ca.enabled AND ca.currency = e.currency AND ca.is_primary
           LIMIT 1),
         (SELECT (array_agg(ca.id))[1] FROM public.cash_accounts ca
           WHERE ca.company_id = e.company_id AND ca.enabled AND ca.currency = e.currency
           HAVING count(*) = 1)
       ) AS cash_account_id
  FROM payee_backfill_entries e;

-- The entry is copied verbatim onto the account's payee columns: what the
-- company printed yesterday is what it prints tomorrow. The bank identity
-- column iban is left alone; the printed IBAN lives in payee_iban.
UPDATE public.cash_accounts ca
   SET bank_name              = t.payee ->> 'bank_name',
       clearing_number        = t.payee ->> 'clearing_number',
       account_number         = t.payee ->> 'account_number',
       bankgiro               = t.payee ->> 'bankgiro',
       plusgiro               = t.payee ->> 'plusgiro',
       swish                  = t.payee ->> 'swish',
       payee_iban             = t.payee ->> 'iban',
       bic                    = t.payee ->> 'bic',
       bank_code              = t.payee ->> 'bank_code',
       foreign_account_number = t.payee ->> 'foreign_account_number',
       invoice_payee          = true
  FROM payee_backfill_targets t
 WHERE t.cash_account_id = ca.id
   -- One account may be the target for several currencies; the SEK entry
   -- (the legacy instruction set) wins when they disagree.
   AND t.currency = (
     SELECT t2.currency FROM payee_backfill_targets t2
      WHERE t2.cash_account_id = t.cash_account_id
      ORDER BY (t2.currency = 'SEK') DESC, t2.currency
      LIMIT 1
   );

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
