-- Dimensions go back off where an SIE import turned them on and left nothing
-- to pick.
--
-- Until 20261124200000, importing a file that declared a dimension turned
-- company_settings.dimensions_enabled on, values or no values. A company whose
-- file held none has carried the dimension pickers on every booking form, the
-- register in the menu and the report filters since, all of them empty. This
-- turns the switch off again for exactly those companies. Nothing is removed:
-- the registered dimensions stay, and the switch under Inställningar turns
-- everything back on.
--
-- A company is included when all of this holds:
--
--   * the switch is on;
--   * it has no dimension value at all, active or archived, and no
--     per-account dimension rule;
--   * it has set up no dimension of its own: none it created (the two system
--     dimensions and the ones an import registered are not its own) and none
--     it changed or archived since it was registered;
--   * no journal line of it carries a dimension tag;
--   * the last time the switch went on was an import's doing: the audit row
--     of that change lies between the moment one of the company's SIE imports
--     was created and two minutes after. The import turned the switch on
--     while it prepared, seconds after it was created; a person who turns it
--     on under Inställningar does so at some other time, and is left alone,
--     as is a company whose settings were created with the switch on.
--
-- Companies archived by a migration reset are skipped (their rows refuse
-- writes).
--
-- The switch also decides how a tagged write is checked
-- (validateEntryDimensions): on, a tag must name an active value of the
-- register, and these companies have none; off, a tag passes as free text,
-- which is where every company starts.
--
-- Audited: audit_company_settings writes one audit_log row per company,
-- tagged as the system with this migration as the label (the 20260726120000
-- pattern), so the change never reads as something a person at the company
-- did. Explicit transaction so the SET LOCALs hold for the UPDATE. Re-running
-- is a no-op: the switch it turned off is no longer on.
--
-- Time: the statement reads every journal line once to find the tagged ones
-- (a tag can sit on any dimension number, and only 1 and 6 are indexed) and
-- writes one audit row per company. That can pass the migration connection's
-- statement_timeout (2 minutes) on a large database with a cold cache, so the
-- transaction sets its own limit. The settings rows are locked only while
-- they are written, at the end; the wait for a row someone else holds is
-- bounded, and a refused wait rolls everything back.
--
-- pg-test: tests/pg/dimension-switch-off-where-import-left-nothing.pg.test.ts

BEGIN;

SET LOCAL statement_timeout = '10min';
SET LOCAL lock_timeout = '30s';

SET LOCAL gnubok.actor_type = 'system';
SET LOCAL gnubok.actor_label = 'migration 20261124200100 dimension_switch_off_where_import_left_nothing';

WITH candidates AS MATERIALIZED (
  SELECT cs.company_id
  FROM public.company_settings cs
  WHERE cs.dimensions_enabled
    AND NOT EXISTS (SELECT 1 FROM public.dimension_values v WHERE v.company_id = cs.company_id)
    AND NOT EXISTS (SELECT 1 FROM public.account_dimension_rules r WHERE r.company_id = cs.company_id)
    AND NOT EXISTS (
      SELECT 1 FROM public.dimensions d
      WHERE d.company_id = cs.company_id
        AND ((NOT d.is_system AND d.created_by_import_id IS NULL) OR d.updated_at > d.created_at)
    )
    AND NOT EXISTS (SELECT 1 FROM public.company_migration_resets m WHERE m.source_company_id = cs.company_id)
), switched_on AS MATERIALIZED (
  -- The last time the switch went from off to on, per candidate.
  SELECT DISTINCT ON (a.company_id) a.company_id, a.created_at AS switched_at
  FROM public.audit_log a
  JOIN candidates c ON c.company_id = a.company_id
  WHERE a.table_name = 'company_settings'
    AND a.action = 'UPDATE'
    AND a.new_state->>'dimensions_enabled' = 'true'
    AND a.old_state->>'dimensions_enabled' = 'false'
  ORDER BY a.company_id, a.created_at DESC
), by_import AS MATERIALIZED (
  SELECT s.company_id
  FROM switched_on s
  WHERE EXISTS (
    SELECT 1 FROM public.sie_imports i
    WHERE i.company_id = s.company_id
      AND s.switched_at BETWEEN i.created_at AND i.created_at + interval '2 minutes'
  )
), tagged AS MATERIALIZED (
  -- From the tagged lines to their companies, once for the whole table:
  -- reading the lines company by company would walk each ledger through its
  -- entries.
  SELECT DISTINCT je.company_id
  FROM public.journal_entry_lines l
  JOIN public.journal_entries je ON je.id = l.journal_entry_id
  WHERE l.dimensions <> '{}'::jsonb
)
UPDATE public.company_settings cs
SET dimensions_enabled = false
FROM by_import b
WHERE cs.company_id = b.company_id
  AND cs.dimensions_enabled
  AND NOT EXISTS (SELECT 1 FROM tagged t WHERE t.company_id = cs.company_id);

COMMIT;
