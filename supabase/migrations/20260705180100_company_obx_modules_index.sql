-- Modular OBX archive: per-year modules and company index (chain + custody)

CREATE TABLE public.company_obx_modules (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fiscal_year     text NOT NULL,
  manifest_hash   text NOT NULL,
  module_type     text NOT NULL DEFAULT 'year-seal'
    CHECK (module_type IN ('year-seal', 'index-seal', 'portability')),
  origin_system   text,
  sealed          boolean NOT NULL DEFAULT false,
  storage_path    text,
  imported_at     timestamptz NOT NULL DEFAULT now(),
  custody_json    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, fiscal_year, manifest_hash)
);

CREATE TABLE public.company_obx_index (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  chain_root        text NOT NULL,
  module_hashes     text[] NOT NULL DEFAULT '{}',
  custody_events    jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_signed_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id)
);

ALTER TABLE public.company_obx_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_obx_index ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company company_obx_modules"
  ON public.company_obx_modules FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company company_obx_modules"
  ON public.company_obx_modules FOR INSERT
  WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company company_obx_modules"
  ON public.company_obx_modules FOR UPDATE
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company company_obx_modules"
  ON public.company_obx_modules FOR DELETE
  USING (company_id IN (SELECT user_company_ids()));

CREATE POLICY "view own-company company_obx_index"
  ON public.company_obx_index FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company company_obx_index"
  ON public.company_obx_index FOR INSERT
  WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company company_obx_index"
  ON public.company_obx_index FOR UPDATE
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company company_obx_index"
  ON public.company_obx_index FOR DELETE
  USING (company_id IN (SELECT user_company_ids()));

CREATE INDEX idx_company_obx_modules_company_id
  ON public.company_obx_modules (company_id);
CREATE INDEX idx_company_obx_modules_fiscal_year
  ON public.company_obx_modules (company_id, fiscal_year);

CREATE INDEX idx_company_obx_index_company_id
  ON public.company_obx_index (company_id);

CREATE TRIGGER set_updated_at_company_obx_modules
  BEFORE UPDATE ON public.company_obx_modules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_updated_at_company_obx_index
  BEFORE UPDATE ON public.company_obx_index
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_company_obx_modules
  AFTER INSERT OR UPDATE OR DELETE ON public.company_obx_modules
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TRIGGER audit_company_obx_index
  AFTER INSERT OR UPDATE OR DELETE ON public.company_obx_index
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

NOTIFY pgrst, 'reload schema';
