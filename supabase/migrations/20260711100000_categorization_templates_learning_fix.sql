-- Migration: make categorization_templates writable again (counterparty
-- template learning has been dead since the multi-tenant refactor).
--
-- 20260330130000 re-scoped this table from user_id to company_id and the
-- insert path (lib/bookkeeping/counterparty-templates.ts) stopped writing
-- user_id, but the column kept its NOT NULL: the refactor relaxed user_id on
-- audit_log and company_settings but not here. Every template INSERT since
-- 2026-03-30 failed with a null violation that supabase-js returns rather
-- than throws, so nothing was logged and the learning loop silently died
-- (prod evidence: 750 SIE imports since the refactor, zero new templates).
ALTER TABLE public.categorization_templates
  ALTER COLUMN user_id DROP NOT NULL;

-- The user_id indexes serve no query anymore: every read filters company_id,
-- and UNIQUE (company_id, counterparty_name) already provides the
-- company-scoped lookup path. Replace the stale active-lookup index with a
-- company-scoped one (matches the .eq(company_id).eq(is_active) reads).
DROP INDEX IF EXISTS public.idx_categorization_templates_user_id;
DROP INDEX IF EXISTS public.idx_categorization_templates_counterparty;
DROP INDEX IF EXISTS public.idx_categorization_templates_active;
CREATE INDEX IF NOT EXISTS idx_categorization_templates_company_active
  ON public.categorization_templates (company_id, is_active)
  WHERE is_active = true;

NOTIFY pgrst, 'reload schema';
