-- Clean up rows of retired tax deadline types (issue #1028).
--
-- The bare 'moms' and 'inkomstdeklaration' types were replaced by
-- moms_monthly/quarterly/yearly and inkomstdeklaration_ef/_ab long ago, but
-- their rows lingered (one per company from early seeding), polluting
-- history views and per-type analytics. Completed rows are kept as filing
-- history. The sandbox seed route stops inserting these types in the same
-- change, so they do not come back.
DELETE FROM public.deadlines
WHERE source = 'system'
  AND tax_deadline_type IN ('moms', 'inkomstdeklaration')
  AND is_completed = false;
