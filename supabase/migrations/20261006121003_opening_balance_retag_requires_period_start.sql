-- mark_entry_as_opening_balance: only a verifikat dated on the first day of
-- its fiscal year, and none with a bank link of any kind.
--
-- The design note of 20260613120000 says it outright: "There is no mid-period
-- opening_balance: a genuine IB always sits on a fiscal-period boundary on a
-- balance-sheet account." The RPC never checked the date, and the
-- reconciliation page offered "Märk som IB" on every unmatched ledger row, so
-- a dated rättelse (or any mid-year verifikat) could be re-tagged as the
-- account's opening balance just to clear the list: the verifikat would leave
-- the period movement and the reconciliation would hide a real event (agent
-- feedback seq 878478). The page now offers the action only on a verifikat
-- dated on its fiscal year's period_start; this is the server side of the
-- same rule.
--
-- The linked-transaction refusal (20260723160000) read only the pointer
-- column. A verifikat partially settled by 1:N slices now stays in the
-- unmatched ledger list with its remainder (20261006121002), so a junction
-- link counts as a bank-feed counterpart too: such a verifikat is not an IB.
--
-- Body otherwise verbatim from 20260723160000 (the latest definition, which
-- kept the 20260619130100 claims-based tenant guard).

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
  v_period_start    date;
  v_has_bank_line   boolean;
  v_old_source_type text;
  v_jwt_role        text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
BEGIN
  -- Tenant guard: anon/authenticated may only act on their own companies;
  -- service_role / direct access (no JWT role) bypasses BY DESIGN.
  -- NULL-safe membership predicate (20260703180000): the raw
  -- NOT IN (SELECT user_company_ids()) pattern skips the deny branch on
  -- UNKNOWN and is ratchet-blocked by null-safe-tenant-guards.pg.test.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND NOT public.caller_is_company_member(p_company_id) THEN
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

  -- An entry with a linked bank transaction has a bank-feed counterpart and is
  -- therefore not an opening balance (a genuine IB predates the feed). It would
  -- also strand the linked transaction against an excluded entry, creating a
  -- permanent reconciliation difference. Unlink first if the tag is truly right.
  -- The pointer and the junction (1:N slices, bulk-book, residual) alike.
  IF EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.journal_entry_id = p_entry_id
      AND t.company_id = p_company_id
  ) OR EXISTS (
    SELECT 1 FROM transaction_voucher_links l
    WHERE l.journal_entry_id = p_entry_id
      AND l.company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'Entry has linked bank transactions; unlink them before re-tagging as opening balance';
  END IF;

  SELECT is_closed, locked_at, period_start INTO v_is_closed, v_locked_at, v_period_start
  FROM fiscal_periods
  WHERE id = v_entry.fiscal_period_id;

  -- An opening balance is the position at the start of a fiscal year, so it
  -- is dated on that year's first day. A mid-year verifikat (a rättelse, a
  -- payment) is a movement in the year, never an IB.
  IF v_entry.entry_date IS DISTINCT FROM v_period_start THEN
    RAISE EXCEPTION 'Only an entry dated on the first day of its fiscal period can be re-tagged as opening balance (entry date %, period start %)',
      v_entry.entry_date, v_period_start;
  END IF;

  -- Respect period lock (mirror delete_last_voucher). enforce_period_lock would
  -- block the UPDATE anyway; we refuse first with a clearer message.
  IF v_is_closed THEN
    RAISE EXCEPTION 'Cannot re-tag an entry in a closed fiscal period';
  END IF;
  IF v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot re-tag an entry in a locked fiscal period';
  END IF;

  v_old_source_type := v_entry.source_type;

  -- Transaction-local bypass consumed by the immutability carve-out
  -- (20260613120000).
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

NOTIFY pgrst, 'reload schema';
