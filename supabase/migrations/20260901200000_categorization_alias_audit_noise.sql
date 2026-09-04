-- Stop alias learning from flooding the behandlingshistorik audit trail.
--
-- 20260901103000 added the audit trigger on categorization_templates with a
-- WHEN clause excluding the learning columns (occurrence_count, confidence,
-- last_seen_date, updated_at). Production falsified the list within 30
-- minutes of deploy: 15 of the first 16 UPDATE audit rows changed only those
-- columns plus counterparty_aliases, because the learning path
-- (lib/bookkeeping/counterparty-templates.ts) merges new aliases in the same
-- write that bumps occurrence_count. Projected ~800 noise rows/day against
-- ~50/day of real rule changes, every one of them rendered into the
-- legally-facing report as "Konteringsmall aendrad: Alias ...".
--
-- counterparty_aliases joins the strip list. The trade-off is explicit: a
-- human editing ONLY the aliases of a template is no longer logged either.
-- Accepted because alias growth is overwhelmingly automatic, and a change
-- that also touches accounts, VAT, pattern or active flag still logs (the
-- first real such row, 2026-09-01 19:02:17Z, changed debit/credit/vat
-- accounts alongside learning columns and was correctly captured).
--
-- The noise rows already written stay: audit_log is append-only. The read
-- model stops labelling the column, so they render as no-ops.
--
-- pg-test: tests/pg/behandlingshistorik-audit-triggers.pg.test.ts

DROP TRIGGER audit_categorization_templates_update ON public.categorization_templates;

CREATE TRIGGER audit_categorization_templates_update
  AFTER UPDATE ON public.categorization_templates
  FOR EACH ROW
  WHEN (
    (to_jsonb(OLD) - ARRAY[
      'occurrence_count',
      'confidence',
      'last_seen_date',
      'updated_at',
      'counterparty_aliases'
    ]::text[])
    IS DISTINCT FROM
    (to_jsonb(NEW) - ARRAY[
      'occurrence_count',
      'confidence',
      'last_seen_date',
      'updated_at',
      'counterparty_aliases'
    ]::text[])
  )
  EXECUTE FUNCTION public.write_audit_log();
