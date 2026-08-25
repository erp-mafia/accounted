-- Contain the invoice remaining-balance backfill snapshot created during the
-- 2026-08-17 production repair recorded in PR #1655. The table is not part of
-- the application schema and no runtime code references it, but production
-- retains 337 financial snapshot rows whose retention status is unresolved.
-- Preserve the rows for review while removing every browser-facing access
-- path. The service role remains read-only for an authorized retention audit,
-- while the table owner retains control for a separately approved decision.
--
-- Fresh databases do not contain this incident artifact, so the migration is
-- deliberately conditional. Retention, relocation, or deletion is a separate
-- decision and must not be inferred from this access-containment change.
DO $$
BEGIN
  IF pg_catalog.to_regclass('public._backfill_remaining_20260817') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public._backfill_remaining_20260817 ENABLE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public._backfill_remaining_20260817 FROM PUBLIC, anon, authenticated';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public._backfill_remaining_20260817 FROM service_role';
    EXECUTE 'GRANT SELECT ON TABLE public._backfill_remaining_20260817 TO service_role';
    EXECUTE 'COMMENT ON TABLE public._backfill_remaining_20260817 IS ''Invoice remaining-balance repair snapshot from 2026-08-17. Browser access is revoked. Retention, relocation, or deletion requires a separate approved decision.''';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
