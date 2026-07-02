-- Dimensions substrate (PR1 of the dimensions plan — dev_docs/dimensions_implementation_plan.md)
--
-- Adds the SIE-native dimension registry (dimensions = #DIM/#UNDERDIM,
-- dimension_values = #OBJEKT) and the single-source-of-truth `dimensions jsonb`
-- map on journal_entry_lines ({"1":"KS01","6":"P001"}, keyed by SIE dimension
-- number). The legacy free-text journal_entry_lines.cost_center / .project
-- columns become deterministic mirrors of keys '1'/'6', kept in sync by
-- lib/bookkeeping/dimension-resolver.ts during the dual-write window (they are
-- demoted to GENERATED columns in a later migration, per the plan).
--
-- Registry tables are born company_id-native with NO user_id column. This is a
-- deliberate deviation from the legacy new-table template: it finishes the
-- user_id -> company_id lift for this domain (dev_docs/dimensions_architecture.md
-- §3.8). write_audit_log() reads user_id via to_jsonb() and tolerates its absence.
--
-- Corrective note: the comment in 20240101000011_alter_existing_tables.sql:66-68
-- claiming cost_center_id/project_id UUID FK columns + indexes exist was never
-- true — no such columns were ever created. This migration is the real
-- referential structure for dimensions.

-- =============================================================================
-- 1. dimensions (= SIE #DIM / #UNDERDIM registry)
-- =============================================================================
CREATE TABLE public.dimensions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Byrå/firm-shared taxonomy axis. Bare nullable column by design (SHAPE
  -- decision: never NOT NULL); the FK to firms(id) is wired when firms lands.
  firm_id           uuid NULL,
  sie_dim_no        int  NOT NULL CHECK (sie_dim_no >= 1),
  -- #UNDERDIM parent (e.g. kostnadsbärare 2 -> kostnadsställe 1)
  parent_sie_dim_no int  NULL CHECK (parent_sie_dim_no IS NULL OR parent_sie_dim_no <> sie_dim_no),
  name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  -- SIE asymmetry as data: dim 1 balances reset each fiscal year, dim 6 accumulates
  resets_annually   boolean NOT NULL DEFAULT true,
  -- Seeded dims 1 & 6: undeletable, number immutable (enforced by trigger below)
  is_system         boolean NOT NULL DEFAULT false,
  is_active         boolean NOT NULL DEFAULT true,
  sort_order        int  NOT NULL DEFAULT 100,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  UNIQUE (company_id, sie_dim_no),
  -- Composite key target so dimension_values can FK on (dimension_id, company_id)
  -- and cross-company value rows are impossible by construction.
  UNIQUE (id, company_id)
);

ALTER TABLE public.dimensions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company dimensions"
  ON public.dimensions FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "insert own-company dimensions"
  ON public.dimensions FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "update own-company dimensions"
  ON public.dimensions FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "delete own-company dimensions"
  ON public.dimensions FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE INDEX idx_dimensions_company_id ON public.dimensions (company_id);

COMMENT ON COLUMN public.dimensions.resets_annually IS
  'SIE4 balance semantics: true = flow-period dimension whose balances reset each fiscal year (dim 1 kostnadsställe — must NOT carry #IB/#OIB opening balances on export); false = accumulating dimension spanning years (dim 6 projekt). The SIE export/import path (PR2+) must honour this; it is data, not enforcement.';

CREATE TRIGGER dimensions_updated_at
  BEFORE UPDATE ON public.dimensions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_dimensions
  AFTER INSERT OR UPDATE OR DELETE ON public.dimensions
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 2. dimension_values (= SIE #OBJEKT)
-- =============================================================================
CREATE TABLE public.dimension_values (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  dimension_id    uuid NOT NULL,
  -- Object code as written into journal_entry_lines.dimensions and SIE #OBJEKT.
  -- DB bound is deliberately loose (only chars that break SIE field framing are
  -- forbidden) so legacy free-text survives the backfill; the strict Fortnox
  -- format (^[A-Za-z0-9ÅÄÖåäö_+\-]{1,20}$) is enforced at the API layer for
  -- user-created codes.
  code            text NOT NULL CHECK (char_length(code) BETWEEN 1 AND 40 AND code !~ '["{}]'),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  parent_value_id uuid NULL REFERENCES public.dimension_values(id) ON DELETE SET NULL,
  -- Inactivate, never delete, once referenced by a posted line (trigger below).
  is_active       boolean NOT NULL DEFAULT true,
  start_date      date NULL,
  end_date        date NULL,
  attributes      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (company_id, dimension_id, code),
  -- Same-company integrity by construction (see dimensions UNIQUE (id, company_id))
  FOREIGN KEY (dimension_id, company_id)
    REFERENCES public.dimensions (id, company_id) ON DELETE CASCADE
);

ALTER TABLE public.dimension_values ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company dimension_values"
  ON public.dimension_values FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "insert own-company dimension_values"
  ON public.dimension_values FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "update own-company dimension_values"
  ON public.dimension_values FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "delete own-company dimension_values"
  ON public.dimension_values FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE INDEX idx_dimension_values_company_id ON public.dimension_values (company_id);
CREATE INDEX idx_dimension_values_dimension_id ON public.dimension_values (dimension_id);

CREATE TRIGGER dimension_values_updated_at
  BEFORE UPDATE ON public.dimension_values
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_dimension_values
  AFTER INSERT OR UPDATE OR DELETE ON public.dimension_values
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 3. Registry guard triggers
-- =============================================================================

-- 3a. dimensions: system dims are undeletable; sie_dim_no is immutable (it is
-- the key used inside journal_entry_lines.dimensions — renumbering would
-- silently orphan every tagged line); is_system cannot be flipped; a dimension
-- whose number is referenced by any posted/reversed line cannot be deleted.
CREATE OR REPLACE FUNCTION public.enforce_dimension_registry_guards()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.sie_dim_no <> OLD.sie_dim_no THEN
      RAISE EXCEPTION 'Dimensionsnumret kan inte ändras (rader är taggade med numret).';
    END IF;
    IF NEW.is_system <> OLD.is_system THEN
      RAISE EXCEPTION 'is_system kan inte ändras.';
    END IF;
    RETURN NEW;
  END IF;

  -- DELETE
  IF OLD.is_system THEN
    RAISE EXCEPTION 'Systemdimensionen % (%) kan inte tas bort — avaktivera den istället.',
      OLD.sie_dim_no, OLD.name;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.journal_entries je
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
    WHERE je.company_id = OLD.company_id
      AND je.status IN ('posted', 'reversed')
      AND jel.dimensions ? OLD.sie_dim_no::text
  ) THEN
    RAISE EXCEPTION 'Dimensionen % (%) används på bokförda verifikat och kan inte tas bort — avaktivera den istället.',
      OLD.sie_dim_no, OLD.name;
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER enforce_dimension_registry_guards
  BEFORE UPDATE OR DELETE ON public.dimensions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_dimension_registry_guards();

-- 3b. dimension_values: a code referenced by any posted/reversed line cannot be
-- deleted (BFL 7-year philosophy / Fortnox "Avslutat") — inactivate instead.
-- Fires on direct DELETE and on cascade from dimensions.
CREATE OR REPLACE FUNCTION public.enforce_dimension_value_retention()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_dim_no int;
BEGIN
  SELECT d.sie_dim_no INTO v_dim_no
  FROM public.dimensions d
  WHERE d.id = OLD.dimension_id;

  IF v_dim_no IS NULL THEN
    -- Parent dimension row already gone (same-statement cascade edge) — nothing
    -- left to validate against.
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.journal_entries je
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
    WHERE je.company_id = OLD.company_id
      AND je.status IN ('posted', 'reversed')
      AND jel.dimensions ->> v_dim_no::text = OLD.code
  ) THEN
    RAISE EXCEPTION 'Värdet "%" används på bokförda verifikat och kan inte tas bort — arkivera det istället.',
      OLD.code;
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER enforce_dimension_value_retention
  BEFORE DELETE ON public.dimension_values
  FOR EACH ROW EXECUTE FUNCTION public.enforce_dimension_value_retention();

-- =============================================================================
-- 4. ensure_company_dimensions(company_id) — lazy get-or-create of system dims
-- =============================================================================
-- No eager per-company seeding: core stays zero-config for companies that never
-- touch dimensions. Called by registry CRUD, the engine resolver and SIE import
-- on first use. Idempotent.
CREATE OR REPLACE FUNCTION public.ensure_company_dimensions(p_company_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Tenant guard: authenticated callers must be members of the company.
  -- Service-role callers (auth.uid() IS NULL) are trusted — server code scopes
  -- by company_id (defense-in-depth pattern used across the codebase).
  IF auth.uid() IS NOT NULL
     AND p_company_id NOT IN (SELECT public.user_company_ids()) THEN
    RAISE EXCEPTION 'not a member of company %', p_company_id;
  END IF;

  INSERT INTO public.dimensions (company_id, sie_dim_no, name, resets_annually, is_system, sort_order)
  VALUES
    (p_company_id, 1, 'Kostnadsställe', true,  true, 10),
    (p_company_id, 6, 'Projekt',        false, true, 20)
  ON CONFLICT (company_id, sie_dim_no) DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.ensure_company_dimensions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_company_dimensions(uuid) TO authenticated, service_role;

-- =============================================================================
-- 5. journal_entry_lines.dimensions — the single source of truth line tag
-- =============================================================================
-- NOT NULL DEFAULT '{}' is metadata-only on PG11+ (no table rewrite).
ALTER TABLE public.journal_entry_lines
  ADD COLUMN dimensions jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.journal_entry_lines
  ADD CONSTRAINT jel_dimensions_is_object CHECK (jsonb_typeof(dimensions) = 'object');

-- Containment queries (reports: dimensions @> '{"6":"P001"}') ride the GIN;
-- hot dims 1/6 get partial expression indexes for equality/grouping paths.
CREATE INDEX idx_jel_dimensions_gin
  ON public.journal_entry_lines USING gin (dimensions jsonb_path_ops);
CREATE INDEX idx_jel_dimensions_dim1
  ON public.journal_entry_lines ((dimensions ->> '1')) WHERE dimensions ? '1';
CREATE INDEX idx_jel_dimensions_dim6
  ON public.journal_entry_lines ((dimensions ->> '6')) WHERE dimensions ? '6';

COMMENT ON COLUMN public.journal_entry_lines.dimensions IS
  'SIE dimension map {sie_dim_no: object_code}, e.g. {"1":"KS01","6":"P001"}. Single source of truth for line dimensions; cost_center/project mirror keys 1/6 during the dual-write window (see lib/bookkeeping/dimension-resolver.ts).';
COMMENT ON COLUMN public.journal_entry_lines.cost_center IS
  'Legacy mirror of dimensions->>''1'' (SIE #DIM 1 object code). Kept in sync by lineDimensionColumns(); will become a GENERATED column. NB: the 20240101000011 comment about cost_center_id/project_id FK columns was never true.';
COMMENT ON COLUMN public.journal_entry_lines.project IS
  'Legacy mirror of dimensions->>''6'' (SIE #DIM 6 object code). Kept in sync by lineDimensionColumns(); will become a GENERATED column.';

-- =============================================================================
-- 6. Backfill — representation copy of existing dimension data
-- =============================================================================
-- Copies the legacy TEXT columns into the JSONB map on already-posted lines.
-- This is a pure representation change (same values, new column) with no
-- accounting content touched — accounts, amounts, dates and descriptions are
-- byte-identical. The line-immutability trigger blocks ALL updates to posted
-- lines regardless of column, so it is disabled for exactly this statement
-- (sanctioned precedent: 20260415000000_schema_sync.sql cleanup routine).
--
-- ⚠️ REVIEWER GUIDANCE BEFORE REUSING THIS PATTERN (BFL 5 kap 5§ / BFNAR
-- 2013:2: corrections must preserve original + change visibly; overwriting
-- verifikat content is forbidden). Disabling this trigger is defensible ONLY
-- when ALL of the following hold, as they do here:
--   1. The UPDATE writes exclusively to a column that carries NO verifikat
--      content (here: the brand-new `dimensions` column, populated from values
--      already stored on the same row — no information is created or lost).
--   2. Accounts, amounts, dates, descriptions and linkage columns are
--      untouched (this statement's SET clause names only `dimensions`).
--   3. The change is reviewed under the Swedish-compliance CI workflow.
-- A migration that needs to touch actual verifikat content must instead go
-- through storno/rättelse (correctEntry) — never this pattern.
--
-- Concurrency: the DISABLE/UPDATE/ENABLE sequence runs inside ONE transaction.
-- ALTER TABLE ... DISABLE TRIGGER takes ACCESS EXCLUSIVE on the table and
-- holds it until COMMIT, so no concurrent writer can slip a line in while the
-- trigger is off — the unguarded window the pattern would otherwise open
-- during a live deployment does not exist. (If the migration runner already
-- wraps the file in a transaction, the inner BEGIN degrades to a warning.)
BEGIN;

ALTER TABLE public.journal_entry_lines
  DISABLE TRIGGER enforce_journal_entry_line_immutability;

-- NULLIF: an empty-string legacy mirror must not mint a {"n": ""} entry —
-- normalizeLineDimensions treats empty string as "cleared" and never stores it.
UPDATE public.journal_entry_lines
SET dimensions = jsonb_strip_nulls(
  jsonb_build_object('1', NULLIF(cost_center, ''), '6', NULLIF(project, ''))
)
WHERE NULLIF(cost_center, '') IS NOT NULL OR NULLIF(project, '') IS NOT NULL;

ALTER TABLE public.journal_entry_lines
  ENABLE TRIGGER enforce_journal_entry_line_immutability;

COMMIT;

-- =============================================================================
-- 7. Migrate the legacy registry tables into the new registry
-- =============================================================================
-- cost_centers/projects were company-scoped by 20260330130000 but are
-- write-dead (no code path ever INSERTed; sie-export is the only reader and is
-- switched to the new registry in PR2). Copy their rows, then seed system dims
-- for any company that has legacy registry rows or tagged lines.

-- 7a. System dims for every company with legacy registry rows or tagged lines.
INSERT INTO public.dimensions (company_id, sie_dim_no, name, resets_annually, is_system, sort_order)
SELECT DISTINCT src.company_id, 1, 'Kostnadsställe', true, true, 10
FROM (
  SELECT company_id FROM public.cost_centers
  UNION
  SELECT je.company_id
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE jel.cost_center IS NOT NULL
) src
ON CONFLICT (company_id, sie_dim_no) DO NOTHING;

INSERT INTO public.dimensions (company_id, sie_dim_no, name, resets_annually, is_system, sort_order)
SELECT DISTINCT src.company_id, 6, 'Projekt', false, true, 20
FROM (
  SELECT company_id FROM public.projects
  UNION
  SELECT je.company_id
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE jel.project IS NOT NULL
) src
ON CONFLICT (company_id, sie_dim_no) DO NOTHING;

-- 7b. Copy legacy registry rows (sanitized to satisfy the code CHECK).
INSERT INTO public.dimension_values (company_id, dimension_id, code, name, is_active)
SELECT cc.company_id, d.id,
       left(regexp_replace(cc.code, '["{}]', '', 'g'), 40),
       left(cc.name, 120),
       cc.is_active
FROM public.cost_centers cc
JOIN public.dimensions d ON d.company_id = cc.company_id AND d.sie_dim_no = 1
WHERE char_length(regexp_replace(cc.code, '["{}]', '', 'g')) >= 1
ON CONFLICT (company_id, dimension_id, code) DO NOTHING;

INSERT INTO public.dimension_values (company_id, dimension_id, code, name, is_active, start_date, end_date)
SELECT p.company_id, d.id,
       left(regexp_replace(p.code, '["{}]', '', 'g'), 40),
       left(p.name, 120),
       p.is_active, p.start_date, p.end_date
FROM public.projects p
JOIN public.dimensions d ON d.company_id = p.company_id AND d.sie_dim_no = 6
WHERE char_length(regexp_replace(p.code, '["{}]', '', 'g')) >= 1
ON CONFLICT (company_id, dimension_id, code) DO NOTHING;

-- 7c. Placeholder values for orphaned free-text codes on lines (referential
-- validity holds retroactively without polluting pickers: is_active = false).
INSERT INTO public.dimension_values (company_id, dimension_id, code, name, is_active)
SELECT DISTINCT je.company_id, d.id,
       left(regexp_replace(jel.cost_center, '["{}]', '', 'g'), 40),
       jel.cost_center,
       false
FROM public.journal_entry_lines jel
JOIN public.journal_entries je ON je.id = jel.journal_entry_id
JOIN public.dimensions d ON d.company_id = je.company_id AND d.sie_dim_no = 1
WHERE jel.cost_center IS NOT NULL
  AND char_length(regexp_replace(jel.cost_center, '["{}]', '', 'g')) >= 1
ON CONFLICT (company_id, dimension_id, code) DO NOTHING;

INSERT INTO public.dimension_values (company_id, dimension_id, code, name, is_active)
SELECT DISTINCT je.company_id, d.id,
       left(regexp_replace(jel.project, '["{}]', '', 'g'), 40),
       jel.project,
       false
FROM public.journal_entry_lines jel
JOIN public.journal_entries je ON je.id = jel.journal_entry_id
JOIN public.dimensions d ON d.company_id = je.company_id AND d.sie_dim_no = 6
WHERE jel.project IS NOT NULL
  AND char_length(regexp_replace(jel.project, '["{}]', '', 'g')) >= 1
ON CONFLICT (company_id, dimension_id, code) DO NOTHING;

-- The legacy cost_centers/projects tables are intentionally NOT dropped here:
-- sie-export still reads them until PR2 switches it to the new registry. A
-- follow-up cleanup migration drops both tables after that release.

NOTIFY pgrst, 'reload schema';
