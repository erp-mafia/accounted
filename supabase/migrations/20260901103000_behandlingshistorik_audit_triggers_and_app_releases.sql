-- Behandlingshistorik, part 3 (BFL 5 kap. 11 §, BFNAR 2013:2 punkt 9.16 andra
-- stycket): "förändringar i bokföringssystemet som påverkar bokföringsposternas
-- behandling samt när dessa förändringar infördes". BFN's commentary names
-- behandlingsregler (automatkonteringar, fasta procentsatser) and new program
-- versions as the examples. Until now the rule/template tables and the
-- statutory payroll constants changed without a trace, and software versions
-- had no history at all.
--
-- 1. write_audit_log() triggers on the behandlingsregler tables and the
--    import logs. The trigger derives user_id/company_id from the row itself
--    (NULL company_id for the global salary_payroll_config: those rows are
--    read through the service role by the behandlingshistorik report).
--    categorization_templates learn on every booking (occurrence_count,
--    confidence, last_seen_date): those telemetry-only updates are excluded
--    the same way api_keys request counters are (20260721115701), so only
--    rule changes (accounts, VAT, pattern, active flag) are logged.
-- 2. app_releases: append-only log of program versions seen in production,
--    written by the runtime the first time a build answers a request
--    (lib/reports/app-releases.ts). Readable by every authenticated user
--    (it is not company data), writable only by the service role.
--
-- pg-test: tests/pg/behandlingshistorik-audit-triggers.pg.test.ts

-- ── 1. Audit triggers ─────────────────────────────────────────────────────────

CREATE TRIGGER audit_mapping_rules
  AFTER INSERT OR UPDATE OR DELETE ON public.mapping_rules
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TRIGGER audit_booking_template_library
  AFTER INSERT OR UPDATE OR DELETE ON public.booking_template_library
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TRIGGER audit_categorization_templates
  AFTER INSERT OR DELETE ON public.categorization_templates
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TRIGGER audit_categorization_templates_update
  AFTER UPDATE ON public.categorization_templates
  FOR EACH ROW
  WHEN (
    (to_jsonb(OLD) - ARRAY[
      'occurrence_count',
      'confidence',
      'last_seen_date',
      'updated_at'
    ]::text[])
    IS DISTINCT FROM
    (to_jsonb(NEW) - ARRAY[
      'occurrence_count',
      'confidence',
      'last_seen_date',
      'updated_at'
    ]::text[])
  )
  EXECUTE FUNCTION public.write_audit_log();

CREATE TRIGGER audit_salary_payroll_config
  AFTER INSERT OR UPDATE OR DELETE ON public.salary_payroll_config
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TRIGGER audit_sie_imports
  AFTER INSERT OR UPDATE OR DELETE ON public.sie_imports
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TRIGGER audit_bank_file_imports
  AFTER INSERT OR UPDATE OR DELETE ON public.bank_file_imports
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- ── 2. Program version log ────────────────────────────────────────────────────

CREATE TABLE public.app_releases (
  version       text PRIMARY KEY,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  source        text NOT NULL DEFAULT 'runtime'
);

COMMENT ON TABLE public.app_releases IS
  'Program versions (build ids) observed in production and when they were first seen. Behandlingshistorik input per BFNAR 2013:2 p. 9.16: "nya programversioner" are system changes that must be dated. Append-only; written by the runtime via the service role (lib/reports/app-releases.ts).';

ALTER TABLE public.app_releases ENABLE ROW LEVEL SECURITY;

-- Not company data: every signed-in user may read it (it feeds every
-- company's behandlingshistorik). No INSERT/UPDATE/DELETE policy: only the
-- service role writes, and the immutability trigger stops edits even there.
CREATE POLICY app_releases_select ON public.app_releases
  FOR SELECT TO authenticated USING (true);

CREATE TRIGGER app_releases_immutable
  BEFORE UPDATE OR DELETE ON public.app_releases
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_immutable();

NOTIFY pgrst, 'reload schema';
