-- Dimensions PR10 (advanced): per-account dimension policy.
--
--   account_dimension_rules — one rule per (account, dimension):
--     'required'  the account cannot be POSTED without a value for the
--                 dimension (enforced TS-side at commitEntry + the bulk-book
--                 route pre-check; drafts may be incomplete)
--     'default'   the value is pre-applied to the line's bag at draft
--                 creation when the key is absent (user-overridable)
--     'fixed'     the value is ALWAYS applied at draft creation (overwrites
--                 whatever the caller sent for that key)
--
-- Opt-in by construction: zero rows (every company's default) = the engine
-- behaves exactly as before. There is deliberately NO settings toggle for
-- enforcement — a rule that exists but is silently ignored is worse than
-- either extreme; pausing one rule is what is_active is for.
--
-- Shape follows the dimensions registry (20260702084500): company_id-native,
-- no user_id (rules are company policy, not personal data), RLS via
-- user_company_ids(). value_id's dimension/company consistency is validated
-- at the API layer (and re-checked by engine-side registry validation at
-- booking); a composite FK is deliberately skipped — dimension_values has no
-- (id, dimension_id) unique pair and adding one for this is not worth the
-- churn.
--
-- pg-test: tests/pg/account-dimension-rules.pg.test.ts (RLS + CHECKs +
-- cascade behavior).

CREATE TABLE public.account_dimension_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Exact BAS account; ranges can layer on later without schema change.
  account_number text NOT NULL CHECK (account_number ~ '^[0-9]{4}$'),
  dimension_id   uuid NOT NULL,
  rule_type      text NOT NULL CHECK (rule_type IN ('required', 'default', 'fixed')),
  -- required → no value; default/fixed → the value to apply.
  value_id       uuid REFERENCES public.dimension_values(id) ON DELETE CASCADE,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- Composite FK: the dimension must belong to the same company (the
  -- registry's UNIQUE (id, company_id) exists exactly for this pattern).
  FOREIGN KEY (dimension_id, company_id)
    REFERENCES public.dimensions(id, company_id) ON DELETE CASCADE,
  -- One rule per (account, dimension) — 'required'+'default' combos et al.
  -- are a later refinement; three clean types for v1.
  UNIQUE (company_id, account_number, dimension_id),
  CONSTRAINT adr_value_presence CHECK (
    (rule_type = 'required' AND value_id IS NULL)
    OR (rule_type IN ('default', 'fixed') AND value_id IS NOT NULL)
  )
);

ALTER TABLE public.account_dimension_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company account_dimension_rules"
  ON public.account_dimension_rules FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company account_dimension_rules"
  ON public.account_dimension_rules FOR INSERT
  WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company account_dimension_rules"
  ON public.account_dimension_rules FOR UPDATE
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company account_dimension_rules"
  ON public.account_dimension_rules FOR DELETE
  USING (company_id IN (SELECT user_company_ids()));

CREATE INDEX idx_adr_company_account
  ON public.account_dimension_rules (company_id, account_number);

CREATE TRIGGER set_updated_at_account_dimension_rules
  BEFORE UPDATE ON public.account_dimension_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_account_dimension_rules
  AFTER INSERT OR UPDATE OR DELETE ON public.account_dimension_rules
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

COMMENT ON TABLE public.account_dimension_rules IS
  'Per-account dimension policy (dimensions PR10): required blocks posting without a value (TS-side, commitEntry), default pre-fills, fixed always applies. Zero rows = no behavior change.';

NOTIFY pgrst, 'reload schema';
