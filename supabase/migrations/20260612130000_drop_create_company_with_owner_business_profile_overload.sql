-- Migration: drop the rogue create_company_with_owner(...p_business_profile)
-- overload that reintroduced PGRST203 ambiguity.
--
-- Background: the canonical signature (per 20260519180000_enforce_team_
-- membership_in_create_company.sql) is the 4-arg form:
--   create_company_with_owner(p_name text, p_entity_type text,
--                             p_set_active boolean DEFAULT true,
--                             p_team_id uuid DEFAULT NULL)
--
-- A 5-arg variant with a trailing `p_business_profile text` was created on
-- some database(s) outside the tracked migrations. A CREATE OR REPLACE with a
-- changed signature creates a *second* function rather than replacing it --
-- the exact failure mode fixed once before in
-- 20260519170000_fix_create_company_with_owner_overload.sql. Because both
-- overloads are callable with the three named args the app passes (p_name,
-- p_entity_type, p_team_id -- p_set_active and p_business_profile both have
-- defaults), PostgREST cannot resolve the call and returns PGRST203, breaking
-- company creation:
--   "Could not choose the best candidate function between:
--      create_company_with_owner(p_name, p_entity_type, p_set_active, p_team_id)
--      create_company_with_owner(p_name, p_entity_type, p_set_active, p_team_id, p_business_profile)"
--
-- `business_profile` is not referenced anywhere in the codebase, so the 5-arg
-- overload is dropped outright. IF EXISTS keeps this a safe no-op on databases
-- that never acquired the orphan (e.g. production, which has only the 4-arg
-- form).

DROP FUNCTION IF EXISTS public.create_company_with_owner(text, text, boolean, uuid, text);

NOTIFY pgrst, 'reload schema';
