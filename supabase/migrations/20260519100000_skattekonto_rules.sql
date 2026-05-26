-- Migration: skattekonto_rules — extensible counter-account rules for skattekontot
--
-- Why this exists: skattekonto-booking previously hardcoded an 8-entry array of
-- (substring → counter-account) rules in TypeScript. Each new SKV transaktionstext
-- pattern (omprövning, skattetillägg, förseningsavgift, ...) required a code change.
-- This table lets users (and migrations) add rules without redeploys, mirroring the
-- Fortnox "Regelverk" model.
--
-- Sign convention is handled by the caller (skattekonto-booking.ts): a positive
-- belopp_skatteverket debits 1630 and credits counter_account; a negative belopp
-- does the reverse. Rules only resolve the counter-account.
--
-- System seeds (company_id IS NULL): read-only to all companies; cannot be mutated
-- via RLS. Per-company rules override system seeds via lower numeric priority.
--
-- Special sentinel: counter_account = '__PRIMARY_SEK__' resolves at runtime via
-- the cash_accounts.is_primary lookup. Used so the inbetalning / utbetalning rules
-- don't have to assume 1930 is the bank account for every company.
--
-- Account 8314 (Skattefria ränteintäkter) is used for intäktsränta instead of 8313
-- (Ränteintäkter från bankgiro etc., taxable) because skattekontoräntan is skattefri
-- per IL 8 kap 7 §.
--
-- Account 6992 (Övriga externa kostnader, ej avdragsgilla) catches skattetillägg
-- and förseningsavgift — both are non-deductible penalties on SKV charges.
--
-- "Omprövning" deliberately has NO system rule: it's a re-assessment, not a
-- penalty. The underlying tax (moms, F-skatt, AGI) is what changes — the existing
-- moms/preliminärskatt/AGI rules cover those cases. Routing "omprövning" to 6992
-- by keyword alone would mis-book a moms re-assessment as a non-deductible cost.
--
-- Anstånd is intentionally NOT given a rule. Anstånd is an SKV-side deferral
-- (the saldo changes but no underlying tax is restated), so the GL doesn't move.
-- The resolver returns null and the booking flow surfaces NO_COUNTER_ACCOUNT for
-- the user to handle manually if a rare anstånd-across-closed-period case appears.

CREATE TABLE public.skattekonto_rules (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- NULL = system default seed, readable by every company.
  company_id           UUID REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Lower priority wins. Per-company rules typically use 1-49 to override system
  -- seeds (10-30).
  priority             INTEGER NOT NULL,
  -- Comma-separated lowercase substrings; ANY match wins.
  pattern              TEXT NOT NULL CHECK (length(pattern) > 0),
  amount_min           NUMERIC,
  amount_max           NUMERIC,
  company_type         TEXT NOT NULL DEFAULT 'all'
                       CHECK (company_type IN ('aktiebolag','enskild_firma','all')),
  -- BAS counter-account, or the literal sentinel '__PRIMARY_SEK__'.
  counter_account      TEXT NOT NULL CHECK (length(counter_account) > 0),
  -- Override for enskild_firma when the same rule needs a different account for EF
  -- (e.g. preliminärskatt: AB → 2510, EF → 2012). NULL means use counter_account.
  counter_account_ef   TEXT,
  label                TEXT,
  active               BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_skattekonto_rules_lookup
  ON public.skattekonto_rules (company_id, priority)
  WHERE active = true;

ALTER TABLE public.skattekonto_rules ENABLE ROW LEVEL SECURITY;

-- System seeds are visible to all authenticated users; per-company rules only to
-- members of that company.
CREATE POLICY "skattekonto_rules_select" ON public.skattekonto_rules
  FOR SELECT USING (
    company_id IS NULL
    OR company_id IN (SELECT public.user_company_ids())
  );

-- Writes are scoped to companies the user belongs to. System seeds (company_id IS NULL)
-- cannot be mutated via RLS — the WITH CHECK forces a non-NULL company_id.
CREATE POLICY "skattekonto_rules_insert" ON public.skattekonto_rules
  FOR INSERT WITH CHECK (
    company_id IS NOT NULL
    AND company_id IN (SELECT public.user_company_ids())
  );

CREATE POLICY "skattekonto_rules_update" ON public.skattekonto_rules
  FOR UPDATE USING (
    company_id IS NOT NULL
    AND company_id IN (SELECT public.user_company_ids())
  )
  WITH CHECK (
    company_id IS NOT NULL
    AND company_id IN (SELECT public.user_company_ids())
  );

CREATE POLICY "skattekonto_rules_delete" ON public.skattekonto_rules
  FOR DELETE USING (
    company_id IS NOT NULL
    AND company_id IN (SELECT public.user_company_ids())
  );

CREATE TRIGGER skattekonto_rules_updated_at
  BEFORE UPDATE ON public.skattekonto_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- System seeds
-- ============================================================
--
-- counter_account = '__PRIMARY_SEK__' on the in-/utbetalning rules so the resolver
-- looks up cash_accounts.is_primary = true for SEK rather than assuming 1930.

INSERT INTO public.skattekonto_rules (
  company_id, priority, pattern, company_type, counter_account, counter_account_ef, label
) VALUES
  (NULL, 10, 'inbetalning bokförd,inbetalning,överföring från bank', 'all',
            '__PRIMARY_SEK__', NULL, 'Inbetalning till skattekonto'),
  (NULL, 10, 'utbetalning,återbetalning',                            'all',
            '__PRIMARY_SEK__', NULL, 'Utbetalning från skattekonto'),
  (NULL, 20, 'debiterad preliminärskatt,preliminärskatt,f-skatt,fskatt', 'all',
            '2510', '2012', 'Preliminär skatt'),
  (NULL, 20, 'arbetsgivaravgift,sociala avgifter,agi',                'all',
            '2731', NULL, 'Arbetsgivaravgifter'),
  (NULL, 20, 'avdragen skatt,personalskatt,a-skatt',                  'all',
            '2710', NULL, 'Avdragen skatt anställda'),
  (NULL, 20, 'mervärdesskatt,moms,momsdeklaration',                   'all',
            '2650', NULL, 'Redovisningskonto för moms'),
  (NULL, 25, 'skattetillägg,förseningsavgift',                        'all',
            '6992', NULL, 'Ej avdragsgilla skatteavgifter'),
  (NULL, 30, 'kostnadsränta',                                         'all',
            '8423', NULL, 'Kostnadsränta skattekonto'),
  (NULL, 30, 'intäktsränta',                                          'all',
            '8314', NULL, 'Intäktsränta skattekonto');

NOTIFY pgrst, 'reload schema';
