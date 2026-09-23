-- Revoke a restricted API key when a company deletion empties its allowlist.
-- pg-test: tests/pg/api-key-allowlist-fail-closed.pg.test.ts
--
-- Finding (review on PR #2753): api_key_companies.company_id is ON DELETE
-- CASCADE, and "no rows" means "every company the user belongs to"
-- (20260923160100). Deleting the only company on a key's allowlist therefore
-- removed the key's last row and silently widened the key from one company
-- to all of them. api_keys.company_id also cascades, so a key whose DEFAULT
-- company is deleted disappears with it, but the default can sit outside the
-- allowlist (validate_and_increment_api_key then swaps in the first allowed
-- company), so the widening was reachable.
--
-- Fix: fail closed. After an allowlist row is deleted BECAUSE its company no
-- longer exists, and the key has no allowlist rows left, the key is revoked
-- (revoked_at = now(), the same revocation every other path uses; it also
-- kills the rotation grace hash, which is gated on revoked_at IS NULL). The
-- user reconnects and consents again, as for any revoked key.
--
-- Why "the company no longer exists" is the discriminator: the one path that
-- deliberately empties an allowlist, replace_api_key_allowlist with NULL or
-- an empty list (20260923160200, the settings "all companies" edit), deletes
-- rows whose company still exists; that stays an explicit widening the owner
-- asked for and is not revoked. A cascade from companies runs after the
-- parent row is gone, so the lookup below sees it missing. Deleting the key
-- itself cascades here too; the UPDATE then matches no row, harmless.
--
-- A trigger on api_key_companies rather than on companies keeps the rule next
-- to the table whose semantics it protects and needs no knowledge of the
-- companies deletion path (account erasure, company delete RPCs).
--
-- Deleting one of several allowlisted companies leaves the key restricted to
-- the rest: nothing is revoked, the validation RPC re-picks the default.
--
-- SECURITY DEFINER with a fixed search_path, like the other functions on
-- this service-role-only table: the revoke must not depend on which role
-- performed the delete. The function only ever revokes, never widens.

CREATE FUNCTION public.revoke_api_key_on_emptied_allowlist()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id) THEN
    RETURN NULL;  -- explicit allowlist edit, company still exists: not ours
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.api_key_companies akc WHERE akc.api_key_id = OLD.api_key_id
  ) THEN
    RETURN NULL;  -- still restricted to the remaining companies
  END IF;

  UPDATE public.api_keys
     SET revoked_at = now()
   WHERE id = OLD.api_key_id
     AND revoked_at IS NULL;

  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.revoke_api_key_on_emptied_allowlist()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_api_key_companies_revoke_on_empty
  AFTER DELETE ON public.api_key_companies
  FOR EACH ROW
  EXECUTE FUNCTION public.revoke_api_key_on_emptied_allowlist();
