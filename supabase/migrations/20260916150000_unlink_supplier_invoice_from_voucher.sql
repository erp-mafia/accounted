-- Undo a supplier-invoice payment that only LINKS an existing verifikat.
--
-- link_supplier_invoice_to_voucher (20260529130000, current shape in
-- 20260726140000) settles a payable against a voucher that already exists in
-- the ledger: it writes a supplier_invoice_payments row and advances the
-- invoice, and creates no journal entry. Nothing could undo it. A wrong link,
-- including one the migration reconcile pass made unattended, could only be
-- removed by someone with database access (issue #2673): the payment history
-- in the UI is read-only, the invoice cannot be deleted while a payment row
-- exists, and reverseEntry's cleanup (lib/bookkeeping/payment-sync.ts) skips
-- these rows because it only runs for entries whose source_type is a payment
-- type. Stornoing the linked voucher would also be wrong: it is a real
-- payment to someone, merely pointed at the wrong payable.
--
-- The complement is what makes this safe to expose. A payment row is this
-- function's to remove only when BOTH signals say the settlement was linked,
-- not booked:
--
--   * journal_entries.source_type is not one of PAYMENT_SOURCE_TYPES
--     (supplier_invoice_paid / supplier_invoice_cash_payment and the
--     customer-side pair). Those are the storno path's: reverseEntry reverses
--     the entry and clears the row together.
--   * supplier_invoices.payment_journal_entry_id does not name the same entry.
--     Every path that BOOKS a settlement stamps that pointer (mark-paid,
--     match_batch_allocate, and the utlägg/expense-claim mirror row written by
--     POST /api/supplier-invoices); the link RPC deliberately never does
--     (lib/invoices/bulk-reconcile-supplier-vouchers.ts). source_type alone is
--     not enough: an expense claim books Dr kostnad / Cr 2890 under
--     source_type 'expense_claim', which is outside PAYMENT_SOURCE_TYPES and
--     must stay outside it (payment-sync would read its source_id as an
--     invoice id), yet the payable it mirrors is genuinely settled. Removing
--     that row would resurrect a paid utlägg as an open payable with nothing
--     on 2440 behind it.
--
-- What is left after both guards is a pure subledger pointer: deleting it
-- changes no bookkeeping, because the link never wrote any. Every payment row
-- is therefore reversible by exactly one path, and the two cannot overlap. No
-- journal entry, line or document is touched here, so no enforcement trigger
-- is involved and no period lock applies: the ledger the locks protect is not
-- what changes.
--
-- Scoped to the supplier side on purpose. The customer twin
-- (link_invoice_to_voucher) has the same gap, but invoices.remaining_amount is
-- the ROT/RUT-NET customer share, whose single definition lives in
-- lib/invoices/customer-share.ts; re-deriving it in PL/pgSQL would duplicate a
-- definition rather than reuse one. See the PR body.

-- ── audit_log gains a SUBLEDGER_LINK_REMOVED action ─────────────────────────
--
-- Selected by ACTION rather than by table in behandlingshistorik, for the same
-- reason GUARD_BYPASSED is (20260914150102): supplier_invoice_payments is a
-- register and otherwise out of scope per BFN's commentary, but this one row
-- type in it is the sole surviving record of a change to the
-- leverantörsreskontra, because the payment row is hard-deleted.
--
-- NOT VALID skips the full-table validation scan: every existing row satisfies
-- the previous, strictly narrower constraint, and NOT VALID still enforces all
-- new rows. Same pattern as 20260914150102.

ALTER TABLE public.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action = ANY (ARRAY[
    'INSERT','UPDATE','DELETE','COMMIT','REVERSE','CORRECT',
    'LOCK_PERIOD','CLOSE_PERIOD','DOCUMENT_DELETE_BLOCKED',
    'RETENTION_BLOCK','SECURITY_EVENT','INTEGRITY_FAILURE',
    'COMMITTED_AT_OVERRIDE','RESET_SNAPSHOT','GUARD_BYPASSED',
    'SUBLEDGER_LINK_REMOVED'
  ])) NOT VALID;

CREATE OR REPLACE FUNCTION public.unlink_supplier_invoice_from_voucher(
  p_payment_id uuid,
  p_supplier_invoice_id uuid,
  p_company_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_payment RECORD;
  v_invoice RECORD;
  v_voucher RECORD;
  v_new_paid numeric;
  v_new_remaining numeric;
  v_new_status text;
  v_now timestamptz := now();
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_acting_user uuid;
  -- The four source types whose reversal reverseEntry / the DELETE voucher
  -- route already own (lib/bookkeeping/payment-sync.ts PAYMENT_SOURCE_TYPES).
  -- Both customer values are listed too: the set is the shared definition, and
  -- a supplier payment row pointing at one of them is corrupt either way.
  v_booked_payment_types text[] := ARRAY[
    'invoice_paid', 'invoice_cash_payment',
    'supplier_invoice_paid', 'supplier_invoice_cash_payment'
  ];
BEGIN
  -- Tenant guard, in shape from link_supplier_invoice_to_voucher
  -- (20260615120000): anon/authenticated may only act on their own companies;
  -- service_role and direct access bypass it.
  --
  -- Plus a role gate the link RPC does not need. EXECUTE is granted to
  -- `authenticated`, so any signed-in member can call this straight over
  -- PostgREST, bypassing the route's requireWrite. Linking is additive and
  -- re-doable; this one DELETES a payment row and rewrites the payable, so a
  -- viewer reaching it directly would be a destructive privilege escalation
  -- past a gate that only lives in the application. The rule is the
  -- application's own (lib/auth/require-write.ts: everyone but 'viewer'), not
  -- a stricter owner/admin one, so the RPC and the route agree on who may act.
  --
  -- Both halves go through the NULL-safe house helpers rather than an inline
  -- membership subquery. The raw NOT-IN-over-user_company_ids() shape skips its
  -- own deny branch on UNKNOWN, which is why 20260703180000 rewrote every
  -- function carrying it; tests/pg/null-safe-tenant-guards.pg.test.ts scans
  -- prosrc for that literal, so it must not appear here even in a comment.
  --
  -- Fails closed: a caller with no company_members row is refused by both. A
  -- non-member is told NOT_FOUND rather than FORBIDDEN, so the function never
  -- confirms that a payment id exists in a company the caller cannot see.
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF NOT public.caller_is_company_member(p_company_id) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_PAYMENT_NOT_FOUND');
    END IF;

    IF NOT public.caller_can_write_company(p_company_id) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_PAYMENT_FORBIDDEN');
    END IF;

    -- Attribution: the JWT sub is authoritative for user-session callers, in
    -- shape from link_supplier_invoice_to_voucher, so p_user_id cannot point
    -- the audit row at someone else.
    v_acting_user := coalesce(
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid,
      p_user_id
    );
  ELSE
    v_acting_user := p_user_id;
  END IF;

  -- Scoped by the invoice as well as the payment: the caller addresses this
  -- through /supplier-invoices/[id]/payments/[paymentId], and a payment id that
  -- belongs to a different payable in the same company must miss, not succeed
  -- against the wrong parent.
  SELECT * INTO v_payment
  FROM public.supplier_invoice_payments
  WHERE id = p_payment_id
    AND supplier_invoice_id = p_supplier_invoice_id
    AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_PAYMENT_NOT_FOUND');
  END IF;

  -- A row with no verifikat was not written by the link path, which always
  -- names one. Refusing keeps this function to the one shape it can reason
  -- about instead of becoming a general payment-row eraser.
  IF v_payment.journal_entry_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_PAYMENT_NOT_A_LINK');
  END IF;

  SELECT * INTO v_voucher
  FROM public.journal_entries
  WHERE id = v_payment.journal_entry_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_PAYMENT_NOT_A_LINK');
  END IF;

  SELECT * INTO v_invoice
  FROM public.supplier_invoices
  WHERE id = v_payment.supplier_invoice_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_PAYMENT_NOT_FOUND');
  END IF;

  -- Storno's, not ours. Two signals, because neither is sufficient alone: see
  -- the header. The pointer half is what keeps an utlägg (source_type
  -- 'expense_claim', liability booked on 2890, payable created already 'paid')
  -- out of this path.
  IF v_voucher.source_type = ANY (v_booked_payment_types)
     OR v_invoice.payment_journal_entry_id = v_payment.journal_entry_id THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'UNLINK_SI_PAYMENT_BOOKED_PAYMENT',
      'details', jsonb_build_object(
        'source_type', v_voucher.source_type,
        'journal_entry_id', v_voucher.id,
        'reason', CASE
          WHEN v_voucher.source_type = ANY (v_booked_payment_types) THEN 'booked_payment_source_type'
          ELSE 'invoice_payment_entry_pointer'
        END
      )
    );
  END IF;

  -- The one case where linking DID write bookkeeping. 20260830140000 taught
  -- link_supplier_invoice_to_voucher to settle a SEK payment voucher against a
  -- foreign-currency invoice by committing its OWN two-line residual verifikat
  -- (Dr 7960 / Cr 3960 plus the AP counter-leg). Deleting the payment row would
  -- leave that verifikat posted with nothing to explain it, and the payable
  -- restored to full: the ledger and the subledger would then disagree by the
  -- residual. The row does not record the residual's id (only the effective
  -- rate), so it cannot be found and reversed from here, and reversing a posted
  -- verifikat is storno's job in any case. Refuse instead of half-undoing.
  --
  -- payment_exchange_rate is the signal, and the only one: the fallback stamps
  -- it on exactly the rows whose link committed a residual. Refusing every
  -- non-SEK invoice instead (an earlier revision did) would refuse the ordinary
  -- foreign case too, where the voucher's matched lines carry
  -- amount_in_currency, no residual is booked and the row is as undoable as any
  -- SEK one. That refusal told the user a difference had been booked when none
  -- had, and sent them to storno a real payment to another supplier: the exact
  -- move this function's header calls wrong. The column predates the fallback
  -- (20260601122000 vs 20260830140000), so no residual-bearing row can be
  -- missing it.
  IF v_payment.payment_exchange_rate IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'UNLINK_SI_PAYMENT_FX_SETTLED',
      'details', jsonb_build_object(
        'invoice_currency', v_invoice.currency,
        'payment_exchange_rate', v_payment.payment_exchange_rate
      )
    );
  END IF;

  -- 'credited' and 'reversed' mean another lifecycle step has already decided
  -- this invoice's fate; restoring a payable status would contradict it.
  IF v_invoice.status NOT IN ('paid', 'partially_paid') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'UNLINK_SI_PAYMENT_INVOICE_NOT_SETTLED',
      'details', jsonb_build_object('status', v_invoice.status)
    );
  END IF;

  v_new_paid := GREATEST(0, ROUND((COALESCE(v_invoice.paid_amount, 0) - v_payment.amount) * 100) / 100);

  -- Give the payment back to the REMAINDER rather than deriving the remainder
  -- from the total. remaining_amount is not always total - paid_amount: a
  -- settlement may absorb öre (lib/invoices/apply-supplier-payment.ts,
  -- ORE_ROUNDING_SETTLEMENT_MAX) and a credit reduces the remainder while total
  -- and paid_amount stay put. Re-deriving from total resurrects both, leaving
  -- an outstanding balance nobody owes and an invoice that can never reach
  -- 'paid' again. The link RPC reads the same stored column
  -- (COALESCE(remaining_amount, total - paid_amount)), so the two now agree on
  -- what the column means.
  v_new_remaining := GREATEST(0, ROUND((
    COALESCE(v_invoice.remaining_amount, v_invoice.total - COALESCE(v_invoice.paid_amount, 0))
    + v_payment.amount
  ) * 100) / 100);

  -- Restore the payable status the invoice would have had. payment-sync falls
  -- back to 'approved' unconditionally; reading approved_at instead keeps an
  -- invoice that was never approved from being silently approved by an undo.
  v_new_status := CASE
    WHEN v_new_paid > 0.005 THEN 'partially_paid'
    WHEN v_invoice.due_date IS NOT NULL AND v_invoice.due_date < current_date THEN 'overdue'
    WHEN v_invoice.approved_at IS NOT NULL THEN 'approved'
    ELSE 'registered'
  END;

  UPDATE public.supplier_invoices
  SET status = v_new_status,
      paid_amount = v_new_paid,
      remaining_amount = v_new_remaining,
      -- paid_at means "fully settled" everywhere else (the link RPC sets it
      -- only when v_is_fully_paid; payment-sync clears it on every revert), so
      -- it follows the REMAINDER, not the paid amount. Keyed on v_new_paid it
      -- survived on an invoice that had just fallen back to partially_paid:
      -- remove one of two links from a fully paid invoice and it kept a
      -- settlement date it had not reached.
      paid_at = CASE WHEN v_new_remaining <= 0.005 THEN paid_at ELSE NULL END,
      -- payment_journal_entry_id is deliberately NOT cleared: the guard above
      -- refuses any row the invoice names there, so it can only point at some
      -- other settlement, which this undo has no business erasing.
      updated_at = v_now
  WHERE id = v_invoice.id;

  -- Hard delete, as the storno path does: a soft-deleted row would still trip
  -- the uniqueness the link checks (invoice + entry) and double-count a
  -- re-match. The audit row below is what carries the history instead.
  DELETE FROM public.supplier_invoice_payments WHERE id = v_payment.id;

  -- The audit row is written HERE, not by the caller. audit_log has RLS with
  -- no INSERT policy (20240101000014, and see 20260810121000's header for the
  -- same conclusion), so the route's user-scoped client cannot write it: an
  -- insert from there is refused with 42501 every time. A SECURITY DEFINER
  -- function can, and this one already is.
  --
  -- It has to exist: the payment row is hard-deleted, and the write_audit_log
  -- trigger on supplier_invoices attributes its own row to the invoice's
  -- user_id, not to whoever acted. Without this insert nothing anywhere records
  -- who removed the link (BFNAR 2013:2 p. 9.16, behandlingshistorik).
  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    old_state, new_state, description, actor_type, actor_label
  )
  VALUES (
    COALESCE(v_acting_user, v_invoice.user_id),
    p_company_id,
    'SUBLEDGER_LINK_REMOVED',
    'supplier_invoice_payments',
    v_payment.id,
    v_acting_user,
    jsonb_build_object(
      'supplier_invoice_id', v_invoice.id,
      'journal_entry_id', v_payment.journal_entry_id,
      'transaction_id', v_payment.transaction_id,
      'payment_date', v_payment.payment_date,
      'amount', v_payment.amount,
      'currency', v_payment.currency,
      'status', v_invoice.status,
      'paid_amount', v_invoice.paid_amount,
      'remaining_amount', v_invoice.remaining_amount
    ),
    jsonb_build_object(
      'invoice_status', v_new_status,
      'paid_amount', v_new_paid,
      'remaining_amount', v_new_remaining
    ),
    format(
      'Kopplingen mellan leverantörsfakturan %s och verifikatet togs bort (%s %s). Ingen bokföring ändrades.',
      COALESCE(v_invoice.supplier_invoice_number, v_invoice.arrival_number::text),
      v_payment.amount,
      COALESCE(v_payment.currency, 'SEK')
    ),
    COALESCE(NULLIF(current_setting('gnubok.actor_type', true), ''), 'user'),
    NULLIF(current_setting('gnubok.actor_label', true), '')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'supplier_invoice_id', v_invoice.id,
    'journal_entry_id', v_payment.journal_entry_id,
    'transaction_id', v_payment.transaction_id,
    'payment_amount', v_payment.amount,
    'invoice_status', v_new_status,
    'paid_amount', v_new_paid,
    'remaining_amount', v_new_remaining
  );
END;
$$;

COMMENT ON FUNCTION public.unlink_supplier_invoice_from_voucher(uuid, uuid, uuid, uuid) IS
  'Removes a supplier_invoice_payments row that only links an existing verifikat, and restores the invoice status/paid/remaining. Refuses rows whose settlement was booked rather than linked (a PAYMENT_SOURCE_TYPES entry, or one the invoice names as its payment_journal_entry_id: storno owns those), rows with no entry, and rows whose link committed an FX residual. Touches no journal entry; writes its own audit_log row.';

REVOKE ALL ON FUNCTION public.unlink_supplier_invoice_from_voucher(uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unlink_supplier_invoice_from_voucher(uuid, uuid, uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
