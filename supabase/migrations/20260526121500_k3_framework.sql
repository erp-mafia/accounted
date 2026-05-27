-- Add accounting_framework to companies.
--
-- Swedish AB can apply either K2 (BFNAR 2016:10, simplified ruleset for
-- mindre företag) or K3 (BFNAR 2012:1, full principles-based). K2 is the
-- default and what most of our customers use. K3 becomes mandatory when the
-- company crosses any two of the three K2 thresholds (turnover >80 MSEK,
-- assets >40 MSEK, employees >50) and is permitted earlier on a voluntary
-- basis. The choice has substantial downstream effects (component
-- depreciation, latent tax recognition, cash flow statement, more noter).
--
-- Only meaningful for entity_type='aktiebolag'. Enskild firma stays on the
-- simpler EF rules and does not consume this column. The application keeps
-- the K3 settings UI hidden for EF entities.
--
-- Default 'k2' so existing AB rows keep the current behavior (the engine and
-- arsredovisning builder were written against K2 assumptions). Switching
-- K2 → K3 is a deliberate user action gated by a confirmation dialog.

ALTER TABLE public.companies
  ADD COLUMN accounting_framework TEXT NOT NULL DEFAULT 'k2'
    CHECK (accounting_framework IN ('k2', 'k3'));

COMMENT ON COLUMN public.companies.accounting_framework IS
  'Swedish accounting framework. K2 (BFNAR 2016:10) is the simplified ruleset for small AB and the default. K3 (BFNAR 2012:1) is required for medium-to-large AB and required-when-larger-than-K2-thresholds. Only meaningful for entity_type=aktiebolag.';

NOTIFY pgrst, 'reload schema';
