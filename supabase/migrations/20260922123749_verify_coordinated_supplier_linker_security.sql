-- Verify the final installed result of the guarded supplier prerequisite.
-- This assertion-only migration never replaces the function or its grants.
DO $verification$
DECLARE
  v_function pg_catalog.pg_proc;
  v_grants text[];
BEGIN
  SELECT * INTO STRICT v_function FROM pg_catalog.pg_proc
  WHERE oid = 'public.link_supplier_invoice_to_voucher(uuid,uuid,uuid,uuid,text)'::regprocedure;

  -- SHA-256 of the complete literal body reviewed in migration 20260922090239.
  IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_function.prosrc, 'UTF8')), 'hex') IS DISTINCT FROM
       '466e715356f5b63e05d605e89afd4b83f8c0d85080898597a3c1301a596b966b'
    OR v_function.prosecdef IS NOT TRUE
    OR v_function.proconfig IS DISTINCT FROM ARRAY['search_path=public']::text[]
    OR pg_get_userbyid(v_function.proowner) IS DISTINCT FROM 'postgres'
    OR (SELECT lanname FROM pg_catalog.pg_language WHERE oid = v_function.prolang) IS DISTINCT FROM 'plpgsql'
  THEN
    RAISE EXCEPTION 'Coordinated supplier linker definition differs from reviewed output';
  END IF;

  SELECT array_agg(grantee::regrole::text || ':' || privilege_type || ':' || is_grantable::text
                   ORDER BY grantee::regrole::text, privilege_type, is_grantable)
    INTO v_grants
  FROM aclexplode(coalesce(v_function.proacl, acldefault('f', v_function.proowner)));
  IF v_grants IS DISTINCT FROM ARRAY[
    'authenticated:EXECUTE:false', 'postgres:EXECUTE:false', 'service_role:EXECUTE:false'
  ]::text[] THEN
    RAISE EXCEPTION 'Coordinated supplier linker grants differ from reviewed output';
  END IF;
END;
$verification$;
