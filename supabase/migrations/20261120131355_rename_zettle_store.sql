-- rename_zettle_store: set the Zettle store display name and backfill
-- webshop_orders.store_label in ONE transaction.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Zettle's users/self returns no store name, so the merchant names the store
-- in settings (the zettle extension's POST /organization-name). The name
-- lives on zettle_connections.organization_name and is denormalized into
-- webshop_orders.store_label, which the Orders page shows under Butik.
-- Doing that as two PostgREST updates lets two concurrent renames interleave
-- (A renames, B renames, B backfills, A backfills) and leave the orders on A
-- while the connection says B.
--
-- Here the connection UPDATE takes the row lock first and holds it until the
-- transaction ends, so a second rename blocks on that row until the first
-- one (rename + backfill) has committed. The two columns cannot diverge.
--
-- INVARIANTS:
--   1. SECURITY INVOKER: the members-update RLS policies on both tables and
--      the aa_enforce_company_writer_role trigger on zettle_connections keep
--      applying (a viewer is refused, an outsider updates nothing). The
--      explicit p_company_id filter is defense in depth.
--   2. The backfill runs in its own block (an implicit savepoint): if it
--      fails, the rename still commits and the result says backfilled=false,
--      so the route can warn instead of losing the name.
--   3. Name validation (trim, non-empty, max length) stays in the route
--      (lib/organization-name.ts); the function stores what it is given.
--
-- Returns {"updated": false} when the company has no active connection,
-- otherwise {"updated": true, "backfilled": <bool>}.
--
-- pg-test: tests/pg/zettle-rename-store.pg.test.ts

create or replace function public.rename_zettle_store(
  p_company_id uuid,
  p_name text
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_ids uuid[];
  v_backfilled boolean := true;
begin
  with renamed as (
    update public.zettle_connections
       set organization_name = p_name
     where company_id = p_company_id
       and status = 'active'
    returning id
  )
  select array_agg(id) into v_ids from renamed;

  if v_ids is null then
    return jsonb_build_object('updated', false);
  end if;

  begin
    update public.webshop_orders
       set store_label = p_name
     where company_id = p_company_id
       and platform = 'zettle'
       and connection_id = any (v_ids);
  exception when others then
    raise warning 'rename_zettle_store: backfill failed: %', sqlerrm;
    v_backfilled := false;
  end;

  return jsonb_build_object('updated', true, 'backfilled', v_backfilled);
end;
$$;

revoke all on function public.rename_zettle_store(uuid, text) from public, anon;
grant execute on function public.rename_zettle_store(uuid, text) to authenticated;
grant execute on function public.rename_zettle_store(uuid, text) to service_role;

NOTIFY pgrst, 'reload schema';
