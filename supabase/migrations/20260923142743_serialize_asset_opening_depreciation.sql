-- Serialize opening-balance edits with asset depreciation posting.
-- Keep the company-before-asset lock order and all existing voucher checks.
-- pg-test: covered-by tests/pg/asset-depreciation-atomic.pg.test.ts

CREATE OR REPLACE FUNCTION public.commit_asset_depreciation(
  p_company_id uuid,
  p_asset_id uuid,
  p_entry_id uuid,
  p_fiscal_period_id uuid,
  p_planned_depreciation numeric,
  p_expected_opening_amount numeric,
  p_expected_opening_date date,
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
  v_opening_amount numeric;
  v_opening_date date;
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
  PERFORM public.lock_cash_account_company(p_company_id);

  SELECT a.user_id, a.opening_accumulated_depreciation, a.opening_depreciation_date
    INTO v_asset_user_id, v_opening_amount, v_opening_date
    FROM public.assets a
   WHERE a.id = p_asset_id
     AND a.company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset not found: %', p_asset_id
      USING ERRCODE = 'P0002';
  END IF;

  -- The proposal was calculated before this transaction. Refuse a stale
  -- opening snapshot under the same row lock used by opening updates.
  IF v_opening_amount IS DISTINCT FROM p_expected_opening_amount
     OR v_opening_date IS DISTINCT FROM p_expected_opening_date THEN
    RAISE EXCEPTION 'ASSET_OPENING_CHANGED' USING ERRCODE = 'PT409';
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
  uuid, uuid, uuid, uuid, numeric, numeric, date, text, text
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.commit_asset_depreciation(
  uuid, uuid, uuid, uuid, numeric, numeric, date, text, text
) TO authenticated, service_role;

COMMENT ON FUNCTION public.commit_asset_depreciation(
  uuid, uuid, uuid, uuid, numeric, numeric, date, text, text
) IS 'Atomically posts a planenlig avskrivning voucher and links its depreciation_schedules row, under the asset row lock. Voucher numbering is delegated to commit_journal_entry.';

-- Old clients cannot describe an opening balance. Keep their signature for
-- zero-opening assets, but do not let it bypass the new snapshot check.
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
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT * FROM public.commit_asset_depreciation(
    p_company_id, p_asset_id, p_entry_id, p_fiscal_period_id,
    p_planned_depreciation, 0::numeric, NULL::date, p_actor_type, p_actor_label
  );
$function$;

-- UPDATE already holds the asset row lock before this trigger runs. A
-- concurrent posting either waits for the update and checks its snapshot,
-- or commits first and makes this check refuse the opening edit.
CREATE FUNCTION public.enforce_asset_opening_after_depreciation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.depreciation_schedules ds
    WHERE ds.asset_id = OLD.id AND ds.company_id = OLD.company_id
      AND ds.journal_entry_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'ASSET_CORRECTION_BLOCKED' USING ERRCODE = 'PT409';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.enforce_asset_opening_after_depreciation() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER enforce_asset_opening_after_depreciation
BEFORE UPDATE OF opening_accumulated_depreciation, opening_depreciation_date ON public.assets
FOR EACH ROW
WHEN (OLD.opening_accumulated_depreciation IS DISTINCT FROM NEW.opening_accumulated_depreciation
   OR OLD.opening_depreciation_date IS DISTINCT FROM NEW.opening_depreciation_date)
EXECUTE FUNCTION public.enforce_asset_opening_after_depreciation();

NOTIFY pgrst, 'reload schema';
