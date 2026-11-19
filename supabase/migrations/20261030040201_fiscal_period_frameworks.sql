-- =============================================================================
-- fiscal_period_frameworks: the K2/K3 framework per räkenskapsår
--
-- Until now the framework was one column, companies.accounting_framework, read
-- for every year. A switch therefore rewrote history: a company that moved to
-- K3 in 2026 had its 2025 årsredovisning rebuilt as K3, and nothing stopped a
-- switch on a year whose årsredovisning was already signed.
--
-- BFNAR 2012:4 (consolidated, BFNAR 2016:11):
--   punkt 2: a company may always switch to K3. A company on K3 may switch to
--            K2; särskilda skäl are required if it applied K2 (or BFNAR
--            2008:1 / 2009:1) earlier. Skatteskäl are not särskilda skäl.
--   punkt 3: a switch is a change of accounting principle. A company that
--            switched from K3 to K2 states the reasons in a note.
--
-- One row per fiscal period, kept here rather than as a fiscal_periods column
-- so the closed and locked periods it must describe are never updated (their
-- triggers, the migration-reset guard and the SIE import holds stay out of
-- it). `source` says how reliable the value is:
--   company_default : copied from companies.accounting_framework (this
--                     backfill for a year without a locked årsredovisning, a
--                     year created with no previous year to follow, or one
--                     that followed a year that was itself only a default).
--                     It is what the product used for the year, not proof of
--                     the framework its årsredovisning was prepared under:
--                     the K3 first-year check and the K3 to K2 switch ask the
--                     user instead of relying on it.
--   annual_report   : the framework of the year's latest årsredovisning
--                     version past draft (ready_for_signature, signed, filed,
--                     registered) at the backfill: what the year was prepared
--                     under.
--   previous_year   : copied from the adjacent previous year when that year's
--                     value was reliable (election, annual_report or itself
--                     previous_year), or set by a cascade from an election on
--                     an earlier year.
--   election        : chosen for this year through set_fiscal_period_framework.
--
-- companies.accounting_framework stays as the default for the next new year
-- and for the readers that have not moved to the per-year value yet: the RPC
-- keeps it equal to the latest year's framework. A direct write to it changes
-- no existing year.
--
-- Writes go through set_fiscal_period_framework only (no write policy for
-- authenticated). It refuses K3 for a legal form that cannot carry it, a
-- change on a closed or locked year, on a year whose bookkeeping is locked
-- through its last day, and on a year with an årsredovisning version past
-- draft (ready_for_signature, signed, filed, registered), and enforces the
-- punkt 2-3 rules for K3 to K2 against the previous årsredovisning's
-- framework: from a reliable record, else as the user states it.
-- pg-test: covered-by tests/pg/fiscal-period-frameworks.pg.test.ts
-- =============================================================================

CREATE TABLE public.fiscal_period_frameworks (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id uuid NOT NULL,
  framework text NOT NULL CHECK (framework IN ('k2', 'k3')),
  source text NOT NULL CHECK (source IN ('company_default', 'annual_report', 'previous_year', 'election')),
  -- The framework the year carried before the latest election.
  previous_framework text CHECK (previous_framework IN ('k2', 'k3')),
  -- BFNAR 2012:4 punkt 3: the reasons for a switch from K3 to K2, printed in
  -- a note of the K2 årsredovisning. Cleared when the year goes back to K3.
  change_reason text CHECK (change_reason IS NULL OR length(btrim(change_reason)) BETWEEN 1 AND 2000),
  -- BFNAR 2012:4 punkt 2: whether the company applied a K2 regelverk before,
  -- and the confirmation that the stated reasons are särskilda skäl.
  previously_applied_k2 boolean,
  special_reasons_confirmed boolean,
  -- The framework of the previous årsredovisning as the user stated it at the
  -- latest election, when Accounted holds no reliable record of it (k2, k3,
  -- or none: no previous årsredovisning). Null when the record decided.
  stated_previous_year_framework text CHECK (stated_previous_year_framework IN ('k2', 'k3', 'none')),
  -- Who made the election; null on rows the system wrote.
  user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_period_frameworks_period_key UNIQUE (fiscal_period_id),
  -- The period must be the same company's (fiscal_periods_id_company_id_key).
  CONSTRAINT fiscal_period_frameworks_fiscal_period_fkey
    FOREIGN KEY (fiscal_period_id, company_id)
    REFERENCES public.fiscal_periods (id, company_id) ON DELETE CASCADE,
  CONSTRAINT fiscal_period_frameworks_election_stamped CHECK (
    source <> 'election' OR decided_at IS NOT NULL
  ),
  CONSTRAINT fiscal_period_frameworks_reason_only_on_k2 CHECK (
    change_reason IS NULL OR framework = 'k2'
  ),
  CONSTRAINT fiscal_period_frameworks_special_reasons CHECK (
    change_reason IS NULL
    OR previously_applied_k2 IS NOT TRUE
    OR special_reasons_confirmed IS TRUE
  )
);

COMMENT ON TABLE public.fiscal_period_frameworks IS
  'The K2/K3 framework per räkenskapsår (BFNAR 2012:4). Written by set_fiscal_period_framework and by the fiscal_periods insert trigger; read through lib/company/accounting-framework.ts.';
COMMENT ON COLUMN public.fiscal_period_frameworks.source IS
  'company_default: copied from companies.accounting_framework (not proof of the framework the year was prepared under); annual_report: from the year''s locked årsredovisning version; previous_year: followed a previous year whose value was reliable; election: chosen for this year.';
COMMENT ON COLUMN public.fiscal_period_frameworks.stated_previous_year_framework IS
  'The previous årsredovisning''s framework (k2, k3, none) as the user stated it at the latest election, when no reliable record existed.';
COMMENT ON COLUMN public.fiscal_period_frameworks.change_reason IS
  'BFNAR 2012:4 punkt 3: reasons for a switch from K3 to K2, printed in a note of that year''s K2 årsredovisning.';

CREATE INDEX idx_fiscal_period_frameworks_company ON public.fiscal_period_frameworks (company_id);

ALTER TABLE public.fiscal_period_frameworks ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.fiscal_period_frameworks TO service_role;
GRANT SELECT ON TABLE public.fiscal_period_frameworks TO authenticated;
-- no-grant: anon on public.fiscal_period_frameworks (a company's reporting framework; no public surface reads it)

-- Members read. No write policy: every change goes through
-- set_fiscal_period_framework (SECURITY DEFINER), which applies BFNAR 2012:4.
CREATE POLICY "view own-company fiscal_period_frameworks"
  ON public.fiscal_period_frameworks FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER set_updated_at_fiscal_period_frameworks
  BEFORE UPDATE ON public.fiscal_period_frameworks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- Backfill. A year with an årsredovisning version past draft takes the
-- framework of its latest such version (annual_report): that is what the
-- year was prepared, signed or filed under, whatever the company setting
-- says today. Every other year gets the company's framework, as every reader
-- used until now, marked company_default: not evidence, so the K3 to K2 and
-- first-K3-year checks ask. Inserted before the audit trigger exists: the
-- backfill is the starting state, not a change.
-- =============================================================================

-- The framework a year with no row starts from, and how reliable it is. Used
-- by this backfill and by set_fiscal_period_framework for a year that has no
-- row yet. Internal: not granted to any API role.
CREATE OR REPLACE FUNCTION public.fiscal_period_framework_evidence(p_fiscal_period_id uuid)
RETURNS TABLE (framework text, source text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(locked.framework, c.accounting_framework),
         CASE WHEN locked.framework IS NOT NULL THEN 'annual_report' ELSE 'company_default' END
    FROM public.fiscal_periods fp
    JOIN public.companies c ON c.id = fp.company_id
    LEFT JOIN LATERAL (
      SELECT v.framework
        FROM public.annual_report_versions v
       WHERE v.company_id = fp.company_id
         AND v.fiscal_period_id = fp.id
         AND v.status IN ('ready_for_signature', 'signed', 'filed', 'registered')
       ORDER BY v.version_number DESC, v.created_at DESC
       LIMIT 1
    ) locked ON true
   WHERE fp.id = p_fiscal_period_id
$$;

REVOKE ALL ON FUNCTION public.fiscal_period_framework_evidence(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fiscal_period_framework_evidence(uuid) TO service_role;

INSERT INTO public.fiscal_period_frameworks (company_id, fiscal_period_id, framework, source)
SELECT fp.company_id, fp.id, e.framework, e.source
  FROM public.fiscal_periods fp
  CROSS JOIN LATERAL public.fiscal_period_framework_evidence(fp.id) e
ON CONFLICT (fiscal_period_id) DO NOTHING;

CREATE TRIGGER audit_fiscal_period_frameworks
  AFTER INSERT OR UPDATE OR DELETE ON public.fiscal_period_frameworks
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- A new year follows the year before it (the period ending the day before it
-- starts, or its previous_period_id), else the company default. It is only as
-- reliable as the year it follows: a year that follows a company default is a
-- company default too, so the doubt is never laundered into previous_year.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.seed_fiscal_period_framework()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_previous text;
  v_previous_source text;
  v_default text;
BEGIN
  SELECT f.framework, f.source
    INTO v_previous, v_previous_source
    FROM public.fiscal_period_frameworks f
    JOIN public.fiscal_periods p ON p.id = f.fiscal_period_id
   WHERE p.company_id = NEW.company_id
     AND p.id <> NEW.id
     AND (p.id = NEW.previous_period_id OR p.period_end = NEW.period_start - 1)
   ORDER BY coalesce(p.id = NEW.previous_period_id, false) DESC, p.period_end DESC
   LIMIT 1;

  IF v_previous IS NULL THEN
    SELECT c.accounting_framework INTO v_default
      FROM public.companies c
     WHERE c.id = NEW.company_id;
  END IF;

  INSERT INTO public.fiscal_period_frameworks (company_id, fiscal_period_id, framework, source)
  VALUES (
    NEW.company_id,
    NEW.id,
    coalesce(v_previous, v_default, 'k2'),
    CASE
      WHEN v_previous IS NOT NULL AND v_previous_source <> 'company_default' THEN 'previous_year'
      ELSE 'company_default'
    END
  )
  ON CONFLICT (fiscal_period_id) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_fiscal_period_framework() FROM PUBLIC, anon;

CREATE TRIGGER seed_fiscal_period_framework
  AFTER INSERT ON public.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.seed_fiscal_period_framework();

-- =============================================================================
-- A legal-form correction (correct_company_entity_type, books empty) moves the
-- company's framework with the form. The open years follow it (not closed,
-- not locked, bookkeeping not locked through their last day, no locked
-- årsredovisning: the same years set_fiscal_period_framework may change), so
-- a form that cannot carry K3 never keeps a K3 year. Closed years are history
-- and stay. The row records the user who changed the form (the audit row
-- takes its actor from user_id), and the K3 to K2 election details go with
-- the election they belonged to.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.sync_fiscal_period_frameworks_on_form_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.fiscal_period_frameworks f
     SET framework = NEW.accounting_framework,
         source = 'company_default',
         previous_framework = f.framework,
         change_reason = NULL,
         previously_applied_k2 = NULL,
         special_reasons_confirmed = NULL,
         stated_previous_year_framework = NULL,
         user_id = auth.uid(),
         decided_at = NULL
    FROM public.fiscal_periods p
   WHERE p.id = f.fiscal_period_id
     AND f.company_id = NEW.id
     AND f.framework IS DISTINCT FROM NEW.accounting_framework
     AND NOT coalesce(p.is_closed, false)
     AND p.locked_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.company_settings cs
        WHERE cs.company_id = NEW.id
          AND cs.bookkeeping_locked_through IS NOT NULL
          AND cs.bookkeeping_locked_through >= p.period_end
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.annual_report_versions v
        WHERE v.fiscal_period_id = p.id
          AND v.status IN ('ready_for_signature', 'signed', 'filed', 'registered')
     );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_fiscal_period_frameworks_on_form_change() FROM PUBLIC, anon;

CREATE TRIGGER sync_fiscal_period_frameworks_on_form_change
  AFTER UPDATE OF entity_type ON public.companies
  FOR EACH ROW
  WHEN (OLD.entity_type IS DISTINCT FROM NEW.entity_type)
  EXECUTE FUNCTION public.sync_fiscal_period_frameworks_on_form_change();

-- =============================================================================
-- set_fiscal_period_framework(): the one write path.
--
-- Returns jsonb { ok, code?, changed, framework, fiscal_period_id,
-- cascaded_period_ids, company_framework }. Refusals are codes the API maps to
-- Swedish messages (lib/company/accounting-framework-change.ts):
--   FRAMEWORK_FORBIDDEN            caller is not owner or admin
--   FRAMEWORK_INVALID              framework not k2/k3, or a stated previous
--                                  framework that is not k2/k3 (none only
--                                  when Accounted holds no previous year)
--   FRAMEWORK_FORM_UNSUPPORTED     K3 for a legal form that cannot carry it
--                                  (an aktiebolag or a bostadsrättsförening,
--                                  as the legal-form profiles in
--                                  lib/company/forms say)
--   FRAMEWORK_K2_NOT_ALLOWED       K2 for a bostadsrättsförening in a year
--                                  BFNAR 2025:2 applies to (K2 punkt 1.1 A e)
--   FRAMEWORK_PERIOD_NOT_FOUND     period missing or another company's
--   FRAMEWORK_PERIOD_CLOSED        closed, locked, or bookkeeping locked
--                                  through the year's last day
--   FRAMEWORK_REPORT_LOCKED        an årsredovisning version past draft
--   FRAMEWORK_PREVIOUS_YEAR_UNKNOWN  a year leaving K3 for K2 while the
--                                  previous årsredovisning's framework is not
--                                  on a reliable record and not stated
--   FRAMEWORK_REASON_REQUIRED      K3 to K2 without stated reasons
--   FRAMEWORK_PREVIOUS_K2_UNKNOWN  K3 to K2 and it is not known whether the
--                                  company applied K2 before
--   FRAMEWORK_SPECIAL_REASONS_REQUIRED  K3 to K2 after earlier K2 without the
--                                  confirmation that the reasons are
--                                  särskilda skäl (not tax reasons)
--
-- A switch is K3 to K2 when the year moves to K2 and the previous
-- årsredovisning was prepared under K3 (BFNAR 2012:4 punkt 2-3: a switch is
-- between years). That framework comes from the previous year's row when the
-- row is reliable (election, annual_report, previous_year). A company default
-- is not evidence (a company that filed K2 and later set K3 in the settings
-- would otherwise be told it leaves K3), so then the caller states it
-- (p_previous_year_framework: k2, k3, or none for no previous
-- årsredovisning); a year leaving K3 for K2 without either is refused. A year
-- already on K2 with no reliable previous record is not judged a switch.
-- Whether the company applied K2 before: true when an earlier year here was
-- K2 on a reliable record, else the caller's answer.
--
-- An election cascades to the later years that only followed (not elected,
-- open, no locked årsredovisning), in order, stopping at the first that may
-- not change. p_dry_run checks everything and writes nothing.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.set_fiscal_period_framework(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_framework text,
  p_change_reason text DEFAULT NULL,
  p_previously_applied_k2 boolean DEFAULT NULL,
  p_special_reasons_confirmed boolean DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_dry_run boolean DEFAULT false,
  p_previous_year_framework text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_period public.fiscal_periods%ROWTYPE;
  v_row public.fiscal_period_frameworks%ROWTYPE;
  v_locked_through date;
  v_previous_year text;
  v_previous_source text;
  v_previous_found boolean := false;
  v_previous_basis text;
  v_stated text;
  v_entity_type text;
  v_is_k3_to_k2 boolean;
  v_earlier_k2 boolean;
  v_previously_applied_k2 boolean;
  v_reason text := nullif(btrim(coalesce(p_change_reason, '')), '');
  v_cascaded uuid[] := ARRAY[]::uuid[];
  v_later record;
  v_latest text;
BEGIN
  IF auth.role() = 'service_role' THEN
    v_actor := p_user_id;
  ELSE
    v_actor := auth.uid();
    IF v_actor IS NULL OR NOT public.user_is_company_admin(p_company_id) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FRAMEWORK_FORBIDDEN');
    END IF;
  END IF;

  IF p_framework IS NULL OR p_framework NOT IN ('k2', 'k3') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FRAMEWORK_INVALID');
  END IF;
  IF p_previous_year_framework IS NOT NULL AND p_previous_year_framework NOT IN ('k2', 'k3', 'none') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FRAMEWORK_INVALID');
  END IF;

  -- The forms that prepare an årsredovisning under K3 here, as the legal-form
  -- profiles say (lib/company/forms: frameworks): an aktiebolag, and a
  -- bostadsrättsförening, which reports under K3 (BFNAR 2016:10 punkt 1.1 A e
  -- as amended by BFNAR 2025:2; the form arrives with !914 and its migration
  -- widens the companies.entity_type CHECK, so until then it cannot occur).
  -- The TypeScript doors check the same, but the function is granted to
  -- authenticated, so the rule lives here too
  -- (tests/pg/fiscal-period-frameworks.pg.test.ts holds the two together).
  SELECT c.entity_type INTO v_entity_type FROM public.companies c WHERE c.id = p_company_id;
  IF p_framework = 'k3' AND v_entity_type IS DISTINCT FROM 'aktiebolag'
     AND v_entity_type IS DISTINCT FROM 'bostadsrattsforening' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FRAMEWORK_FORM_UNSUPPORTED');
  END IF;

  -- One change per company at a time: the cascade and the company default
  -- read the other years.
  PERFORM pg_advisory_xact_lock(hashtextextended('fiscal_period_frameworks:' || p_company_id::text, 0));

  SELECT * INTO v_period
    FROM public.fiscal_periods
   WHERE id = p_fiscal_period_id
     AND company_id = p_company_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FRAMEWORK_PERIOD_NOT_FOUND');
  END IF;

  -- A bostadsrättsförening may not apply K2 (BFNAR 2016:10 punkt 1.1 A e)
  -- for a year BFNAR 2025:2 applies to: one that starts after 2025-12-31,
  -- or a first, extended year that starts after 2025-06-30 and ends on
  -- 2026-12-31 or later (its övergångsbestämmelse 1; the same test as
  -- usesNewK2Restrictions in lib/bokslut/arsredovisning/eligibility.ts).
  -- An earlier year was free to use K2.
  IF p_framework = 'k2' AND v_entity_type = 'bostadsrattsforening'
     AND (v_period.period_start > DATE '2025-12-31'
          OR (v_period.period_start > DATE '2025-06-30' AND v_period.period_end >= DATE '2026-12-31')) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FRAMEWORK_K2_NOT_ALLOWED');
  END IF;

  SELECT bookkeeping_locked_through INTO v_locked_through
    FROM public.company_settings
   WHERE company_id = p_company_id;
  IF coalesce(v_period.is_closed, false)
     OR v_period.locked_at IS NOT NULL
     OR (v_locked_through IS NOT NULL AND v_locked_through >= v_period.period_end) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FRAMEWORK_PERIOD_CLOSED');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.annual_report_versions v
     WHERE v.company_id = p_company_id
       AND v.fiscal_period_id = p_fiscal_period_id
       AND v.status IN ('ready_for_signature', 'signed', 'filed', 'registered')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FRAMEWORK_REPORT_LOCKED');
  END IF;

  SELECT * INTO v_row
    FROM public.fiscal_period_frameworks
   WHERE fiscal_period_id = p_fiscal_period_id
   FOR UPDATE;
  IF NOT FOUND THEN
    -- A period created before the seed trigger existed in this database
    -- (never on a replayed history): start it as the backfill would.
    INSERT INTO public.fiscal_period_frameworks (company_id, fiscal_period_id, framework, source)
    SELECT p_company_id, p_fiscal_period_id, e.framework, e.source
      FROM public.fiscal_period_framework_evidence(p_fiscal_period_id) e
    RETURNING * INTO v_row;
  END IF;

  SELECT f.framework, f.source INTO v_previous_year, v_previous_source
    FROM public.fiscal_period_frameworks f
    JOIN public.fiscal_periods p ON p.id = f.fiscal_period_id
   WHERE p.company_id = p_company_id
     AND p.id <> p_fiscal_period_id
     AND (p.id = v_period.previous_period_id OR p.period_end = v_period.period_start - 1)
   ORDER BY coalesce(p.id = v_period.previous_period_id, false) DESC, p.period_end DESC
   LIMIT 1;
  v_previous_found := FOUND;

  -- The previous årsredovisning's framework, for a year moving to K2.
  IF p_framework = 'k2' THEN
    IF v_previous_found AND v_previous_source IN ('election', 'annual_report', 'previous_year') THEN
      v_previous_basis := v_previous_year;
    ELSIF p_previous_year_framework IS NOT NULL THEN
      -- "No previous årsredovisning" contradicts a previous year in the books.
      IF p_previous_year_framework = 'none' AND v_previous_found THEN
        RETURN jsonb_build_object('ok', false, 'code', 'FRAMEWORK_INVALID');
      END IF;
      v_stated := p_previous_year_framework;
      v_previous_basis := p_previous_year_framework;
    ELSIF v_row.framework = 'k3' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FRAMEWORK_PREVIOUS_YEAR_UNKNOWN');
    END IF;
  END IF;

  v_is_k3_to_k2 := p_framework = 'k2' AND coalesce(v_previous_basis = 'k3', false);

  IF v_is_k3_to_k2 THEN
    IF v_reason IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FRAMEWORK_REASON_REQUIRED');
    END IF;
    SELECT EXISTS (
      SELECT 1
        FROM public.fiscal_period_frameworks f
        JOIN public.fiscal_periods p ON p.id = f.fiscal_period_id
       WHERE p.company_id = p_company_id
         AND p.period_start < v_period.period_start
         AND f.framework = 'k2'
         AND f.source IN ('election', 'annual_report', 'previous_year')
    ) INTO v_earlier_k2;
    v_previously_applied_k2 := CASE WHEN v_earlier_k2 THEN true ELSE p_previously_applied_k2 END;
    IF v_previously_applied_k2 IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FRAMEWORK_PREVIOUS_K2_UNKNOWN');
    END IF;
    IF v_previously_applied_k2 AND p_special_reasons_confirmed IS NOT TRUE THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FRAMEWORK_SPECIAL_REASONS_REQUIRED');
    END IF;
  END IF;

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'ok', true,
      'dry_run', true,
      'changed', v_row.framework IS DISTINCT FROM p_framework OR v_row.source <> 'election',
      'framework', p_framework,
      'previous_framework', v_row.framework,
      'previous_year_framework', v_previous_year,
      'previous_year_basis', v_previous_basis,
      'k3_to_k2', v_is_k3_to_k2,
      'fiscal_period_id', p_fiscal_period_id
    );
  END IF;

  UPDATE public.fiscal_period_frameworks
     SET framework = p_framework,
         source = 'election',
         previous_framework = v_row.framework,
         change_reason = CASE WHEN v_is_k3_to_k2 THEN v_reason ELSE NULL END,
         previously_applied_k2 = CASE WHEN v_is_k3_to_k2 THEN v_previously_applied_k2 ELSE NULL END,
         special_reasons_confirmed = CASE WHEN v_is_k3_to_k2 THEN coalesce(p_special_reasons_confirmed, false) ELSE NULL END,
         stated_previous_year_framework = v_stated,
         user_id = v_actor,
         decided_at = now()
   WHERE id = v_row.id;

  -- Later years that only followed move with this one, in order, until one
  -- was elected or may not change any more.
  FOR v_later IN
    SELECT p.id AS period_id, p.is_closed, p.locked_at, p.period_end, f.id AS row_id, f.source, f.framework
      FROM public.fiscal_periods p
      JOIN public.fiscal_period_frameworks f ON f.fiscal_period_id = p.id
     WHERE p.company_id = p_company_id
       AND p.period_start > v_period.period_start
     ORDER BY p.period_start
  LOOP
    EXIT WHEN v_later.source = 'election'
      OR coalesce(v_later.is_closed, false)
      OR v_later.locked_at IS NOT NULL
      OR (v_locked_through IS NOT NULL AND v_locked_through >= v_later.period_end)
      OR EXISTS (
        SELECT 1 FROM public.annual_report_versions v
         WHERE v.fiscal_period_id = v_later.period_id
           AND v.status IN ('ready_for_signature', 'signed', 'filed', 'registered')
      );
    IF v_later.framework IS DISTINCT FROM p_framework THEN
      UPDATE public.fiscal_period_frameworks
         SET framework = p_framework,
             source = 'previous_year',
             previous_framework = v_later.framework,
             change_reason = NULL,
             previously_applied_k2 = NULL,
             special_reasons_confirmed = NULL,
             stated_previous_year_framework = NULL,
             user_id = v_actor
       WHERE id = v_later.row_id;
      v_cascaded := v_cascaded || v_later.period_id;
    END IF;
  END LOOP;

  -- The default for the next new year, and for the readers still on the
  -- company column: the latest year's framework.
  SELECT f.framework INTO v_latest
    FROM public.fiscal_period_frameworks f
    JOIN public.fiscal_periods p ON p.id = f.fiscal_period_id
   WHERE p.company_id = p_company_id
   ORDER BY p.period_start DESC
   LIMIT 1;
  UPDATE public.companies
     SET accounting_framework = v_latest
   WHERE id = p_company_id
     AND accounting_framework IS DISTINCT FROM v_latest;

  RETURN jsonb_build_object(
    'ok', true,
    'changed', v_row.framework IS DISTINCT FROM p_framework,
    'framework', p_framework,
    'previous_framework', v_row.framework,
    'previous_year_framework', v_previous_year,
    'previous_year_basis', v_previous_basis,
    'k3_to_k2', v_is_k3_to_k2,
    'fiscal_period_id', p_fiscal_period_id,
    'cascaded_period_ids', to_jsonb(v_cascaded),
    'company_framework', v_latest
  );
END;
$$;

COMMENT ON FUNCTION public.set_fiscal_period_framework(uuid, uuid, text, text, boolean, boolean, uuid, boolean, text) IS
  'Sets the K2/K3 framework of one räkenskapsår under BFNAR 2012:4 and cascades to later years that only followed. Owner/admin or service role.';

REVOKE ALL ON FUNCTION public.set_fiscal_period_framework(uuid, uuid, text, text, boolean, boolean, uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_fiscal_period_framework(uuid, uuid, text, text, boolean, boolean, uuid, boolean, text)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
