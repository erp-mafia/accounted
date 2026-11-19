-- Grants: dated company rules that let an agent book a known counterparty's
-- bank lines unattended, within limits, and that a person reviews after.
--
-- Profiles and Suggestions, step 4 (grants as suggestions, the autonomy half
-- of Phase 3). The rules: autonomy "within company policies" (agents post
-- inside the company's rules; humans review exceptions after the fact);
-- every grant starts switched off and a company turns each one on from a
-- suggestion; every grant is a dated processing rule (BFNAR 2013:2 p. 9.16:
-- changes to automatkonteringar are dated in behandlingshistorik).
--
-- 1. company_grants: one row per version of a rule. A rule is keyed by the
--    company, the operation it covers (today only categorize_transaction, a
--    bank line booked by category) and the counterparty, as the system keys
--    it (grant_counterparty_key below: normalize_counterparty_key over the
--    bank line's merchant name, original description or description, the
--    same order the counterparty templates learn from). It names the booking
--    pattern the company approved (direction, category, VAT treatment, the
--    business account and every account the posting touches), the limits (SEK
--    per posting, optionally per calendar month of the posting date), who may
--    use it (any key credential of the company, or one named API key or
--    service account), when it is valid from, who accepted it and when, and
--    when and by whom it was revoked. At most one active version per rule. A
--    row is never changed in place and never deleted: a change is a new
--    version (the old one is revoked as superseded in the same transaction),
--    and revoking only fills the revoked_* columns once. Written only by the
--    SECURITY DEFINER functions of 20261017100300, which log every change to
--    audit_log for behandlingshistorik.
--
-- 2. company_grant_uses: one row per staged operation a grant let through.
--    claim_company_grant (20261017100400) writes it as 'claimed' in the same
--    transaction that matched the operation; the caller then commits the
--    operation and marks the use 'committed' (with the verifikat) or
--    'released' (the commit refused, the operation stays for a person). It is
--    what the monthly limit counts, what revoking a grant answers with, and
--    what Att göra lists under "Bokfört enligt regel" until a person marks it
--    reviewed.
--
-- 3. company_grant_settings: the company's kill switch. paused = true turns
--    every grant of the company off at once (claim_company_grant refuses
--    before it reads a grant). Written only by set_company_grants_paused.
--
-- 4. grant_names_counterparty / grant_counterparty_key: the counterparty
--    identity a grant is keyed by. A bank text that names no one (only the
--    bank's own wording, "INTERNET BET 4") or only a payment processor
--    ("PAYPAL", the rail every purchase through it shares) has no identity
--    and never gets a grant: the empty key. The phrase list mirrors
--    BANK_NOISE_PHRASES (src/lib/bookkeeping/booking-templates.ts);
--    tests/pg/company-grants.pg.test.ts asserts it agrees with
--    namesCounterparty() on the cases that matter.
--
-- Nothing here touches the bookkeeping: no journal table is written and no
-- trigger of migration 017 is touched. Postings under a grant go through the
-- engine like every approved categorization.
--
-- pg-test: tests/pg/company-grants.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. company_grants
-- =============================================================================

CREATE TABLE public.company_grants (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                   uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  operation_type               text NOT NULL
    CONSTRAINT company_grants_operation_type_check CHECK (operation_type IN ('categorize_transaction')),
  counterparty_key             text NOT NULL
    CONSTRAINT company_grants_counterparty_key_check CHECK (char_length(counterparty_key) BETWEEN 2 AND 200),
  counterparty_label           text NOT NULL
    CONSTRAINT company_grants_counterparty_label_check CHECK (char_length(counterparty_label) BETWEEN 1 AND 200),
  version                      integer NOT NULL CONSTRAINT company_grants_version_check CHECK (version >= 1),
  -- The booking pattern: what the posting may look like, exactly.
  direction                    text NOT NULL CONSTRAINT company_grants_direction_check CHECK (direction IN ('out', 'in')),
  category                     text NOT NULL
    CONSTRAINT company_grants_category_check
    CHECK (category ~ '^(expense|income)_[a-z_]+$' AND category <> 'expense_representation'),
  vat_treatment                text
    CONSTRAINT company_grants_vat_treatment_check CHECK (vat_treatment IS NULL OR vat_treatment ~ '^[a-z0-9_]{1,40}$'),
  reverse_charge_kind          text
    CONSTRAINT company_grants_reverse_charge_kind_check CHECK (reverse_charge_kind IS NULL OR reverse_charge_kind ~ '^[a-z_]{1,40}$'),
  account_number               text NOT NULL
    CONSTRAINT company_grants_account_number_check CHECK (account_number ~ '^[0-9]{4}$'),
  line_accounts                text[] NOT NULL
    CONSTRAINT company_grants_line_accounts_check
    CHECK (cardinality(line_accounts) BETWEEN 2 AND 8 AND account_number = ANY (line_accounts)),
  -- The limits, in SEK. The key's own unattended ceiling still applies on top.
  amount_limit_sek             numeric(14, 2) NOT NULL
    CONSTRAINT company_grants_amount_limit_check CHECK (amount_limit_sek > 0 AND amount_limit_sek <= 10000000),
  monthly_limit_sek            numeric(14, 2)
    CONSTRAINT company_grants_monthly_limit_check CHECK (monthly_limit_sek IS NULL OR monthly_limit_sek >= amount_limit_sek),
  -- Who may use it. No foreign key: a deleted key or account must leave the
  -- grant inert (it then matches no credential), never widen it to 'any'.
  credential_scope             text NOT NULL DEFAULT 'any'
    CONSTRAINT company_grants_credential_scope_check CHECK (credential_scope IN ('any', 'api_key', 'service_account')),
  credential_id                uuid,
  valid_from                   timestamptz NOT NULL DEFAULT now(),
  -- Who accepted it, when, and through which credential.
  accepted_by                  uuid NOT NULL REFERENCES auth.users(id),
  accepted_at                  timestamptz NOT NULL DEFAULT now(),
  accepted_actor_type          text NOT NULL,
  accepted_actor_label         text,
  pending_operation_id         uuid REFERENCES public.pending_operations(id) ON DELETE SET NULL,
  -- What the suggestion was based on (bookings counted, largest amount, last date).
  evidence                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  revoked_at                   timestamptz,
  revoked_by                   uuid REFERENCES auth.users(id),
  revoked_reason               text
    CONSTRAINT company_grants_revoked_reason_check CHECK (revoked_reason IS NULL OR revoked_reason IN ('revoked', 'superseded')),
  revoked_pending_operation_id uuid REFERENCES public.pending_operations(id) ON DELETE SET NULL,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_grants_credential_check CHECK ((credential_scope = 'any') = (credential_id IS NULL)),
  CONSTRAINT company_grants_revoked_check CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT company_grants_version_key UNIQUE (company_id, operation_type, counterparty_key, version)
);

COMMENT ON TABLE public.company_grants IS
  'Dated company rules (grants): a key credential may book one counterparty''s bank lines exactly as the company approved, within limits, without a person approving each one. One row per version; never changed in place or deleted, only revoked. Written by create_company_grant and revoke_company_grant (approved staged operations), which log to audit_log for behandlingshistorik.';
COMMENT ON COLUMN public.company_grants.counterparty_key IS
  'grant_counterparty_key() of the bank lines the rule covers: exact equality only, never fuzzy.';
COMMENT ON COLUMN public.company_grants.line_accounts IS
  'Every account the posting may touch, sorted and distinct (business account, VAT accounts, the bank account). The staged posting must touch exactly these.';
COMMENT ON COLUMN public.company_grants.monthly_limit_sek IS
  'Optional: the most the rule lets through per calendar month of the posting date, in SEK.';
COMMENT ON COLUMN public.company_grants.credential_scope IS
  'any: every key credential of the company (api_key, mcp_oauth, service_account). api_key or service_account: only the credential named by credential_id.';

CREATE UNIQUE INDEX company_grants_one_active
  ON public.company_grants (company_id, operation_type, counterparty_key)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_company_grants_company ON public.company_grants (company_id, created_at DESC);
CREATE INDEX idx_company_grants_pending_operation
  ON public.company_grants (pending_operation_id) WHERE pending_operation_id IS NOT NULL;

ALTER TABLE public.company_grants ENABLE ROW LEVEL SECURITY;

-- Members read their companies' grants (Att göra, the agent briefing). Every
-- write is a SECURITY DEFINER function: no write policy for members.
CREATE POLICY "members read company_grants"
  ON public.company_grants FOR SELECT
  TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.company_grants TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.company_grants TO service_role;
-- no-grant: anon on public.company_grants (company-scoped: members only)

CREATE TRIGGER set_updated_at_company_grants
  BEFORE UPDATE ON public.company_grants
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- A dated rule is never rewritten: everything but the revocation is fixed,
-- and a revocation is final. Deleted only with its company (the cascade from
-- companies, when the company row itself is already gone).
CREATE FUNCTION public.company_grants_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_revocation text[] := ARRAY['revoked_at', 'revoked_by', 'revoked_reason', 'revoked_pending_operation_id', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.companies WHERE id = OLD.company_id) THEN
      RAISE EXCEPTION 'company_grants: a grant is never deleted, revoke it instead' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - v_revocation) IS DISTINCT FROM (to_jsonb(OLD) - v_revocation) THEN
    RAISE EXCEPTION 'company_grants: a grant is a dated rule, change it with a new version, never in place' USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (
       NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
    OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
    OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason
    OR NEW.revoked_pending_operation_id IS DISTINCT FROM OLD.revoked_pending_operation_id) THEN
    RAISE EXCEPTION 'company_grants: a revoked grant stays revoked' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER company_grants_immutable
  BEFORE UPDATE OR DELETE ON public.company_grants
  FOR EACH ROW EXECUTE FUNCTION public.company_grants_immutable();

-- =============================================================================
-- 2. company_grant_uses
-- =============================================================================

CREATE TABLE public.company_grant_uses (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  grant_id             uuid NOT NULL REFERENCES public.company_grants(id) ON DELETE CASCADE,
  grant_version        integer NOT NULL,
  pending_operation_id uuid REFERENCES public.pending_operations(id) ON DELETE SET NULL,
  transaction_id       uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  journal_entry_id     uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  entry_date           date NOT NULL,
  amount_sek           numeric(14, 2) NOT NULL CONSTRAINT company_grant_uses_amount_check CHECK (amount_sek > 0),
  -- The credential that staged it, as validated when the use was claimed.
  api_key_id           uuid,
  service_account_id   uuid,
  status               text NOT NULL
    CONSTRAINT company_grant_uses_status_check CHECK (status IN ('claimed', 'committed', 'released')),
  release_reason       text CONSTRAINT company_grant_uses_release_reason_check CHECK (release_reason IS NULL OR char_length(release_reason) <= 100),
  -- After the commit: the posted lines touch exactly the grant's accounts and stay within its limit.
  pattern_verified     boolean,
  claimed_at           timestamptz NOT NULL DEFAULT now(),
  committed_at         timestamptz,
  released_at          timestamptz,
  reviewed_at          timestamptz,
  reviewed_by          uuid REFERENCES auth.users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_grant_uses_operation_key UNIQUE (pending_operation_id),
  CONSTRAINT company_grant_uses_committed_check CHECK ((status = 'committed') = (committed_at IS NOT NULL)),
  CONSTRAINT company_grant_uses_released_check CHECK ((status = 'released') = (released_at IS NOT NULL)),
  CONSTRAINT company_grant_uses_reviewed_check CHECK (reviewed_at IS NULL OR status <> 'released')
);

COMMENT ON TABLE public.company_grant_uses IS
  'One row per staged operation a company grant let through without a person: claimed when matched, committed with its verifikat, or released when the commit refused (the operation then waits for a person). Counted by the monthly limit, listed for review under Bokfört enligt regel, answered when the grant is revoked.';

CREATE INDEX idx_company_grant_uses_company_status ON public.company_grant_uses (company_id, status, reviewed_at);
CREATE INDEX idx_company_grant_uses_grant ON public.company_grant_uses (grant_id);
CREATE INDEX idx_company_grant_uses_transaction ON public.company_grant_uses (transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX idx_company_grant_uses_journal_entry ON public.company_grant_uses (journal_entry_id) WHERE journal_entry_id IS NOT NULL;

ALTER TABLE public.company_grant_uses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read company_grant_uses"
  ON public.company_grant_uses FOR SELECT
  TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.company_grant_uses TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.company_grant_uses TO service_role;
-- no-grant: anon on public.company_grant_uses (company-scoped: members only)

CREATE TRIGGER set_updated_at_company_grant_uses
  BEFORE UPDATE ON public.company_grant_uses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 3. company_grant_settings: the kill switch
-- =============================================================================

CREATE TABLE public.company_grant_settings (
  company_id  uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  paused      boolean NOT NULL DEFAULT false,
  decided_by  uuid REFERENCES auth.users(id),
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.company_grant_settings IS
  'The company''s kill switch for grants: paused = true turns every grant off at once. Written by set_company_grants_paused (owner or admin), logged to audit_log for behandlingshistorik. No row: grants are not paused.';

ALTER TABLE public.company_grant_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read company_grant_settings"
  ON public.company_grant_settings FOR SELECT
  TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.company_grant_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.company_grant_settings TO service_role;
-- no-grant: anon on public.company_grant_settings (company-scoped: members only)

CREATE TRIGGER set_updated_at_company_grant_settings
  BEFORE UPDATE ON public.company_grant_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 4. The counterparty identity a grant is keyed by
-- =============================================================================

-- Whether a bank text names a counterparty at all once the bank's own wording
-- for HOW it was paid is taken out (mirror of namesCounterparty() over
-- BANK_NOISE_PHRASES in src/lib/bookkeeping/booking-templates.ts).
CREATE FUNCTION public.grant_names_counterparty(p_raw text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
DECLARE
  v_text text := lower(coalesce(p_raw, ''));
  v_phrase text;
  phrases constant text[] := ARRAY[
    'överföring via internet', 'överföring via mobil', 'överföring via app', 'överföring inom bank',
    'överföring mellan konton', 'internetbetalning', 'internet bet', 'mobilbetalning', 'direktbetalning',
    'direktöverföring', 'autogirobetalning', 'autogiro', 'bg-betalning', 'bg betalning', 'pg-betalning',
    'pg betalning', 'bgmax', 'bg-inb', 'plusgiro', 'bankgiro', 'swish till', 'swish från', 'swish-betalning',
    'kortköp', 'kortbetalning', 'webbköp', 'överföring', 'insättning'
  ];
BEGIN
  FOREACH v_phrase IN ARRAY phrases LOOP
    v_text := replace(v_text, v_phrase, ' ');
  END LOOP;
  RETURN v_text ~ '[[:alpha:]]';
END;
$$;

-- The key a grant is matched on: normalize_counterparty_key over the same
-- text the counterparty templates learn from (merchant name, else the bank's
-- original description, else the description). Empty when the text names no
-- one, when what is left is shorter than two characters, or when it is only
-- a payment processor or rail, whose name every purchase through it shares.
CREATE FUNCTION public.grant_counterparty_key(p_merchant_name text, p_original_description text, p_description text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
DECLARE
  v_raw text := coalesce(nullif(p_merchant_name, ''), nullif(p_original_description, ''), p_description);
  v_key text;
  rails constant text[] := ARRAY[
    'paypal', 'klarna', 'izettle', 'zettle', 'iz', 'sq', 'sp', 'sumup', 'google', 'stripe', 'payu', 'mollie',
    'swish', 'bankgiro', 'plusgiro', 'autogiro', 'kortköp', 'kort', 'internet bet', 'överföring', 'insättning'
  ];
BEGIN
  IF v_raw IS NULL OR NOT public.grant_names_counterparty(v_raw) THEN
    RETURN '';
  END IF;
  v_key := public.normalize_counterparty_key(v_raw);
  IF v_key IS NULL OR char_length(v_key) < 2 OR v_key = ANY (rails) OR v_key !~ '[[:alpha:]]' THEN
    RETURN '';
  END IF;
  RETURN v_key;
END;
$$;

GRANT EXECUTE ON FUNCTION public.grant_names_counterparty(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.grant_counterparty_key(text, text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
