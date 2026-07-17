-- OBX trust registry (ADR 014): hash attestations without storing sealed payload

CREATE TABLE public.company_obx_registry (
  id                      uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id              uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id                 uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fiscal_year             text NOT NULL,
  manifest_hash           text NOT NULL,
  inner_manifest_hash     text,
  chain_root              text,
  org_number              text,
  origin_system           text,
  custody_json            jsonb NOT NULL DEFAULT '[]'::jsonb,
  published_at            timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, fiscal_year, manifest_hash)
);

ALTER TABLE public.company_obx_registry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company company_obx_registry"
  ON public.company_obx_registry FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company company_obx_registry"
  ON public.company_obx_registry FOR INSERT
  WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company company_obx_registry"
  ON public.company_obx_registry FOR UPDATE
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company company_obx_registry"
  ON public.company_obx_registry FOR DELETE
  USING (company_id IN (SELECT user_company_ids()));

CREATE INDEX idx_company_obx_registry_company_id
  ON public.company_obx_registry (company_id);
CREATE INDEX idx_company_obx_registry_manifest_hash
  ON public.company_obx_registry (manifest_hash);
CREATE INDEX idx_company_obx_registry_inner_hash
  ON public.company_obx_registry (inner_manifest_hash)
  WHERE inner_manifest_hash IS NOT NULL;

CREATE TRIGGER set_updated_at_company_obx_registry
  BEFORE UPDATE ON public.company_obx_registry
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_company_obx_registry
  AFTER INSERT OR UPDATE OR DELETE ON public.company_obx_registry
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

NOTIFY pgrst, 'reload schema';
