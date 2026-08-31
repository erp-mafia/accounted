-- Follow-up to 20260828172003 (#2016): restore the least-privilege ACL on
-- get_vat_ruta_source_lines.
--
-- That migration DROPped the 9-arg overload and CREATEd the 11-arg one
-- (p_ruta_accounts / p_net_accounts). DROP FUNCTION discards the function's
-- ACL along with the function, and the CREATE did not restate the
-- REVOKE/GRANT that 20260721103000 had put on the old signature, so the new
-- function fell back to the Postgres default: EXECUTE granted to PUBLIC, which
-- includes anon. Practical exposure is nil (SECURITY INVOKER, and the
-- company_members RLS behind user_company_ids() returns zero rows to anon),
-- but every other tenant-scoped read RPC in this repo is explicitly revoked
-- from PUBLIC and anon (the sibling get_vat_declaration_totals restates its
-- ACL in 20260813124510), and the drill-down should not be the one exception.
--
-- 20260828172003 is already applied on production, so this is a new file
-- rather than an edit. Idempotent: REVOKE and GRANT can be re-run freely.
--
-- Rule this pins: every DROP + CREATE of an RPC must restate its REVOKE/GRANT,
-- because the ACL does not survive the DROP.
--
-- pg-test: tests/pg/vat-ruta-drilldown-reconcile.pg.test.ts

REVOKE ALL ON FUNCTION public.get_vat_ruta_source_lines(
  uuid, date, date, text[], text[], text[], date, integer, uuid, uuid, integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_vat_ruta_source_lines(
  uuid, date, date, text[], text[], text[], date, integer, uuid, uuid, integer
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
