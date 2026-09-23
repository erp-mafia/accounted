-- Asset register and ledger cannot drift apart (issue #2779).
--
-- The anläggningsregister is sidoordnad bokföring (BFL 5 kap. 4 §, BFNAR
-- 2013:2 kap. 4). A depreciation_schedules row with a journal_entry_id is the
-- register's record that a planenlig avskrivning reached the books, and
-- ackumulerade avskrivningar (punkt 4.5) is read from those rows. Two gaps
-- let the register lose that record while the voucher stayed posted; both
-- were reproduced on the schema before this migration:
--
--   1. assets -> depreciation_schedules is ON DELETE CASCADE, and nothing at
--      the database level refused deleting a row that points at a verifikat.
--      The depreciation_schedules_delete RLS policy (journal_entry_id IS
--      NULL) does not apply to a cascade, which runs as table owner, nor to
--      the service role. `DELETE FROM assets` on an asset with a posted row
--      removed the row and left the posted voucher with no register row.
--   2. commitAnnualPostings() committed the voucher and wrote the schedule
--      link in two statements. In between there was no posted row to see,
--      guard or lock, and the link UPDATE could match zero rows silently.
--
-- What this migration does:
--
--   * block_posted_depreciation_schedule_delete: BEFORE DELETE guard on rows
--     with journal_entry_id IS NOT NULL. It fires for the cascade too, so the
--     invariant no longer depends on any caller checking first.
--   * commit_asset_depreciation: voucher commit and register link in one
--     transaction under the asset row lock, in the shape of
--     commit_asset_disposal (20260803226000). Voucher numbering is delegated
--     to commit_journal_entry, so there is still exactly one numbering path.
--   * delete_never_posted_asset: the "never reached the books" rule decided
--     under the SAME asset row lock, so post-versus-delete serialises.
--
-- What it deliberately does NOT do: it does not touch delete_last_voucher,
-- and it does not redefine enforce_depreciation_schedule_immutability. A
-- posted row stays exactly as immutable as 20260516120000 made it, and the
-- foreign key depreciation_schedules.journal_entry_id stays ON DELETE
-- RESTRICT. A depreciation voucher therefore remains undeletable through
-- delete_last_voucher, as before this migration: the database refuses at the
-- DELETE, before anything is removed, and the application maps that refusal
-- to a Swedish message. Whether delete_last_voucher may hard-delete a posted
-- verifikat at all is an open question (BFL 5 kap. 5 §) and this migration
-- does not widen it to a new class of vouchers. The correction path for a
-- posted avskrivning is storno.
--
-- Bypass: the guard honours the transaction-local gnubok.allow_delete flag,
-- the same convention enforce_retention_journal_entries and
-- enforce_document_metadata_immutability use. A sweep of every function in
-- `public` on a database with all migrations applied found NO function that
-- deletes from assets or depreciation_schedules: rows only ever leave through
-- the asset delete above or an FK cascade from companies / auth.users. The
-- functions that delete journal_entries (delete_last_voucher,
-- undo_sie_import, replace_sie_import, reset_fiscal_year,
-- cleanup_sandbox_user) are stopped by the RESTRICT foreign key on
-- journal_entry_id before any schedule row is touched, so this guard changes
-- none of them. reset_fiscal_year relies on that refusal by design
-- (FISCAL_YEAR_RESET_LINKED_ENTRIES).
--
-- Existing data: a BEFORE DELETE trigger constrains no existing row, so there
-- is nothing to validate and nothing to backfill.
--
-- pg-test: tests/pg/asset-depreciation-atomic.pg.test.ts

-- =============================================================================
-- 1. A posted schedule row cannot be deleted
-- =============================================================================

CREATE OR REPLACE FUNCTION public.block_posted_depreciation_schedule_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  -- Unposted proposals are free to go, and never pay for the flag lookup.
  IF OLD.journal_entry_id IS NULL THEN
    RETURN OLD;
  END IF;

  -- Tenant teardown removes the row together with the verifikat it points at.
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Cannot delete a posted depreciation schedule (id=%): it is linked to journal entry %',
    OLD.id, OLD.journal_entry_id
    USING ERRCODE = '23514',
          HINT = 'Reverse the depreciation voucher or dispose the asset. The register row is räkenskapsinformation (BFL 7 kap.).';
END;
$function$;

DROP TRIGGER IF EXISTS block_posted_depreciation_schedule_delete ON public.depreciation_schedules;
CREATE TRIGGER block_posted_depreciation_schedule_delete
  BEFORE DELETE ON public.depreciation_schedules
  FOR EACH ROW EXECUTE FUNCTION public.block_posted_depreciation_schedule_delete();

-- =============================================================================
-- 2. commit_asset_depreciation: voucher and register link in one transaction
-- =============================================================================

CREATE OR REPLACE FUNCTION public.commit_asset_depreciation(
  p_company_id uuid,
  p_asset_id uuid,
  p_entry_id uuid,
  p_fiscal_period_id uuid,
  p_planned_depreciation numeric,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS TABLE(voucher_number integer, schedule_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_asset_user_id uuid;
  v_entry_user_id uuid;
  v_draft_debit numeric;
  v_schedule_id uuid;
  v_schedule_entry_id uuid;
  v_voucher_number integer;
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  -- Same NULL-safe membership guard as commit_asset_disposal.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND (
       NOT public.caller_is_company_member(p_company_id)
       OR NOT public.current_user_can_write()
     ) THEN
    RAISE EXCEPTION 'unauthorized asset depreciation for company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  IF p_planned_depreciation IS NULL OR p_planned_depreciation <= 0 THEN
    RAISE EXCEPTION 'Planned depreciation must be positive'
      USING ERRCODE = '23514';
  END IF;

  -- The asset row lock is what post-versus-delete serialises on:
  -- delete_never_posted_asset takes the same lock before it decides. A
  -- delete that won the race leaves no row here, and no voucher is posted.
  SELECT a.user_id
    INTO v_asset_user_id
    FROM public.assets a
   WHERE a.id = p_asset_id
     AND a.company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset not found: %', p_asset_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Pin what this RPC can post: a year_end draft of this company and period.
  SELECT je.user_id
    INTO v_entry_user_id
    FROM public.journal_entries je
   WHERE je.id = p_entry_id
     AND je.company_id = p_company_id
     AND je.fiscal_period_id = p_fiscal_period_id
     AND je.status = 'draft'
     AND je.source_type = 'year_end'
   FOR UPDATE;

  -- 22023, not P0002: a missing ASSET is an expected outcome of a concurrent
  -- delete that the caller skips, while a bad draft is a caller bug. Distinct
  -- SQLSTATEs let the engine tell them apart without parsing message text.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Valid depreciation draft not found: %', p_entry_id
      USING ERRCODE = '22023';
  END IF;

  -- The RPC is independently callable, so the amount the register records
  -- must be the amount the voucher books, not whatever the caller passes.
  SELECT coalesce(sum(l.debit_amount), 0)
    INTO v_draft_debit
    FROM public.journal_entry_lines l
   WHERE l.journal_entry_id = p_entry_id;

  IF abs(v_draft_debit - p_planned_depreciation) > 0.005 THEN
    RAISE EXCEPTION 'Planned depreciation % does not match the draft voucher total %',
      p_planned_depreciation, v_draft_debit
      USING ERRCODE = '23514';
  END IF;

  SELECT ds.id, ds.journal_entry_id
    INTO v_schedule_id, v_schedule_entry_id
    FROM public.depreciation_schedules ds
   WHERE ds.asset_id = p_asset_id
     AND ds.fiscal_period_id = p_fiscal_period_id
   FOR UPDATE;

  -- unique_violation on purpose: it IS the (asset_id, fiscal_period_id)
  -- invariant, met one step earlier than the constraint would meet it.
  IF FOUND AND v_schedule_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'Depreciation is already posted for asset % in this fiscal period', p_asset_id
      USING ERRCODE = '23505';
  END IF;

  -- Voucher first, link second: the order the old two-statement code used,
  -- now inside one transaction, so a failure at the link step takes the
  -- voucher commit (and its sequence increment) down with it.
  SELECT committed.voucher_number
    INTO v_voucher_number
    FROM public.commit_journal_entry(
      p_company_id,
      p_entry_id,
      NULL,
      NULL,
      p_actor_type,
      p_actor_label
    ) AS committed;

  IF v_schedule_id IS NOT NULL THEN
    UPDATE public.depreciation_schedules
       SET planned_depreciation = p_planned_depreciation,
           journal_entry_id = p_entry_id,
           posted_at = now()
     WHERE id = v_schedule_id;
  ELSE
    INSERT INTO public.depreciation_schedules (
      user_id,
      company_id,
      asset_id,
      fiscal_period_id,
      planned_depreciation,
      journal_entry_id,
      posted_at
    ) VALUES (
      coalesce(v_entry_user_id, v_asset_user_id),
      p_company_id,
      p_asset_id,
      p_fiscal_period_id,
      p_planned_depreciation,
      p_entry_id,
      now()
    )
    RETURNING id INTO v_schedule_id;
  END IF;

  RETURN QUERY SELECT v_voucher_number, v_schedule_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.commit_asset_depreciation(
  uuid, uuid, uuid, uuid, numeric, text, text
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.commit_asset_depreciation(
  uuid, uuid, uuid, uuid, numeric, text, text
) TO authenticated, service_role;

COMMENT ON FUNCTION public.commit_asset_depreciation(
  uuid, uuid, uuid, uuid, numeric, text, text
) IS 'Atomically posts a planenlig avskrivning voucher and links its depreciation_schedules row, under the asset row lock. Voucher numbering is delegated to commit_journal_entry.';

-- =============================================================================
-- 3. delete_never_posted_asset: the rule decided under the same lock
-- =============================================================================
--
-- SECURITY INVOKER on purpose: the delete keeps running as the caller, so the
-- assets_delete / depreciation_schedules_delete RLS policies and the
-- company-writer-role trigger apply exactly as they did when this was two
-- PostgREST statements. Expected outcomes are returned, not raised: nothing
-- has been written when the answer is a refusal.

CREATE OR REPLACE FUNCTION public.delete_never_posted_asset(
  p_company_id uuid,
  p_asset_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_disposed_at date;
  v_disposal_entry_id uuid;
BEGIN
  SELECT a.disposed_at, a.disposal_journal_entry_id
    INTO v_disposed_at, v_disposal_entry_id
    FROM public.assets a
   WHERE a.id = p_asset_id
     AND a.company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  IF v_disposed_at IS NOT NULL OR v_disposal_entry_id IS NOT NULL THEN
    RETURN 'disposed';
  END IF;

  -- Read AFTER the lock is held. A posting that was in flight has committed
  -- by now and its link is visible; one that starts later waits on the lock.
  IF EXISTS (
    SELECT 1
      FROM public.depreciation_schedules ds
     WHERE ds.company_id = p_company_id
       AND ds.asset_id = p_asset_id
       AND ds.journal_entry_id IS NOT NULL
  ) THEN
    RETURN 'depreciation_posted';
  END IF;

  DELETE FROM public.depreciation_schedules ds
   WHERE ds.company_id = p_company_id
     AND ds.asset_id = p_asset_id
     AND ds.journal_entry_id IS NULL;

  DELETE FROM public.assets a
   WHERE a.id = p_asset_id
     AND a.company_id = p_company_id;

  RETURN 'deleted';
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_never_posted_asset(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_never_posted_asset(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.delete_never_posted_asset(uuid, uuid)
  IS 'Deletes an asset that never reached the books, deciding under the asset row lock so it serialises with commit_asset_depreciation and commit_asset_disposal. Returns deleted, not_found, disposed or depreciation_posted.';

NOTIFY pgrst, 'reload schema';
