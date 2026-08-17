-- Fix: the nightly sandbox cleanup has been a silent no-op since the sandbox
-- seed started posting vouchers. cleanup_sandbox_user deletes
-- journal_entry_lines without setting the gnubok.allow_delete bypass, so
-- enforce_journal_entry_line_immutability raises "Cannot DELETE lines of a
-- posted journal entry", cleanup_expired_sandbox_users swallows the error as
-- a WARNING, and the cron reports success every night while expired anonymous
-- users accumulate in auth.users (658 overdue on prod at the time of writing,
-- oldest from 2026-03).
--
-- Behind that first failure hide two more, confirmed by replaying the fixed
-- delete chain against prod inside an aborted transaction:
--
--   * salary_runs references its booked vouchers with plain NO ACTION FKs,
--     so the journal entry delete fails while a booked run points at them.
--   * the auth.users delete cascades through the sandbox company, and
--     write_audit_log fires mid-cascade, inserting audit rows that reference
--     the company being deleted in that same cascade: FK violation. Existing
--     audit rows from seeding block the company delete the same way, and
--     audit_log_no_delete forbids removing them.
--
-- The teardown therefore gets its own transaction-local flag,
-- gnubok.sandbox_cleanup, set only inside cleanup_sandbox_user after its
-- is_sandbox check:
--
--   1. write_audit_log skips while the flag is set (sandbox demo data needs
--      no audit trail, and the company the rows would reference is being
--      deleted anyway).
--   2. audit_log_immutable allows DELETE only when the flag is set AND the
--      row's company_id provably belongs to a sandbox company. UPDATE stays
--      forbidden unconditionally. Real companies' audit rows remain WORM:
--      the trigger re-verifies sandbox-ness per row instead of trusting the
--      flag alone.
--   3. enforce_dimension_registry_guards allows the DELETE cascade through
--      the system dimensions (every post-2026-07 sandbox has dims 1/6 via
--      ensure_company_dimensions) while the flag is set.
--   4. enforce_pending_operations_no_delete allows the cascade through
--      terminal-state demo operations while the flag is set.
--   4b. company_settings.is_sandbox becomes write-once and insert-guarded
--      (trigger): every bypass above trusts that flag, so a real company
--      must never be able to flip it, and is_sandbox = true can only be
--      created by anonymous-user JWTs, service_role, or direct DB sessions.
--   5. cleanup_sandbox_user sets gnubok.allow_delete (the sanctioned
--      delete_last_voucher flag that every delete-path trigger on
--      journal_entries / journal_entry_lines respects) plus the new flag,
--      clears the salary_runs voucher links, and purges the sandbox
--      company's audit rows before deleting auth.users.
--
-- cleanup_expired_sandbox_users additionally returns a jsonb summary
-- {cleaned, failed, orphans_removed} instead of a bare count so the cron can
-- log failures instead of hiding them, sweeps expired anonymous auth users
-- that never got a company_settings row (a seed that failed before writing
-- settings left them invisible to the old query, leaking them forever), and
-- takes an optional p_limit for bounded batch runs against a backlog.
--
-- Both RPCs also lose their default PUBLIC EXECUTE grant: on prod, anon and
-- authenticated could call them via PostgREST.

-- =============================================================================
-- 1. write_audit_log: skip during sandbox teardown
-- =============================================================================

CREATE OR REPLACE FUNCTION public.write_audit_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id    uuid;
  v_company_id uuid;
  v_action     text;
  v_old_state  jsonb;
  v_new_state  jsonb;
  v_record_id  uuid;
  v_desc       text;
BEGIN
  -- Sandbox teardown (cleanup_sandbox_user) deletes the company row itself;
  -- audit rows inserted mid-cascade would reference the vanishing company
  -- and violate audit_log_company_id_fkey. The flag is transaction-local and
  -- only set after the RPC's is_sandbox check.
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_old_state := to_jsonb(OLD);
    v_new_state := NULL;
    v_record_id := OLD.id;
    v_user_id := (v_old_state->>'user_id')::uuid;
    v_company_id := (v_old_state->>'company_id')::uuid;
    v_action := 'DELETE';
    v_desc := 'Deleted ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'INSERT' THEN
    v_old_state := NULL;
    v_new_state := to_jsonb(NEW);
    v_record_id := NEW.id;
    v_user_id := (v_new_state->>'user_id')::uuid;
    v_company_id := (v_new_state->>'company_id')::uuid;
    v_action := 'INSERT';
    v_desc := 'Created ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'UPDATE' THEN
    v_old_state := to_jsonb(OLD);
    v_new_state := to_jsonb(NEW);
    v_record_id := COALESCE(NEW.id, OLD.id);
    v_user_id := COALESCE((v_new_state->>'user_id')::uuid, (v_old_state->>'user_id')::uuid);
    v_company_id := COALESCE((v_new_state->>'company_id')::uuid, (v_old_state->>'company_id')::uuid);
    v_action := 'UPDATE';
    v_desc := 'Updated ' || TG_TABLE_NAME || ' record';

    IF TG_TABLE_NAME = 'journal_entries' THEN
      IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
        v_action := 'COMMIT';
        v_desc := 'Committed journal entry ' || NEW.voucher_series || NEW.voucher_number;
      ELSIF OLD.status = 'posted' AND NEW.status = 'reversed' THEN
        v_action := 'REVERSE';
        v_desc := 'Reversed journal entry ' || OLD.voucher_series || OLD.voucher_number;
      END IF;
    END IF;

    IF TG_TABLE_NAME = 'fiscal_periods' THEN
      IF (OLD.locked_at IS NULL AND NEW.locked_at IS NOT NULL) THEN
        v_action := 'LOCK_PERIOD';
        v_desc := 'Locked fiscal period "' || NEW.name || '"';
      ELSIF (NOT OLD.is_closed AND NEW.is_closed) THEN
        v_action := 'CLOSE_PERIOD';
        v_desc := 'Closed fiscal period "' || NEW.name || '"';
      END IF;
    END IF;
  END IF;

  -- Fall back to auth.uid() when the row does not carry user_id
  v_user_id := COALESCE(v_user_id, auth.uid());

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description, actor_type, actor_label)
  VALUES (
    v_user_id, v_company_id, v_action, TG_TABLE_NAME, v_record_id, v_user_id, v_old_state, v_new_state, v_desc,
    COALESCE(nullif(current_setting('gnubok.actor_type', true), ''), 'user'),
    nullif(current_setting('gnubok.actor_label', true), '')
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

-- =============================================================================
-- 2. audit_log_immutable: allow sandbox-teardown DELETE, verified per row
-- =============================================================================

CREATE OR REPLACE FUNCTION public.audit_log_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  -- Sandbox teardown may delete audit rows, but only rows whose company is
  -- provably a sandbox: the per-row re-check means a set flag alone can
  -- never unlock real companies' audit trail. UPDATE stays forbidden even
  -- during teardown. Rows must be purged while the company_settings row
  -- still exists (cleanup_sandbox_user does this before auth.users).
  IF TG_OP = 'DELETE'
     AND current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND OLD.company_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.company_settings cs
       WHERE cs.company_id = OLD.company_id AND cs.is_sandbox = true
     ) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Audit log entries cannot be modified or deleted';
END;
$function$;

-- =============================================================================
-- 3. enforce_dimension_registry_guards: allow sandbox-teardown DELETE
-- =============================================================================

-- Every sandbox seeded since the dimensions substrate (2026-07) carries the
-- system dimensions 1/6 via ensure_company_dimensions, and this guard blocks
-- their DELETE unconditionally, so the auth.users cascade dies on
-- "Systemdimensionen 1 (Kostnadsställe) kan inte tas bort" (found by probing
-- the fixed cleanup against staging's stale sandboxes). During teardown the
-- whole company is being deleted; keeping its dimension registry rows is
-- neither possible nor meaningful. UPDATE guards stay untouched.

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
  -- Sandbox teardown deletes the entire company; its registry rows go with
  -- it. Transaction-local flag, only set by cleanup_sandbox_user after its
  -- is_sandbox check, plus a per-row re-verification (same pattern as
  -- audit_log_immutable) so the flag alone can never unlock a real
  -- company's registry. cleanup_sandbox_user deletes these rows explicitly
  -- while company_settings still exists; the re-check would fail mid-cascade
  -- once that row is gone.
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND EXISTS (
       SELECT 1 FROM public.company_settings cs
       WHERE cs.company_id = OLD.company_id AND cs.is_sandbox = true
     ) THEN
    RETURN OLD;
  END IF;
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

-- =============================================================================
-- 4. enforce_pending_operations_no_delete: allow sandbox-teardown DELETE
-- =============================================================================

-- Sandbox visitors approve/reject the pre-staged demo operations, leaving
-- terminal-state pending_operations rows that this guard refuses to delete
-- (BFL 7 kap. protection for real books; found by probing prod's backlog).
-- Same teardown rule as above: the demo company is being deleted wholesale.
-- The UPDATE immutability trigger stays untouched. Base definition:
-- 20260722134114 (includes 'failed_partial').

CREATE OR REPLACE FUNCTION public.enforce_pending_operations_no_delete()
RETURNS TRIGGER AS $$
BEGIN
  -- Sandbox teardown: transaction-local flag, only set by
  -- cleanup_sandbox_user after its is_sandbox check, plus a per-row
  -- re-verification (same pattern as audit_log_immutable) so the flag alone
  -- can never unlock a real company's rows. cleanup_sandbox_user deletes
  -- these rows explicitly while company_settings still exists.
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND EXISTS (
       SELECT 1 FROM public.company_settings cs
       WHERE cs.company_id = OLD.company_id AND cs.is_sandbox = true
     ) THEN
    RETURN OLD;
  END IF;
  IF OLD.status IN ('committed', 'rejected', 'failed_partial') THEN
    RAISE EXCEPTION
      'pending_operations row % is in terminal state % and cannot be deleted (BFL 7 kap.)',
      OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 5. cleanup_sandbox_user: set bypass flags, clear blocking FKs, purge audit
-- =============================================================================

CREATE OR REPLACE FUNCTION public.cleanup_sandbox_user(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer := 0;
BEGIN
  -- Verify this is a sandbox user: at least one settings row, and EVERY
  -- settings row flagged sandbox. A single-row read would pick an arbitrary
  -- row for a hypothetical multi-company user and the user-scoped deletes
  -- below would then reach the real company's rows.
  IF NOT EXISTS (
    SELECT 1 FROM public.company_settings cs WHERE cs.user_id = p_user_id
  ) OR EXISTS (
    SELECT 1 FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'User % is not a sandbox user', p_user_id;
  END IF;

  -- Sanctioned trigger bypasses, transaction-local and only reachable after
  -- the is_sandbox check above, so real companies can never enter this path.
  -- allow_delete is the delete_last_voucher flag the journal immutability
  -- and retention triggers respect; sandbox_cleanup gates the audit-log
  -- behavior (see the trigger functions above).
  PERFORM set_config('gnubok.allow_delete', 'true', true);
  PERFORM set_config('gnubok.sandbox_cleanup', 'true', true);

  -- Clear RESTRICT FKs on document_attachments
  UPDATE public.document_attachments
  SET journal_entry_id = NULL, journal_entry_line_id = NULL
  WHERE user_id = p_user_id;

  DELETE FROM public.document_attachments WHERE user_id = p_user_id;

  -- salary_runs references its booked vouchers with plain NO ACTION FKs
  -- (salary_entry_id, avgifter_entry_id, pension_entry_id,
  -- vacation_entry_id); the seed links one booked run, so the journal entry
  -- delete below would otherwise fail.
  UPDATE public.salary_runs
  SET salary_entry_id = NULL,
      avgifter_entry_id = NULL,
      pension_entry_id = NULL,
      vacation_entry_id = NULL
  WHERE user_id = p_user_id;

  -- Delete journal entry lines (child of journal_entries)
  DELETE FROM public.journal_entry_lines
  WHERE journal_entry_id IN (
    SELECT id FROM public.journal_entries WHERE user_id = p_user_id
  );

  DELETE FROM public.journal_entries WHERE user_id = p_user_id;

  -- Delete supplier invoices before suppliers cascade
  DELETE FROM public.supplier_invoices WHERE user_id = p_user_id;

  -- Terminal pending operations and the dimension registry carry delete
  -- guards whose bypass re-verifies sandbox-ness through company_settings,
  -- so delete them explicitly while that row still exists instead of
  -- leaving them to the auth.users cascade (cascade order is unspecified
  -- and may remove company_settings first).
  DELETE FROM public.pending_operations WHERE user_id = p_user_id;

  DELETE FROM public.dimensions
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  -- Purge the sandbox company's audit rows while company_settings still
  -- exists (audit_log_immutable re-verifies sandbox-ness through it).
  -- audit_log.company_id has a plain NO ACTION FK, so leftover rows would
  -- block the companies delete inside the auth.users cascade.
  DELETE FROM public.audit_log
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  -- Delete from auth.users cascades everything else
  DELETE FROM auth.users WHERE id = p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- Drop the bypasses before returning so nothing later in the same
  -- transaction (the expired-users loop, the orphan sweep) runs with them
  -- still armed.
  PERFORM set_config('gnubok.allow_delete', '', true);
  PERFORM set_config('gnubok.sandbox_cleanup', '', true);

  RETURN v_deleted;
END;
$$;

-- =============================================================================
-- 6. cleanup_expired_sandbox_users: jsonb summary + orphaned-anonymous sweep
-- =============================================================================

-- Return type changes from integer to jsonb, so CREATE OR REPLACE cannot be
-- used; drop the old signature first.
DROP FUNCTION IF EXISTS public.cleanup_expired_sandbox_users(int);

CREATE FUNCTION public.cleanup_expired_sandbox_users(
  p_max_age_hours int DEFAULT 24,
  p_limit int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_cleaned integer := 0;
  v_failed integer := 0;
  v_orphans integer := 0;
BEGIN
  FOR v_user_id IN
    SELECT cs.user_id
    FROM public.company_settings cs
    WHERE cs.is_sandbox = true
      AND cs.created_at < now() - interval '1 hour' * p_max_age_hours
    ORDER BY cs.created_at
    LIMIT p_limit
  LOOP
    BEGIN
      PERFORM public.cleanup_sandbox_user(v_user_id);
      v_cleaned := v_cleaned + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      RAISE WARNING 'Failed to clean up sandbox user %: %', v_user_id, SQLERRM;
    END;
  END LOOP;

  -- Anonymous users whose seed never reached the company_settings insert are
  -- invisible to the query above and would otherwise leak forever. They have
  -- no bookkeeping (the seed writes settings before any vouchers), so a
  -- plain auth.users delete cascades the little they do have. Non-anonymous
  -- users are never touched here. auth.users.is_anonymous arrived with
  -- GoTrue's anonymous sign-ins; older self-hosted stacks (and the CI
  -- supabase/postgres image) predate it, and without anonymous sign-ins no
  -- orphans can exist, so the sweep is skipped there. plpgsql resolves the
  -- loop query only when this branch executes.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth' AND table_name = 'users'
      AND column_name = 'is_anonymous'
  ) THEN
    FOR v_user_id IN
      SELECT u.id
      FROM auth.users u
      WHERE u.is_anonymous = true
        AND u.created_at < now() - interval '1 hour' * p_max_age_hours
        AND NOT EXISTS (
          SELECT 1 FROM public.company_settings cs WHERE cs.user_id = u.id
        )
        -- Explicit safety, not emergent: an anonymous user attached to ANY
        -- company (a seed that died between company creation and the
        -- settings insert) is out of scope for this blind delete. Such
        -- half-seeded users are rare and can be handled manually; a user
        -- with real data must never depend on a downstream trigger throwing.
        AND NOT EXISTS (
          SELECT 1 FROM public.companies c WHERE c.created_by = u.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.company_members cm WHERE cm.user_id = u.id
        )
      ORDER BY u.created_at
      LIMIT p_limit
    LOOP
      BEGIN
        DELETE FROM auth.users WHERE id = v_user_id;
        v_orphans := v_orphans + 1;
      EXCEPTION WHEN OTHERS THEN
        v_failed := v_failed + 1;
        RAISE WARNING 'Failed to clean up orphaned anonymous user %: %', v_user_id, SQLERRM;
      END;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'cleaned', v_cleaned,
    'failed', v_failed,
    'orphans_removed', v_orphans
  );
END;
$$;

-- =============================================================================
-- 7. company_settings.is_sandbox: write-once, and true only for sandbox actors
-- =============================================================================

-- Every teardown bypass above trusts company_settings.is_sandbox, so the
-- flag needs guarded provenance in both directions:
--
--   * UPDATE: write-once. RLS lets an owner update their own settings row
--     via PostgREST, and a real company that flipped is_sandbox = true
--     would become eligible for full deletion by the nightly cron. No
--     application path updates the flag; a future sandbox-to-real
--     conversion ships its own migration relaxing this deliberately.
--   * INSERT: is_sandbox = true may only be written by an anonymous-user
--     JWT (the sandbox seed's actor), service_role, or a direct database
--     session (no PostgREST claims at all: migrations, seeds, tests). A
--     regular authenticated user must not be able to provision their real
--     company as a sandbox and have the cron destroy their books, which
--     BFL 7 kap. forbids even self-inflicted.
--
-- Claims are read from request.jwt.* GUCs directly (both the modern json
-- and the legacy per-claim style) rather than auth helpers, so the check
-- behaves identically on hosted, self-hosted, and the CI auth shim.

CREATE OR REPLACE FUNCTION public.enforce_company_settings_sandbox_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_claims jsonb;
  v_role text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.is_sandbox IS DISTINCT FROM OLD.is_sandbox THEN
      RAISE EXCEPTION 'company_settings.is_sandbox is write-once: it is set at company creation and cannot be changed';
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT
  IF NEW.is_sandbox = true THEN
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    v_role := coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      v_claims->>'role'
    );
    -- Any PostgREST context at all (claims json or a per-claim role) must
    -- prove itself; a claims blob without a role claim is still not a
    -- direct database session.
    IF (v_claims IS NOT NULL OR v_role IS NOT NULL)
       AND coalesce(v_role, '') <> 'service_role'
       AND coalesce((v_claims->>'is_anonymous')::boolean, false) = false THEN
      RAISE EXCEPTION 'company_settings.is_sandbox = true can only be created for anonymous sandbox users';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS company_settings_sandbox_immutable ON public.company_settings;
CREATE TRIGGER company_settings_sandbox_immutable
  BEFORE INSERT OR UPDATE ON public.company_settings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_settings_sandbox_immutable();

-- =============================================================================
-- 8. Grants: service_role only (both were PUBLIC-executable on prod)
-- =============================================================================

REVOKE ALL ON FUNCTION public.cleanup_sandbox_user(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_expired_sandbox_users(int, int) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.cleanup_sandbox_user(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_sandbox_users(int, int) TO service_role;
