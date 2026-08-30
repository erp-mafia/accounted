-- ACL manifest of the application schema: one line per function and relation
-- in `public`, stating what each PostgREST role (anon, authenticated,
-- service_role) may do with it. backup.sh writes this next to the dump;
-- restore.sh runs it again after pg_restore and diffs the two. Any difference
-- means the restored database exposes an object differently than the source
-- did, which is exactly the failure a restore drill must surface (the
-- migrations lock SECURITY DEFINER RPCs away from anon/authenticated, and a
-- restore that loses those REVOKEs is silent otherwise).
--
-- Deliberately owner-independent: --no-owner changes who owns the objects,
-- never what these three roles may do. Run with psql -X -A -t -q. Ordered
-- under the C collation so a source and a target with different database
-- collations still produce byte-identical files.
set search_path = public, pg_catalog;

select line from (
  select 'function ' || p.oid::regprocedure::text
    || ' anon=' || has_function_privilege('anon', p.oid, 'EXECUTE')::int
    || ' authenticated=' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::int
    || ' service_role=' || has_function_privilege('service_role', p.oid, 'EXECUTE')::int as line
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
  union all
  -- Four digits per role: SELECT INSERT UPDATE DELETE.
  select 'relation ' || c.oid::regclass::text
    || ' anon='
    || has_table_privilege('anon', c.oid, 'SELECT')::int
    || has_table_privilege('anon', c.oid, 'INSERT')::int
    || has_table_privilege('anon', c.oid, 'UPDATE')::int
    || has_table_privilege('anon', c.oid, 'DELETE')::int
    || ' authenticated='
    || has_table_privilege('authenticated', c.oid, 'SELECT')::int
    || has_table_privilege('authenticated', c.oid, 'INSERT')::int
    || has_table_privilege('authenticated', c.oid, 'UPDATE')::int
    || has_table_privilege('authenticated', c.oid, 'DELETE')::int
    || ' service_role='
    || has_table_privilege('service_role', c.oid, 'SELECT')::int
    || has_table_privilege('service_role', c.oid, 'INSERT')::int
    || has_table_privilege('service_role', c.oid, 'UPDATE')::int
    || has_table_privilege('service_role', c.oid, 'DELETE')::int
  from pg_class c
  where c.relnamespace = 'public'::regnamespace
    and c.relkind in ('r', 'p', 'v', 'm')
) t
order by line collate "C";
