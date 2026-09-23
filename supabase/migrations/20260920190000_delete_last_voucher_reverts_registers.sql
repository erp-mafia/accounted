-- delete_last_voucher: a register row must not outlive the verifikat it asserts.
--
-- Mechanism. Every FK from a register to journal_entries answers one question:
-- what happens to this row when its verifikat is deleted? The schema already
-- gives three answers. CASCADE ("follow it": journal_entry_lines,
-- transaction_voucher_links). RESTRICT / NO ACTION ("refuse the delete":
-- salary_runs, assets, accrual schedules, documents). And SET NULL ("forget
-- it"): expense_claims.journal_entry_id, supplier_invoice_payments
-- .journal_entry_id, supplier_invoices.payment_journal_entry_id. For those
-- three, "forget" is wrong, because the row's own state keeps asserting the
-- verifikat: a claim that is still 'registered' is a debt to the owner, a
-- payment row is a payment, status 'paid' is a booked payment. After a lawful
-- delete of the last voucher in a series the company showed a paid supplier
-- invoice that was never booked, a payment row with nothing behind it, and an
-- utlagg under "Betala ut utlagg" with no verifikat, and none of the three
-- could be removed by the user.
--
-- Why here and not in the route. PRs #2670 and #2688 (Magnus Wallin) fixed
-- most of this in the dashboard DELETE route, and this block carries their
-- rules over unchanged: address rows by id/FK because SET NULL erases the
-- lookup key, refuse on payout state, never touch a payslip line from the
-- voucher path, revert only this payment's share. Two things cannot be done
-- from the route. (1) It runs after the RPC has committed, so a "refusal" can
-- only log: the voucher is already gone and a PAID claim is left with no
-- verifikat. Here the refusal happens BEFORE anything is deleted. (2) It keys
-- on the entry's source_type, and one verifikat can back several registers
-- while source_type names only one. A privately paid supplier invoice is
-- booked as ONE verifikat with source_type 'expense_claim' that backs the
-- utlagg, the invoice's payment row and the invoice's paid state at once, so a
-- source_type-keyed cleanup removed the claim and left the invoice 'paid'.
-- This block finds registers by their FK to the entry, so that combination,
-- and a batch voucher (match_batch_allocate: one entry, source_id NULL, one
-- payment row per invoice), are covered by construction, atomically with the
-- delete, for every caller of this RPC.
--
-- Scope. Supplier side and utlagg only. Customer invoice payments stay with
-- syncInvoiceStatusFromPaymentEntry (lib/bookkeeping/payment-sync.ts): their
-- remaining_amount is the sign-aware, capped ROT/RUT customer share defined
-- once in lib/invoices/customer-share.ts, and that money math is not
-- duplicated into SQL here. The route therefore runs the TS sync for customer
-- payment vouchers only, so each register has exactly one writer.
--
-- What is NOT weakened (BFL 5 kap 7 par, BFNAR 2013:2 p. 9.16): the
-- last-in-series rule, the owner/admin gate, the period checks and the
-- audit_log snapshot are byte-for-byte 20260908095907. The snapshot gains a
-- 'register_effects' key naming what was reverted or removed. supplier_invoices
-- and expense_claims also carry write_audit_log triggers, so each change is
-- logged per row as well; the payment tables have no such trigger, which is
-- why the removed payment rows are written into the snapshot in full.
--
-- Documents are untouched beyond the existing unlink: the receipt survives
-- and stays reachable from its inbox item. invoice_inbox_items needs no code:
-- created_journal_entry_id clears by FK now, created_supplier_invoice_id
-- clears by FK when the user deletes the reverted invoice, and an item with
-- both NULL is unprocessed again and can be booked the right way.
--
-- Safe against existing data: CREATE OR REPLACE with an unchanged signature,
-- so grants are retained; no table, column, constraint or index changes.
--
-- pg-test: tests/pg/voucher-delete-registers.pg.test.ts

CREATE OR REPLACE FUNCTION public.delete_last_voucher(p_company_id uuid, p_entry_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_entry            record;
  v_period           record;
  v_max_voucher      integer;
  v_ref_count        integer;
  v_caller_role      text;
  v_snapshot         jsonb;
  v_lines_snapshot   jsonb;
  v_is_period_ib     boolean := false;
  v_claim_ids        uuid[];
  v_removed_payments jsonb := '[]'::jsonb;
  v_touched_invoices uuid[];
  v_register_effects jsonb := '{}'::jsonb;
BEGIN
  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = auth.uid();

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only company owners and admins can delete vouchers';
  END IF;

  SELECT * INTO v_entry
  FROM journal_entries
  WHERE id = p_entry_id
    AND company_id = p_company_id
  FOR UPDATE;

  IF v_entry IS NULL THEN
    RAISE EXCEPTION 'Journal entry not found';
  END IF;

  IF v_entry.status NOT IN ('posted', 'draft') THEN
    RAISE EXCEPTION 'Only posted or draft entries can be deleted (current status: %)', v_entry.status;
  END IF;

  SELECT jsonb_agg(to_jsonb(l)) INTO v_lines_snapshot
  FROM journal_entry_lines l
  WHERE l.journal_entry_id = p_entry_id;

  v_snapshot := to_jsonb(v_entry) || jsonb_build_object('lines', COALESCE(v_lines_snapshot, '[]'::jsonb));

  IF v_entry.status = 'draft' THEN
    PERFORM set_config('gnubok.allow_delete', 'true', true);

    UPDATE document_attachments
    SET journal_entry_id = NULL
    WHERE journal_entry_id = p_entry_id;

    DELETE FROM journal_entries WHERE id = p_entry_id;

    INSERT INTO audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, description)
    VALUES (
      v_entry.user_id,
      p_company_id,
      'DELETE',
      'journal_entries',
      p_entry_id,
      auth.uid(),
      v_snapshot,
      'Deleted draft journal entry (delete_last_voucher RPC, caller: ' || auth.uid() || ')'
    );

    RETURN jsonb_build_object(
      'deleted', true,
      'voucher_series', v_entry.voucher_series,
      'voucher_number', v_entry.voucher_number,
      'was_draft', true
    );
  END IF;

  SELECT * INTO v_period
  FROM fiscal_periods
  WHERE id = v_entry.fiscal_period_id
  FOR UPDATE;

  IF v_period.is_closed THEN
    RAISE EXCEPTION 'Cannot delete voucher in a closed fiscal period';
  END IF;

  IF v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot delete voucher in a locked fiscal period';
  END IF;

  PERFORM 1 FROM voucher_sequences
  WHERE company_id = p_company_id
    AND fiscal_period_id = v_entry.fiscal_period_id
    AND voucher_series = v_entry.voucher_series
  FOR UPDATE;

  SELECT MAX(voucher_number) INTO v_max_voucher
  FROM journal_entries
  WHERE company_id = p_company_id
    AND fiscal_period_id = v_entry.fiscal_period_id
    AND voucher_series = v_entry.voucher_series
    AND status NOT IN ('cancelled', 'draft');

  IF v_entry.voucher_number != v_max_voucher THEN
    RAISE EXCEPTION 'Kan bara radera det sista verifikatet i serien. % har nummer % men senaste är %',
      v_entry.voucher_series, v_entry.voucher_number, v_max_voucher;
  END IF;

  SELECT COUNT(*) INTO v_ref_count
  FROM journal_entries
  WHERE company_id = p_company_id
    AND status != 'cancelled'
    AND (reverses_id = p_entry_id OR correction_of_id = p_entry_id);

  IF v_ref_count > 0 THEN
    RAISE EXCEPTION 'Cannot delete: other entries reference this voucher (% references)',
      v_ref_count;
  END IF;

  -- ===== Registers that hang on this verifikat (see the file header) =====
  -- Refusals first, mutations after: nothing below may change a row before
  -- every reason to refuse the whole delete has been checked.

  -- Utlagg, by the forward FK and by the entry's own source link (covers a
  -- failed back-link write). Locked: create_expense_payout_batch and
  -- settle_expense_claims_via_salary_run lock the same rows, so payout state
  -- cannot appear between this check and the delete.
  SELECT array_agg(c.id) INTO v_claim_ids
  FROM (
    SELECT ec.id
    FROM expense_claims ec
    WHERE ec.company_id = p_company_id
      AND (
        ec.journal_entry_id = p_entry_id
        OR (v_entry.source_type = 'expense_claim' AND ec.id = v_entry.source_id)
      )
    FOR UPDATE
  ) c;

  IF v_claim_ids IS NOT NULL THEN
    -- Money that has moved outranks the delete. Refuse here, while the
    -- verifikat still exists, instead of leaving a paid claim without one.
    IF EXISTS (
      SELECT 1 FROM expense_claims ec
      WHERE ec.id = ANY (v_claim_ids)
        AND (ec.status = 'paid' OR ec.payout_batch_id IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'Verifikatet kan inte raderas: utlägget är redan utbetalt eller ligger i en utbetalning. Ångra utbetalningen först.';
    END IF;

    -- Any payslip line, draft included: deleting a verifikat is not a request
    -- to change a salary run. The register's own delete handles a draft line.
    IF EXISTS (
      SELECT 1 FROM salary_line_items sli
      WHERE sli.source_expense_claim_id = ANY (v_claim_ids)
    ) THEN
      RAISE EXCEPTION 'Verifikatet kan inte raderas: utlägget ligger på ett lönebesked. Ta bort raden från lönebeskedet först.';
    END IF;
  END IF;

  -- Supplier payment rows on this entry, by FK. Removed by id and kept whole
  -- in the snapshot: the table has no audit trigger of its own.
  WITH removed AS (
    DELETE FROM supplier_invoice_payments sip
    WHERE sip.company_id = p_company_id
      AND sip.journal_entry_id = p_entry_id
    RETURNING sip.*
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_removed_payments
  FROM removed r;

  -- Revert each invoice by exactly its removed share. An invoice whose
  -- payment verifikat this is but that has no payment row (cash payment:
  -- always a full payment) is reverted in full, as the TS sync does.
  WITH share AS (
    SELECT (p ->> 'supplier_invoice_id')::uuid AS invoice_id,
           SUM((p ->> 'amount')::numeric)      AS amount
    FROM jsonb_array_elements(v_removed_payments) p
    GROUP BY 1
  ),
  target AS (
    SELECT si.id,
           GREATEST(ROUND(si.paid_amount - COALESCE(s.amount, si.paid_amount), 2), 0) AS new_paid
    FROM supplier_invoices si
    LEFT JOIN share s ON s.invoice_id = si.id
    WHERE si.company_id = p_company_id
      AND (s.invoice_id IS NOT NULL OR si.payment_journal_entry_id = p_entry_id)
    FOR UPDATE OF si
  ),
  reverted AS (
    UPDATE supplier_invoices si
    SET paid_amount      = t.new_paid,
        remaining_amount = ROUND(si.total - t.new_paid, 2),
        -- Back to what the row's own facts say. 'approved' only if someone
        -- attested it: a privately paid invoice is inserted as 'paid' and was
        -- never approved, so claiming 'approved' would invent an attest.
        status = CASE
          WHEN t.new_paid > 0 THEN 'partially_paid'
          WHEN si.due_date IS NOT NULL AND si.due_date < CURRENT_DATE THEN 'overdue'
          WHEN si.approved_at IS NOT NULL THEN 'approved'
          ELSE 'registered'
        END,
        paid_at = CASE WHEN t.new_paid > 0 THEN si.paid_at ELSE NULL END,
        payment_journal_entry_id = CASE
          WHEN si.payment_journal_entry_id = p_entry_id THEN NULL
          ELSE si.payment_journal_entry_id
        END,
        -- "Paid with private funds" describes a payment. With nothing paid
        -- it is no longer true, and the row is an ordinary unpaid invoice.
        paid_with_private_funds = CASE WHEN t.new_paid > 0 THEN si.paid_with_private_funds ELSE false END
    FROM target t
    WHERE si.id = t.id
    RETURNING si.id
  )
  SELECT array_agg(id) INTO v_touched_invoices FROM reverted;

  -- Release the bank lines: the pointer FK clears itself on delete, but
  -- supplier_invoice_id / category / is_business do not, and they keep the
  -- line out of the inbox. Only lines tied to this entry or its payment rows.
  UPDATE transactions t
  SET journal_entry_id    = NULL,
      supplier_invoice_id = NULL,
      is_business         = NULL,
      category            = NULL
  WHERE t.company_id = p_company_id
    AND v_touched_invoices IS NOT NULL
    AND t.supplier_invoice_id = ANY (v_touched_invoices)
    AND (
      t.journal_entry_id = p_entry_id
      OR t.id IN (
        SELECT (p ->> 'transaction_id')::uuid
        FROM jsonb_array_elements(v_removed_payments) p
        WHERE p ->> 'transaction_id' IS NOT NULL
      )
    );

  -- Eligibility was settled above, under lock. salary_line_items is
  -- ON DELETE RESTRICT, so a line that appeared anyway still refuses here.
  IF v_claim_ids IS NOT NULL THEN
    DELETE FROM expense_claims ec
    WHERE ec.company_id = p_company_id
      AND ec.id = ANY (v_claim_ids);
  END IF;

  v_register_effects := jsonb_build_object(
    'removed_expense_claim_ids',       COALESCE(to_jsonb(v_claim_ids), '[]'::jsonb),
    'removed_supplier_payments',       v_removed_payments,
    'reverted_supplier_invoice_ids',   COALESCE(to_jsonb(v_touched_invoices), '[]'::jsonb)
  );
  v_snapshot := v_snapshot || jsonb_build_object('register_effects', v_register_effects);

  IF v_entry.reverses_id IS NOT NULL THEN
    PERFORM set_config('gnubok.allow_delete', 'true', true);
    UPDATE journal_entries
    SET status = 'posted', reversed_by_id = NULL
    WHERE id = v_entry.reverses_id
      AND company_id = p_company_id;
  END IF;

  -- #2364: a correction carries the bank anchors correctEntry moved off the
  -- original. Return them before the FKs drop them with the row (pointer:
  -- ON DELETE SET NULL, junction: ON DELETE CASCADE), so the original, once
  -- its storno is deleted too, still explains its bank rows.
  IF v_entry.correction_of_id IS NOT NULL THEN
    UPDATE transactions
    SET journal_entry_id = v_entry.correction_of_id
    WHERE company_id = p_company_id
      AND journal_entry_id = p_entry_id;

    DELETE FROM transaction_voucher_links l
    WHERE l.company_id = p_company_id
      AND l.journal_entry_id = p_entry_id
      AND EXISTS (
        SELECT 1 FROM transaction_voucher_links x
        WHERE x.transaction_id = l.transaction_id
          AND x.journal_entry_id = v_entry.correction_of_id
      );

    UPDATE transaction_voucher_links
    SET journal_entry_id = v_entry.correction_of_id
    WHERE company_id = p_company_id
      AND journal_entry_id = p_entry_id;
  END IF;

  v_is_period_ib := (v_period.opening_balance_entry_id = p_entry_id);
  IF v_is_period_ib THEN
    UPDATE fiscal_periods
    SET opening_balances_set = false
    WHERE id = v_entry.fiscal_period_id;

    UPDATE fiscal_periods
    SET opening_balance_entry_id = NULL
    WHERE id = v_entry.fiscal_period_id;
  END IF;

  UPDATE sie_imports
  SET opening_balance_entry_id = NULL
  WHERE opening_balance_entry_id = p_entry_id;

  PERFORM set_config('gnubok.allow_delete', 'true', true);

  UPDATE document_attachments
  SET journal_entry_id = NULL
  WHERE journal_entry_id = p_entry_id;

  DELETE FROM journal_entries WHERE id = p_entry_id;

  UPDATE voucher_sequences
  SET last_number = GREATEST(last_number - 1, 0)
  WHERE company_id = p_company_id
    AND fiscal_period_id = v_entry.fiscal_period_id
    AND voucher_series = v_entry.voucher_series;

  INSERT INTO audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, description)
  VALUES (
    v_entry.user_id,
    p_company_id,
    'DELETE',
    'journal_entries',
    p_entry_id,
    auth.uid(),
    v_snapshot,
    'Deleted voucher ' || v_entry.voucher_series || v_entry.voucher_number ||
    CASE WHEN v_is_period_ib THEN ' (was period IB)' ELSE '' END ||
    ' (delete_last_voucher RPC, caller: ' || auth.uid() || ')'
  );

  RETURN jsonb_build_object(
    'deleted', true,
    'voucher_series', v_entry.voucher_series,
    'voucher_number', v_entry.voucher_number,
    'was_period_ib', v_is_period_ib
  );
END;
$function$;

NOTIFY pgrst, 'reload schema';
