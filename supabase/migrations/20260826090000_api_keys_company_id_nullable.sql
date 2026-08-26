-- Migration: api_keys.company_id becomes nullable
--
-- Agent-first onboarding (#1814): a key minted from the OAuth popup before
-- the user's first company exists is stored unbound (company_id NULL) and
-- bound lazily by validateApiKey once a company exists. The column was made
-- NOT NULL by the dynamic loop in 20260330130000_multi_tenant_company_refactor
-- (line ~250 sets NOT NULL for every table in its list, api_keys included),
-- which nothing exercised until the companyless flow: the token endpoint's
-- insert violated it and every fresh Claude.ai authorization died with a 500
-- ("Authorization with Accounted failed", 2026-08-26).
--
-- Consumers already handle NULL: validateApiKey returns companyId
-- string|null, the MCP dispatcher answers NO_COMPANY_YET for company-scoped
-- tools on an unbound key, and /api/events fails closed.

ALTER TABLE public.api_keys ALTER COLUMN company_id DROP NOT NULL;
