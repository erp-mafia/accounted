-- Four more sandbox-teardown blockers, all added or missed since
-- 20260807170000. Nine sandbox tenants are stuck on prod (oldest settings row
-- 2026-07-22), retried by the nightly cron and failing forever, so anonymous
-- demo tenants accumulate instead of being torn down:
--
--   1. supplier_payment_batch_items references supplier_invoices through the
--      composite FK fk_supplier_payment_batch_items_invoice with ON DELETE
--      RESTRICT. The table shipped 2026-08-10, after the last cleanup fix, so
--      any sandbox visitor who generated a betalfil blocks the
--      supplier_invoices delete. The batch header cascades to its items
--      (fk_supplier_payment_batch_items_batch), so deleting the batches is
--      enough and no guard trigger stands in the way.
--   2. fiscal_periods.opening_balance_entry_id and .closing_entry_id are both
--      plain NO ACTION FKs into journal_entries, so the journal delete fails
--      while a period still points at an IB or bokslut voucher. NULLing them
--      is itself blocked by enforce_opening_balance_immutability, which has
--      no sandbox bypass.
--   3. webhook_deliveries rows in terminal status ('delivered', 'dead') are
--      blocked by block_webhook_delivery_terminal_delete, which raises
--      unconditionally. Those rows reach the trigger through the
--      auth.users -> companies -> webhook_deliveries cascade.
--   4. payment_match_log rows whose company_id IS NULL fail the shared
--      audit_log_immutable() bypass, because that bypass requires
--      OLD.company_id IS NOT NULL. lib/invoices/match-log.ts has written
--      company_id-less rows since the table shipped (7103 of them on prod),
--      and payment_match_log_user_id_fkey ON DELETE CASCADE drags them into
--      the auth.users delete. The table is also reached as an UPDATE:
--      payment_match_log_supplier_invoice_id_fkey is ON DELETE SET NULL, so
--      the supplier_invoices delete rewrites any row that points at one, and
--      the UPDATE branch of the guard stays unconditional. The purge
--      therefore runs before the supplier_invoices delete, not just before
--      the auth.users one.
--
-- Three decisions worth writing down, because the obvious reading of each
-- goes the other way:
--
--   * closing_entry_id is cleared too, not just opening_balance_entry_id, and
--     the sandbox bypass covers the whole trigger rather than the
--     opening-balance clause alone. No stale sandbox has closing_entry_id set
--     today, so a narrower fix would also pass, and would then break again
--     the first time a sandbox visitor runs a bokslut:
--     fiscal_periods_closing_entry_id_fkey is NO ACTION as well. The year-end
--     immutability the clause protects guards a ledger that ceases to exist a
--     few statements later.
--   * the opening-balance RAISE loses its em dash (repo rule: no em or en
--     dashes) and gains the colon its sibling clause already uses. Both
--     assertions in the tree match the tail of the sentence
--     (lib/bookkeeping/__tests__/engine.pg.test.ts and
--     tests/pg/closing-entry-detach.pg.test.ts) and no runtime code maps the
--     text, so no caller notices.
--   * payment_match_log gets its own guard function instead of a relaxed
--     audit_log_immutable(). That function also guards audit_log, event_log
--     and processing_history; processing_history has no user_id column at
--     all, so a bypass branch reading OLD.user_id could not live there.
--
-- Every bypass follows the 20260807 chain: a transaction-local flag that only
-- cleanup_sandbox_user sets, after its all-rows is_sandbox check, re-verified
-- per row against company_settings so the flag alone can never unlock a real
-- tenant. UPDATE stays forbidden on both audit-shaped logs.
--
-- Known residual risk, deliberately not fixed here: cleanup_sandbox_user
-- enumerates blockers one table at a time, and prod still has unhandled
-- RESTRICT / NO ACTION FKs into the tables it deletes (accrual_schedules,
-- accrual_schedule_installments, assets.disposal_journal_entry_id,
-- depreciation_schedules, peppol_deliveries, rot_rut_payout_request_items,
-- agi_declarations, stripe_payment_events, stripe_payouts,
-- vacation_year_closures, webshop_orders), and it never deletes
-- public.invoices at all. A read-only sweep of every one of those tables
-- against the nine stuck sandboxes returns zero rows today, so this does
-- clear the whole current backlog; a sandbox that exercises one of those
-- surfaces will need the next entry in this chain.

-- =============================================================================
-- 1. enforce_opening_balance_immutability: allow sandbox-teardown link clearing
-- =============================================================================

-- Body otherwise identical to 20260720140000, minus the em dash.

CREATE OR REPLACE FUNCTION public.enforce_opening_balance_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  -- Sandbox teardown clears the period's voucher links so the journal delete
  -- can proceed; the period itself dies with the tenant moments later. Flag
  -- first so a normal tenant never pays for the company_settings lookup, and
  -- per-row re-verification so the flag alone unlocks nothing.
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND EXISTS (
       SELECT 1 FROM public.company_settings cs
       WHERE cs.company_id = OLD.company_id AND cs.is_sandbox = true
     ) THEN
    RETURN NEW;
  END IF;

  -- Only check if opening_balance_entry_id is being changed
  IF OLD.opening_balance_entry_id IS NOT NULL
     AND OLD.opening_balances_set = true
     AND NEW.opening_balance_entry_id IS DISTINCT FROM OLD.opening_balance_entry_id THEN
    RAISE EXCEPTION 'Cannot modify opening_balance_entry_id on period "%": opening balances are immutable once set',
      OLD.name;
  END IF;

  -- Block changing closing_entry_id once set, UNLESS the referenced closing
  -- entry has been reversed by a real storno (administrative year-end undo).
  IF OLD.closing_entry_id IS NOT NULL
     AND NEW.closing_entry_id IS DISTINCT FROM OLD.closing_entry_id THEN

    IF NOT EXISTS (
      SELECT 1
      FROM journal_entries je
      JOIN journal_entries storno
        ON storno.reverses_id = je.id
       AND storno.source_type = 'storno'
       AND storno.status = 'posted'
       AND storno.company_id = OLD.company_id
      WHERE je.id = OLD.closing_entry_id
        AND je.company_id = OLD.company_id
        AND je.status = 'reversed'
    ) THEN
      RAISE EXCEPTION 'Cannot modify closing_entry_id on period "%": year-end closing is immutable',
        OLD.name;
    END IF;

    IF NEW.closing_entry_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM journal_entries ne
      WHERE ne.id = NEW.closing_entry_id
        AND ne.company_id = NEW.company_id
        AND ne.fiscal_period_id = NEW.id
        AND ne.source_type = 'year_end'
        AND ne.status = 'posted'
    ) THEN
      RAISE EXCEPTION 'closing_entry_id on period "%" must reference a posted year_end entry in the same period',
        OLD.name;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- =============================================================================
-- 2. block_webhook_delivery_terminal_delete: allow sandbox-teardown DELETE
-- =============================================================================

-- Body otherwise identical to 20260515190000. webhook_deliveries carries its
-- own company_id (NOT NULL, asserted against the parent webhook at INSERT),
-- so the per-row sandbox re-check needs no join through webhooks, which is
-- what makes it safe here: webhook_id is nullable and ON DELETE SET NULL.

CREATE OR REPLACE FUNCTION public.block_webhook_delivery_terminal_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND EXISTS (
       SELECT 1 FROM public.company_settings cs
       WHERE cs.company_id = OLD.company_id AND cs.is_sandbox = true
     ) THEN
    RETURN OLD;
  END IF;

  IF OLD.status IN ('delivered', 'dead') THEN
    RAISE EXCEPTION
      'webhook_deliveries row in terminal status (%) cannot be deleted (audit-log integrity policy; accounting-event rows additionally fall under BFL 7 kap 1 § retention)',
      OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

-- =============================================================================
-- 3. payment_match_log gets its own immutability guard
-- =============================================================================

CREATE OR REPLACE FUNCTION public.payment_match_log_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Sandbox teardown removes the whole demo tenant; its match log goes with
  -- it. Two accepted row shapes: a company_id that provably belongs to a
  -- sandbox company, or a NULL company_id whose user is provably a sandbox
  -- user. The second branch is the whole point of splitting this off
  -- audit_log_immutable(), and it only works while the company_settings row
  -- still exists, which is why cleanup_sandbox_user deletes these rows
  -- explicitly rather than letting the auth.users cascade reach them.
  -- UPDATE stays forbidden even during teardown.
  IF TG_OP = 'DELETE'
     AND current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND (
       (OLD.company_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.company_settings cs
          WHERE cs.company_id = OLD.company_id AND cs.is_sandbox = true
        ))
       OR
       (OLD.company_id IS NULL AND EXISTS (
          SELECT 1 FROM public.company_settings cs
          WHERE cs.user_id = OLD.user_id AND cs.is_sandbox = true
        ))
     ) THEN
    RETURN OLD;
  END IF;

  -- Same wording as audit_log_immutable(): app/api/transactions/[id]/route.ts
  -- matches this text to turn the cascade refusal into a Swedish 409.
  RAISE EXCEPTION 'Audit log entries cannot be modified or deleted';
END;
$$;

DROP TRIGGER IF EXISTS payment_match_log_no_update ON public.payment_match_log;
CREATE TRIGGER payment_match_log_no_update
  BEFORE UPDATE ON public.payment_match_log
  FOR EACH ROW EXECUTE FUNCTION public.payment_match_log_immutable();

DROP TRIGGER IF EXISTS payment_match_log_no_delete ON public.payment_match_log;
CREATE TRIGGER payment_match_log_no_delete
  BEFORE DELETE ON public.payment_match_log
  FOR EACH ROW EXECUTE FUNCTION public.payment_match_log_immutable();

-- =============================================================================
-- 4. cleanup_sandbox_user: clear the four blockers before the deletes
-- =============================================================================

-- Body otherwise identical to 20260807170000.

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
  -- settings row flagged sandbox.
  IF NOT EXISTS (
    SELECT 1 FROM public.company_settings cs WHERE cs.user_id = p_user_id
  ) OR EXISTS (
    SELECT 1 FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'User % is not a sandbox user', p_user_id;
  END IF;

  PERFORM set_config('gnubok.allow_delete', 'true', true);
  PERFORM set_config('gnubok.sandbox_cleanup', 'true', true);

  -- API keys must die with the sandbox, and api_keys.sod_acknowledged_by
  -- (NO ACTION to auth.users) otherwise blocks the auth delete.
  DELETE FROM public.api_keys WHERE user_id = p_user_id;

  -- WORM retag log: delete under the bypass while company_settings still
  -- exists, and before the journal deletes whose cascade would otherwise
  -- reach it.
  DELETE FROM public.dimension_retag_log
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  -- Match log: append-only, user-scoped on purpose, and purged this early for
  -- two reasons. lib/invoices/match-log.ts writes rows with no company_id, and
  -- the guard can only recognise those as sandbox rows while the
  -- company_settings row still exists, which the auth.users cascade cannot
  -- promise (company_settings.user_id cascades from the same delete, and
  -- sibling cascade order is undefined). And payment_match_log.supplier_invoice_id
  -- is ON DELETE SET NULL, so the supplier_invoices delete further down turns
  -- into an UPDATE on any row that references one, which the guard still
  -- refuses even during teardown.
  DELETE FROM public.payment_match_log
  WHERE user_id = p_user_id
     OR company_id IN (
       SELECT cs.company_id FROM public.company_settings cs
       WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
     );

  UPDATE public.document_attachments
  SET journal_entry_id = NULL, journal_entry_line_id = NULL
  WHERE user_id = p_user_id;

  DELETE FROM public.document_attachments WHERE user_id = p_user_id;

  UPDATE public.salary_runs
  SET salary_entry_id = NULL,
      avgifter_entry_id = NULL,
      pension_entry_id = NULL,
      vacation_entry_id = NULL
  WHERE user_id = p_user_id;

  -- fiscal_periods points at its IB and bokslut vouchers with plain NO ACTION
  -- FKs, and previous_period_id chains periods to each other the same way.
  -- Clearing all three under the teardown bypass is what lets the journal
  -- delete below run at all.
  UPDATE public.fiscal_periods
  SET opening_balance_entry_id = NULL,
      closing_entry_id = NULL,
      previous_period_id = NULL
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  DELETE FROM public.journal_entry_lines
  WHERE journal_entry_id IN (
    SELECT id FROM public.journal_entries WHERE user_id = p_user_id
  );

  DELETE FROM public.journal_entries WHERE user_id = p_user_id;

  -- Betalfil batches: their items reference supplier_invoices with
  -- ON DELETE RESTRICT, so the batch headers must go first (the items
  -- cascade off the header, and neither table has a delete guard).
  DELETE FROM public.supplier_payment_batches
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  DELETE FROM public.supplier_invoices WHERE user_id = p_user_id;

  DELETE FROM public.pending_operations WHERE user_id = p_user_id;

  DELETE FROM public.dimensions
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  DELETE FROM public.processing_history
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  DELETE FROM public.invoice_deliveries
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  -- Terminal webhook deliveries: guarded against DELETE, and reached by the
  -- auth.users -> companies cascade unless purged here under the bypass.
  DELETE FROM public.webhook_deliveries
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  DELETE FROM public.audit_log
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  DELETE FROM auth.users WHERE id = p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  PERFORM set_config('gnubok.allow_delete', '', true);
  PERFORM set_config('gnubok.sandbox_cleanup', '', true);

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_sandbox_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_sandbox_user(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
