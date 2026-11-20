-- A bank row's slices that go against its direction must add up to the row.
--
-- 20261006121001 checks each bank_line junction slice in its own direction,
-- so a 1:N split can net a credit note or a fee into one bank row. On its own
-- that also accepted a LONE opposite-sign slice: a -1000 outflow anchored by
-- one +1000 slice on a verifikat that only debits the bank account read as
-- booked (is_transaction_booked) although nothing explains the outflow. The
-- whole-row rule the guard used to apply is the special case of one slice,
-- so the row-level rule is restated here for the set of slices:
--
--   when any bank_line slice of a transaction has a sign other than the
--   transaction's, its bank_line slices must sum to the transaction amount
--   (half an öre).
--
-- That is what linkTransactionToVouchers already enforces before it writes
-- (slices sum to the row). Same-sign slices are untouched: bulk-book rows
-- (allocated_amount = the row amount), a samlingsverifikat still waiting for
-- its last bank line, and every existing same-sign split. Residual and
-- clearing rows (role <> 'bank_line') are not slices of the bank amount.
--
-- Checked at COMMIT (a deferred constraint trigger), on the final state of
-- every transaction a write touched: a split is inserted in one statement,
-- the koppla-bort path deletes all slices at once, and a moved slice
-- (UPDATE of transaction_id) is judged on both rows.
--
-- One exception, for the paths that unwind a split after its verifikat is
-- gone: deleting a slice whose verifikat is no longer posted (reversed by a
-- storno, deleted by delete_last_voucher or an SIE undo) is not judged.
-- reverseEntry (src/lib/bookkeeping/engine.ts) deletes the reversed
-- verifikat's slices first and drops the surviving slices of a broken split
-- in its next write; the SIE storno and undo functions do both inside one
-- transaction. Refusing the first step would leave the row anchored to a
-- reversed verifikat (#2364). Deleting a slice of a POSTED verifikat (a plain
-- unlink of one sibling) is judged like any other write.
--
-- Fires on new writes only: existing rows are not re-validated. The raise is
-- PT409 BANK_ANCHOR_SPLIT_UNBALANCED, in the BANK_ANCHOR_* family the link
-- paths already report as BANK_ANCHOR_REFUSED.

CREATE FUNCTION public.check_bank_split_balance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_transaction_id uuid;
  v_amount numeric;
  v_mixed boolean;
  v_sum numeric;
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.journal_entries j
     WHERE j.id = OLD.journal_entry_id AND j.status = 'posted'
  ) THEN
    RETURN NULL;
  END IF;

  FOR v_transaction_id IN
    SELECT DISTINCT x FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.transaction_id END,
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.transaction_id END
    ]) AS x
    WHERE x IS NOT NULL
  LOOP
    SELECT t.amount INTO v_amount FROM public.transactions t WHERE t.id = v_transaction_id;
    -- The transaction itself was deleted (its links cascade with it).
    CONTINUE WHEN NOT FOUND;
    SELECT bool_or(sign(l.allocated_amount) <> sign(v_amount)), sum(l.allocated_amount)
      INTO v_mixed, v_sum
      FROM public.transaction_voucher_links l
     WHERE l.transaction_id = v_transaction_id
       AND l.role = 'bank_line';
    IF v_mixed AND abs(v_sum - v_amount) >= 0.005 THEN
      RAISE EXCEPTION 'BANK_ANCHOR_SPLIT_UNBALANCED' USING ERRCODE = 'PT409';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.check_bank_split_balance() FROM PUBLIC, anon, authenticated;

CREATE CONSTRAINT TRIGGER bank_split_balance_guard
  AFTER INSERT OR UPDATE OF transaction_id, allocated_amount, role OR DELETE
  ON public.transaction_voucher_links
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.check_bank_split_balance();
