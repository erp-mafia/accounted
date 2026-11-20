-- Daily collections batch (build spec 3.6): once a day the ladder cron
-- (src/app/api/collections/ladder/cron/route.ts) gathers a company's overdue
-- invoices and the case decisions it waits for into ONE staged pending
-- operation, collections_daily_batch, which only an administrator approves,
-- in the web UI, after reviewing it. Nothing is sent before that approval:
-- there is no timer, no auto-approve and no "send unless stopped".
--
-- This migration adds:
--   1. customers.collections_excluded: "Skicka aldrig till inkasso". Such a
--      customer's invoices never become batch candidates.
--   2. collections_daily_batch in the pending_operations type CHECK (same
--      expand pattern as 20261012030201: the full list re-stated from that
--      migration, the latest definition, which carries main's
--      20261011203400 list (bank payment orders, update_supplier and the
--      POS sales operations included), the new value appended, NOT VALID;
--      the VALIDATE runs in 20261012030700). Every later migration that
--      rebuilds this list restates it with this value, or it drops the
--      value again.
--   3. One pending batch per company, and one batch per company and day
--      (whatever became of it), as unique partial indexes, so two cron runs
--      racing each other cannot stage twice.
--   4. Only the system stages a batch, never a member through the API. Once
--      staged, its params, type and preview are frozen like every staged
--      operation's (enforce_pending_operations_input_frozen, BFL 7 kap.).
--   5. collection_batch_removals and remove_collection_batch_items: the
--      review dialog's "Bocka ur dem du inte vill skicka". An owner or
--      administrator takes items out of a pending batch; nothing is ever
--      added, and the staged params stay as they were. The commit sends
--      the staged items less the removed ones. Every removal writes an
--      audit_log row naming the person.
--
-- pg-test: tests/pg/collection-daily-batch.pg.test.ts,
--          tests/pg/pending-operations-op-type-audit.pg.test.ts

-- =============================================================================
-- 1. customers.collections_excluded
-- =============================================================================

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS collections_excluded boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.customers.collections_excluded IS
  'Skicka aldrig till inkasso: the daily collections batch never proposes this customer''s invoices.';

-- =============================================================================
-- 2. pending_operations.operation_type: collections_daily_batch
-- =============================================================================

ALTER TABLE public.pending_operations
  DROP CONSTRAINT IF EXISTS pending_operations_operation_type_check;

ALTER TABLE public.pending_operations
  ADD CONSTRAINT pending_operations_operation_type_check
  CHECK (operation_type IN (
    'categorize_transaction',
    'create_customer',
    'create_invoice',
    'mark_invoice_paid',
    'send_invoice',
    'mark_invoice_sent',
    'match_transaction_invoice',
    'close_period',
    'lock_period',
    'unlock_period',
    'set_opening_balances',
    'run_year_end',
    'post_kontantmetod_cutoff',
    'run_currency_revaluation',
    'import_sie',
    'explain_voucher_gap',
    'uncategorize_transaction',
    'approve_supplier_invoice',
    'credit_supplier_invoice',
    'credit_invoice',
    'convert_invoice',
    'delete_draft_invoice',
    'create_transaction',
    'attach_document_to_transaction',
    'create_voucher',
    'correct_entry',
    'reverse_entry',
    'create_supplier',
    'create_supplier_invoice_from_inbox',
    'post_annual_depreciation',
    'link_invoice_voucher',
    'undo_sie_import',
    'match_batch_allocate',
    'bulk_book_transactions',
    'create_salary_run',
    'generate_agi',
    'link_transaction_journal_entry',
    'link_supplier_invoice_voucher',
    'submit_vat_declaration',
    'submit_agi',
    'create_article',
    'update_article',
    'bulk_book_inbox_items',
    'create_dimension_value',
    'retag_line_dimensions',
    'link_document_to_voucher',
    'update_payslip_line',
    'set_run_salary',
    'update_salary_run',
    'register_absence',
    'create_employee',
    'update_employee',
    'set_employee_opening_balances',
    'vacation_year_close',
    'create_account',
    'update_account',
    'set_voucher_note',
    'book_salary_run',
    'delete_absence',
    'update_company_settings',
    'update_customer',
    'update_invoice',
    'create_recurring_schedule',
    'update_recurring_schedule',
    'log_mileage_trip',
    'book_mileage_period',
    'link_documents_to_vouchers',
    'reconciliation_match',
    'reconciliation_unmatch',
    'reconciliation_signoff',
    'reconciliation_residual',
    'book_skattekonto_row',
    'book_skattekonto_rows',
    'ignore_transaction',
    'create_sales_order',
    'transition_sales_order',
    'register_sales_order_delivery',
    'create_invoice_from_sales_order',
    'settle_rot_rut_payout',
    'create_asset',
    'update_asset',
    'dispose_asset',
    'arkiv_propose_fact',
    'link_rot_rut_payout_voucher',
    'create_dimension',
    'update_dimension',
    'delete_dimension',
    'create_cash_account',
    'update_cash_account',
    'set_primary_cash_account',
    'set_invoice_payee_default',
    'create_fiscal_period',
    'update_fiscal_period',
    'close_fiscal_period_external',
    'reopen_fiscal_period_external',
    'delete_account',
    'activate_accounts',
    'deactivate_accounts',
    'update_company_tax_profile',
    'update_bookkeeping_lock',
    'send_payslips',
    'revert_salary_run',
    'unapprove_salary_run',
    'attach_salary_expense_claims',
    'create_supplier_payment_batch',
    'cancel_supplier_payment_batch',
    'book_invoice',
    'bulk_book_invoices',
    'book_supplier_invoice',
    'create_expense_claim',
    'delete_expense_claim',
    'record_expense_payout',
    'match_expense_payout',
    'delete_document',
    'delete_inbox_item',
    'detach_document_from_transaction',
    'unmatch_inbox_item_transaction',
    'undo_bank_import',
    'correct_entry_metadata',
    'correct_entry_lines_inline',
    'redate_entry',
    'mark_no_document_required',
    'book_vat_settlement',
    'send_invoice_peppol',
    'register_peppol_participant',
    'request_peppol_access',
    'update_arsredovisning_narrative',
    'update_arsredovisning_compliance',
    'create_arsredovisning_version',
    'add_arsredovisning_signature',
    'set_opening_balances_manual',
    'correct_opening_balances',
    'delete_supplier_invoice',
    'uncredit_supplier_invoice',
    'update_supplier_invoice_item_account',
    'mark_vat_period_filed',
    'unmark_vat_period_filed',
    'add_salary_run_employee',
    'remove_salary_run_employee',
    'add_payslip_line',
    'delete_payslip_line',
    'mark_salary_run_paid',
    'correct_salary_run',
    'set_worked_days',
    'delete_worked_days',
    'add_employee_benefit',
    'update_employee_benefit',
    'delete_employee_benefit',
    'add_employee_recurring_line',
    'update_employee_recurring_line',
    'delete_employee_recurring_line',
    'delete_employee',
    'create_dimension_rule',
    'update_dimension_rule',
    'delete_dimension_rule',
    'split_opening_balances_per_project',
    'cancel_draft_entry',
    'mark_agi_period_filed',
    'prepare_payment_orders',
    'cancel_payment_order',
    'update_supplier',
    'connect_pos_venue',
    'disconnect_pos_connection',
    'update_pos_sales_settings',
    'book_pos_sales_day',
    'open_collection_case',
    'collection_case_action',
    'collections_daily_batch'
  )) NOT VALID;

-- =============================================================================
-- 3. One pending batch per company; one batch per company and day
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS pending_operations_collections_batch_pending_uniq
  ON public.pending_operations (company_id)
  WHERE operation_type = 'collections_daily_batch' AND status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS pending_operations_collections_batch_day_uniq
  ON public.pending_operations (company_id, (params ->> 'batch_date'))
  WHERE operation_type = 'collections_daily_batch';

-- =============================================================================
-- 4. Staged by the system only
-- =============================================================================

-- A member writing through the API (the authenticated or anon role) could
-- otherwise stage a batch whose rows say one thing and whose invoice ids
-- another. SECURITY INVOKER on purpose: current_user is the role that wrote
-- the row. The ladder cron stages with the service role.
CREATE OR REPLACE FUNCTION public.guard_collections_batch_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') OR COALESCE(auth.role(), '') IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'COLLECTION_BATCH_SYSTEM_ONLY: a collections batch is staged by Accounted only'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_collections_batch_insert() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER guard_collections_batch_insert
  BEFORE INSERT ON public.pending_operations
  FOR EACH ROW
  WHEN (NEW.operation_type = 'collections_daily_batch')
  EXECUTE FUNCTION public.guard_collections_batch_insert();

-- =============================================================================
-- 5. collection_batch_removals
-- =============================================================================

CREATE TABLE public.collection_batch_removals (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- The removal goes with its batch (only a sandbox teardown deletes one).
  pending_operation_id uuid NOT NULL REFERENCES public.pending_operations(id) ON DELETE CASCADE,
  -- Identifiers copied from the batch's frozen params. No foreign key: the
  -- record of what a person took out stays whatever happens to the invoice.
  invoice_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('open', 'start', 'approve_step')),
  -- Who took it out. No foreign key, like audit_log.actor_id: a trail of
  -- who decided, which account erasure turns into a tombstone id anyway.
  removed_by uuid NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collection_batch_removals_once UNIQUE (pending_operation_id, invoice_id, kind)
);

COMMENT ON TABLE public.collection_batch_removals IS
  'Items an owner or administrator took out of a pending daily collections batch before approving it. Append-only; written by remove_collection_batch_items only.';

CREATE INDEX collection_batch_removals_company_idx ON public.collection_batch_removals (company_id);

ALTER TABLE public.collection_batch_removals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "collection_batch_removals_select" ON public.collection_batch_removals
  FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));

-- Members read; only remove_collection_batch_items writes (SECURITY DEFINER),
-- and nothing updates or deletes a removal.
GRANT SELECT ON TABLE public.collection_batch_removals TO authenticated;
GRANT SELECT, INSERT ON TABLE public.collection_batch_removals TO service_role;
-- no-grant: anon on public.collection_batch_removals (company data, members only)

-- Take items out of a pending batch. Owner or administrator of the batch's
-- company only; the batch row is locked so a removal and the approval's
-- claim never interleave. Ids that are not in the batch, or already out of
-- it, are ignored; taking out the last remaining item is refused (the batch
-- is then rejected instead). Returns how many were taken out now and how
-- many remain.
CREATE OR REPLACE FUNCTION public.remove_collection_batch_items(p_operation_id uuid, p_invoice_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_op record;
  v_removed integer := 0;
  v_remaining integer := 0;
  v_total integer := 0;
  v_removed_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  SELECT id, company_id, operation_type, status, params
    INTO v_op
    FROM public.pending_operations
   WHERE id = p_operation_id
   FOR UPDATE;
  IF NOT FOUND OR v_op.operation_type <> 'collections_daily_batch'
     OR v_actor IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = v_op.company_id AND cm.user_id = v_actor) THEN
    RAISE EXCEPTION 'COLLECTION_BATCH_NOT_FOUND: no such collections batch' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.user_is_company_admin(v_op.company_id) THEN
    RAISE EXCEPTION 'COLLECTION_BATCH_ADMIN_ONLY: only an owner or administrator changes the batch' USING ERRCODE = '42501';
  END IF;
  IF v_op.status <> 'pending' THEN
    RAISE EXCEPTION 'COLLECTION_BATCH_NOT_PENDING: the batch is already decided' USING ERRCODE = '55000';
  END IF;

  -- The audit row names only what this call took out: not ids outside the
  -- batch, and not items an earlier call already removed.
  WITH inserted AS (
    INSERT INTO public.collection_batch_removals (company_id, pending_operation_id, invoice_id, kind, removed_by)
    SELECT DISTINCT v_op.company_id, v_op.id, (item ->> 'invoice_id')::uuid, item ->> 'kind', v_actor
      FROM jsonb_array_elements(COALESCE(v_op.params -> 'items', '[]'::jsonb)) AS item
     WHERE (item ->> 'invoice_id')::uuid = ANY (COALESCE(p_invoice_ids, ARRAY[]::uuid[]))
    ON CONFLICT ON CONSTRAINT collection_batch_removals_once DO NOTHING
    RETURNING invoice_id
  )
  SELECT count(*)::integer, COALESCE(array_agg(DISTINCT invoice_id), ARRAY[]::uuid[])
    INTO v_removed, v_removed_ids
    FROM inserted;

  SELECT count(*) INTO v_total
    FROM jsonb_array_elements(COALESCE(v_op.params -> 'items', '[]'::jsonb));
  SELECT count(*) INTO v_remaining
    FROM jsonb_array_elements(COALESCE(v_op.params -> 'items', '[]'::jsonb)) AS item
   WHERE NOT EXISTS (
     SELECT 1 FROM public.collection_batch_removals r
      WHERE r.pending_operation_id = v_op.id
        AND r.invoice_id = (item ->> 'invoice_id')::uuid
        AND r.kind = item ->> 'kind'
   );
  IF v_remaining = 0 AND v_total > 0 THEN
    RAISE EXCEPTION 'COLLECTION_BATCH_EMPTY: at least one item must remain' USING ERRCODE = '22023';
  END IF;

  IF v_removed > 0 THEN
    INSERT INTO public.audit_log
      (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description, actor_type, actor_label)
    VALUES (
      v_actor,
      v_op.company_id,
      'UPDATE',
      'pending_operations',
      v_op.id,
      v_actor,
      jsonb_build_object('operation_type', v_op.operation_type, 'remaining', v_remaining + v_removed),
      jsonb_build_object('operation_type', v_op.operation_type, 'remaining', v_remaining,
        'removed_invoice_ids', to_jsonb(v_removed_ids)),
      'Removed ' || v_removed::text || ' item(s) from a collections batch',
      COALESCE(nullif(current_setting('gnubok.actor_type', true), ''), 'user'),
      nullif(current_setting('gnubok.actor_label', true), '')
    );
  END IF;

  RETURN jsonb_build_object('removed', v_removed, 'remaining', v_remaining);
END;
$$;

REVOKE ALL ON FUNCTION public.remove_collection_batch_items(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_collection_batch_items(uuid, uuid[]) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
