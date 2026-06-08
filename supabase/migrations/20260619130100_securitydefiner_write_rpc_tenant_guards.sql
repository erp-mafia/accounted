-- Tenant guards on four SECURITY DEFINER write RPCs (P0 tenant backstop).
--
-- These RPCs run with the definer's privileges and bypass the caller's RLS, and
-- all are EXECUTE-able by `authenticated`. The canonical guard (introduced on
-- the GL read RPCs in PR #625 and on the voucher-link write RPCs in
-- 20260615120000_link_voucher_rpcs_tenant_guard.sql, lines 54-69) reads the
-- request.jwt.claims role and, for anon/authenticated callers only, requires
-- membership of p_company_id (public.user_company_ids()). service_role and
-- direct/superuser callers (no JWT role — migrations, the pg-real harness, and
-- the MCP / API-key paths whose company scoping happens in TS) bypass the guard
-- BY DESIGN, so this change cannot affect those flows.
--
-- Deliberately NOT guarded here: bulk_book_transactions and
-- match_batch_allocate. Both already enforce membership via an in-function
-- auth.uid() check that returns a structured domain error
-- ({ok:false, code:'BULK_BOOK_UNAUTHORIZED' / 'BATCH_UNAUTHORIZED'}) that the
-- routes, MCP tools, and existing pg tests branch on. Prepending a raise-style
-- guard would change that error contract from jsonb to a 42501 exception for
-- authenticated cross-tenant callers — a behavioural break for no isolation
-- gain. They are tenant-safe as-is.
--
-- Of the four guarded here: mark_entry_as_opening_balance already raised
-- (P0001) for non-members and rotate_company_inbox already raised 42501 for
-- non-owner/admin — the uniform guard tightens both to a consistent 42501
-- without changing exception-vs-success behaviour. The two voucher-range RPCs
-- (reserve_voucher_range, release_voucher_range) had NO tenant check at all —
-- those are the real gap this migration closes.
--
-- Each function body below is copied verbatim from its latest definition; only
-- the guard block (and, where present, a v_jwt_role DECLARE) is added. Existing
-- GRANTs are re-applied because CREATE OR REPLACE preserves privileges but a
-- DROP+CREATE resets them.
--
-- The two voucher-range RPCs additionally gain (Swedish compliance review on
-- PR #680): a period-lock guard (BFL 5 kap 5§ — the sequence of a closed or
-- locked period is räkenskapsinformation, mirroring mark_entry_as_opening_balance)
-- and, on release, a sequence-integrity assert (BFL 5 kap 6–7§ — never roll
-- last_number back below an existing verifikat). Neither fires in the legit
-- SIE-import flow, which only releases numbers above its highest inserted
-- verifikat into an open period.
--
--   mark_entry_as_opening_balance   — latest 20260613120000_mark_entry_as_opening_balance.sql
--   reserve_voucher_range           — latest 20260402075153_fix_reserve_voucher_range.sql
--   release_voucher_range           — latest 20260402075153_fix_reserve_voucher_range.sql
--   rotate_company_inbox            — latest 20260420190000_inbox_hardening.sql
-- =============================================================================
-- 1. mark_entry_as_opening_balance
-- =============================================================================
CREATE OR REPLACE FUNCTION public.mark_entry_as_opening_balance(
  p_company_id uuid,
  p_entry_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller_role     text;
  v_entry           record;
  v_is_closed       boolean;
  v_locked_at       timestamptz;
  v_has_bank_line   boolean;
  v_old_source_type text;
  v_jwt_role        text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
BEGIN
  -- Tenant guard: anon/authenticated may only act on their own companies;
  -- service_role / direct access (no JWT role) bypasses BY DESIGN.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND p_company_id NOT IN (SELECT public.user_company_ids()) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Owner/admin only (defense in depth alongside RLS; the function is SECURITY
  -- DEFINER so it must enforce tenancy + role itself).
  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = auth.uid();

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only company owners and admins can re-tag opening balances';
  END IF;

  SELECT * INTO v_entry
  FROM journal_entries
  WHERE id = p_entry_id
    AND company_id = p_company_id
  FOR UPDATE;

  IF v_entry IS NULL THEN
    RAISE EXCEPTION 'Journal entry not found';
  END IF;

  IF v_entry.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted entries can be re-tagged as opening balance (current status: %)', v_entry.status;
  END IF;

  IF v_entry.source_type NOT IN ('manual', 'import') THEN
    RAISE EXCEPTION 'Only manual/import entries can be re-tagged as opening balance (current source_type: %)', v_entry.source_type;
  END IF;

  -- Must touch a bank/cash account. Re-tagging excludes the WHOLE entry from the
  -- reconciliation period movement, so it must genuinely be a bank-account IB.
  SELECT EXISTS (
    SELECT 1 FROM journal_entry_lines l
    WHERE l.journal_entry_id = p_entry_id
      AND l.account_number IN ('1910','1920','1930','1931','1932','1940','1941','1950')
  ) INTO v_has_bank_line;

  IF NOT v_has_bank_line THEN
    RAISE EXCEPTION 'Entry does not touch a bank/cash account (19xx); refusing to tag as opening balance';
  END IF;

  -- Respect period lock (mirror delete_last_voucher). enforce_period_lock would
  -- block the UPDATE anyway; we refuse first with a clearer message.
  SELECT is_closed, locked_at INTO v_is_closed, v_locked_at
  FROM fiscal_periods
  WHERE id = v_entry.fiscal_period_id;

  IF v_is_closed THEN
    RAISE EXCEPTION 'Cannot re-tag an entry in a closed fiscal period';
  END IF;
  IF v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot re-tag an entry in a locked fiscal period';
  END IF;

  v_old_source_type := v_entry.source_type;

  -- Transaction-local bypass consumed by the immutability carve-out above.
  PERFORM set_config('gnubok.allow_source_type_retag', 'true', true);

  UPDATE journal_entries
  SET source_type = 'opening_balance'
  WHERE id = p_entry_id
    AND company_id = p_company_id;

  -- Provenance row (write_audit_log also logs old/new state via the AFTER trigger;
  -- this adds the human-readable reason, matching the delete_last_voucher pattern).
  INSERT INTO audit_log (user_id, company_id, action, table_name, record_id, actor_id, description)
  VALUES (
    v_entry.user_id,
    p_company_id,
    'UPDATE',
    'journal_entries',
    p_entry_id,
    auth.uid(),
    'Re-tagged source_type ' || v_old_source_type || ' -> opening_balance ' ||
    '(mark_entry_as_opening_balance RPC, caller: ' || auth.uid() || ')'
  );

  RETURN jsonb_build_object(
    'retagged', true,
    'entry_id', p_entry_id,
    'previous_source_type', v_old_source_type,
    'voucher_series', v_entry.voucher_series,
    'voucher_number', v_entry.voucher_number
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.mark_entry_as_opening_balance(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_entry_as_opening_balance(uuid, uuid) TO authenticated;

-- =============================================================================
-- 2. reserve_voucher_range
-- =============================================================================
CREATE OR REPLACE FUNCTION public.reserve_voucher_range(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_series text,
  p_highest_used integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_is_closed boolean;
  v_locked_at timestamptz;
BEGIN
  -- Tenant guard: anon/authenticated may only act on their own companies;
  -- service_role / direct access (no JWT role) bypasses BY DESIGN.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND p_company_id NOT IN (SELECT public.user_company_ids()) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Period-lock guard (BFL 5 kap 5§ / BFNAR 2013:2): the voucher sequence of a
  -- closed or locked period is part of its räkenskapsinformation — refuse to
  -- mutate it, mirroring mark_entry_as_opening_balance. (An unknown period id
  -- leaves both NULL and falls through to the FK violation, as before.)
  SELECT fp.is_closed, fp.locked_at INTO v_is_closed, v_locked_at
  FROM public.fiscal_periods fp WHERE fp.id = p_fiscal_period_id;
  IF v_is_closed OR v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot reserve voucher numbers in a closed/locked fiscal period';
  END IF;

  INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_company_id, auth.uid(), p_fiscal_period_id, p_series, p_highest_used)
  ON CONFLICT (company_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = GREATEST(public.voucher_sequences.last_number, EXCLUDED.last_number),
    updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_voucher_range(uuid, uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_voucher_range(uuid, uuid, text, integer) TO authenticated;

-- =============================================================================
-- 3. release_voucher_range
-- =============================================================================
CREATE OR REPLACE FUNCTION public.release_voucher_range(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_series text,
  p_actual_last integer,
  p_reserved_highest integer  -- the ceiling this import originally reserved
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_is_closed boolean;
  v_locked_at timestamptz;
BEGIN
  -- Tenant guard: anon/authenticated may only act on their own companies;
  -- service_role / direct access (no JWT role) bypasses BY DESIGN.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND p_company_id NOT IN (SELECT public.user_company_ids()) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Period-lock guard (BFL 5 kap 5§ / BFNAR 2013:2), mirroring
  -- mark_entry_as_opening_balance. NOTE: the SIE-import caller does not treat a
  -- failed release as fatal — the sequence then simply stays at the reserved
  -- ceiling and the voucher-gap machinery documents the gap.
  SELECT fp.is_closed, fp.locked_at INTO v_is_closed, v_locked_at
  FROM public.fiscal_periods fp WHERE fp.id = p_fiscal_period_id;
  IF v_is_closed OR v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot release voucher numbers in a closed/locked fiscal period';
  END IF;

  -- Sequence-integrity guard (BFL 5 kap 6–7§): never roll last_number back
  -- below an existing verifikat — releasing a range that contains posted
  -- numbers would let the sequence re-issue them (duplicate verifikationsnummer)
  -- or imply gaps where none should exist.
  IF EXISTS (
    SELECT 1 FROM public.journal_entries je
    WHERE je.company_id = p_company_id
      AND je.fiscal_period_id = p_fiscal_period_id
      AND je.voucher_series = p_series
      AND je.voucher_number > p_actual_last
      AND je.voucher_number <= p_reserved_highest
  ) THEN
    RAISE EXCEPTION 'Cannot release voucher range (%, %]: verifikat exist in the released range', p_actual_last, p_reserved_highest;
  END IF;

  -- Only release within the range this import originally reserved.
  -- The upper-bound guard (last_number <= p_reserved_highest) prevents rolling
  -- back past numbers that a concurrent operation has legitimately claimed.
  UPDATE public.voucher_sequences
  SET last_number = p_actual_last,
      updated_at = now()
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id
    AND voucher_series = p_series
    AND last_number > p_actual_last
    AND last_number <= p_reserved_highest;
END;
$$;

REVOKE ALL ON FUNCTION public.release_voucher_range(uuid, uuid, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_voucher_range(uuid, uuid, text, integer, integer) TO authenticated;

-- =============================================================================
-- 4. rotate_company_inbox
-- =============================================================================
CREATE OR REPLACE FUNCTION public.rotate_company_inbox(p_company_id uuid)
RETURNS public.company_inboxes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_name text;
  v_local_part text;
  v_slug_seed text;
  v_new_row public.company_inboxes;
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
BEGIN
  -- Tenant guard: anon/authenticated may only act on their own companies;
  -- service_role / direct access (no JWT role) bypasses BY DESIGN.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND p_company_id NOT IN (SELECT public.user_company_ids()) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Authorization: caller must be owner/admin of the company.
  IF NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE company_id = p_company_id
      AND user_id = auth.uid()
      AND role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Not authorized to rotate inbox for this company'
      USING ERRCODE = '42501';
  END IF;

  SELECT name INTO v_company_name
  FROM public.companies
  WHERE id = p_company_id;

  IF v_company_name IS NULL THEN
    RAISE EXCEPTION 'Company not found' USING ERRCODE = 'P0002';
  END IF;

  -- All three steps share one transaction — a failure on any of them
  -- rolls the whole thing back, so the company never ends up without
  -- an active inbox.

  UPDATE public.company_inboxes
  SET status = 'deprecated',
      deprecated_at = now()
  WHERE company_id = p_company_id
    AND status = 'active';

  v_local_part := public.generate_inbox_local_part(v_company_name);
  v_slug_seed := regexp_replace(v_local_part, '-[^-]+$', '');

  INSERT INTO public.company_inboxes (company_id, local_part, slug_seed, status)
  VALUES (p_company_id, v_local_part, v_slug_seed, 'active')
  RETURNING * INTO v_new_row;

  RETURN v_new_row;
END;
$$;

REVOKE ALL ON FUNCTION public.rotate_company_inbox(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rotate_company_inbox(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
