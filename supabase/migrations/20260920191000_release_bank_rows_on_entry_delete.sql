-- A bank row whose verifikat is DELETED returns to Att bokfora (refs #2057).
--
-- "Att bokfora" is is_business IS NULL AND is_ignored = false
-- (lib/worklist/categories.ts). "Booked" is an anchor in one of three places
-- (public.is_transaction_booked): transactions.journal_entry_id, a row in
-- invoice_payments / supplier_invoice_payments, or a row in
-- transaction_voucher_links. Those are two definitions of "needs booking", and
-- they disagree the moment a verifikat is hard-deleted: the pointer FK is
-- ON DELETE SET NULL and the junction FK is ON DELETE CASCADE, so the anchor
-- goes, while is_business = true stays. The row is then unbooked AND out of
-- the worklist, the nav badge and the period-lock guard: silently missing
-- lopande bokforing (BFL 5 kap 2 §) with no surface showing it.
--
-- Every door that deletes a verifikat was written believing the opposite. The
-- junction table's own comment (20260529120000) says unlinked rows "re-surface
-- in the inbox"; reset_fiscal_year (20260825150000) says they "unlink and
-- return to unbooked". Four doors made the same assumption, so the rule is put
-- where none of them has to remember it: on the deletion itself.
--
-- WHY NOT a trigger keyed on "transactions.journal_entry_id went NULL".
-- linkTransactionToVouchers (lib/reconciliation/bank-reconciliation.ts, the 1:N
-- split) deliberately writes journal_entry_id = NULL together with
-- is_business = true and inserts the junction rows in a LATER request. For a
-- row that was 1:1 linked, that write differs from the FK's SET NULL in nothing
-- but intent: identical OLD and NEW. Such a trigger would reset the row mid
-- split and leave it booked AND in Att bokfora, one click from a double
-- booking. Being in separate transactions, a DEFERRABLE trigger does not help.
--
-- WHY NOT a BEFORE DELETE row trigger on journal_entries. FK actions are AFTER
-- triggers: they run once EVERY row trigger of the statement has fired. Delete
-- two verifikat that share a bank row in one statement (reset_fiscal_year
-- deletes a whole year at once; a main verifikat and its residual verifikat sit
-- in the same year) and each row trigger still sees the other's anchor, so
-- neither releases, and the row is stranded once both cascade away.
--
-- So the test is semantic and is made on the FINAL state: an anchor went away
-- AND the verifikat it named no longer exists. The FK's own writes queue these
-- AFTER triggers behind every referential action of the statement, so
-- is_transaction_booked() is read once all pointers are nulled and all links
-- cascaded. Storno, the correction relink, koppla-bort and the split's lock
-- write all leave their verifikat in place, so none of them is touched.
--
-- "Released" is the triple release_reversed_entry_transactions (20260906172540)
-- and repair_stranded_transactions (20260906170107) write: is_business,
-- category, reconciliation_method. is_ignored is never written. A row the user
-- marked private (is_business = false) is never touched: only is_business =
-- true with no anchor is a lie. A payment row that still names the bank row
-- keeps it booked, exactly as is_transaction_booked() says: its FK nulls the
-- payment's verifikat but keeps the payment, and releasing the bank row then
-- would recreate the half-anchored state of #2061. The payment register
-- decides that, not this trigger.
--
-- No behandlingshistorik row is written here, on purpose. The deletion that
-- causes the release is already logged per verifikat (write_audit_log, and
-- RESET_SNAPSHOT for a year reset); is_business and category are worklist
-- state, not a bokforingspost; and an INSERT from inside a teardown would
-- write rows for a company that is being removed.
--
-- The enforcement triggers of migration 017 are not touched. No table, column,
-- policy or grant changes. Existing stranded rows are NOT repaired by this
-- file: repair_stranded_transactions stays an operator decision.
--
-- pg-test: tests/pg/release-bank-rows-on-entry-delete.pg.test.ts

CREATE OR REPLACE FUNCTION public.release_bank_row_when_verifikat_deleted()
RETURNS trigger
LANGUAGE plpgsql
-- SECURITY DEFINER: the anchor check reads three tables, and a caller whose RLS
-- hid an anchor would release a row that is still booked. An integrity rule
-- must not depend on the policy shape of other tables. The scope comes only
-- from the row being written (OLD), never from caller input, and a function
-- returning trigger cannot be called through PostgREST.
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_transaction_id uuid;
  v_entry_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'transactions' THEN
    v_transaction_id := OLD.id;
    v_entry_id := OLD.journal_entry_id;
  ELSE
    v_transaction_id := OLD.transaction_id;
    v_entry_id := OLD.journal_entry_id;
  END IF;

  -- The anchor went away, but is the verifikat gone? If it still exists this
  -- is an application write (storno, koppla-bort, the split's lock write,
  -- a link rollback) that owns its own state. One primary-key probe.
  IF v_entry_id IS NULL
     OR EXISTS (SELECT 1 FROM public.journal_entries je WHERE je.id = v_entry_id) THEN
    RETURN NULL;
  END IF;

  -- Re-asserted inside the write, on the final state: a row that kept or
  -- regained any anchor stays as it is. No row is found when the transaction
  -- itself is being deleted (teardown), which is a no-op.
  UPDATE public.transactions t
     SET is_business = NULL,
         category = NULL,
         reconciliation_method = NULL
   WHERE t.id = v_transaction_id
     AND t.is_business = true
     AND t.journal_entry_id IS NULL
     AND NOT public.is_transaction_booked(t.id);

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.release_bank_row_when_verifikat_deleted() IS
  'Refs #2057. When a bank row loses an anchor because the verifikat it named was DELETED, and no anchor is left (is_transaction_booked), reset is_business/category/reconciliation_method to NULL so the row returns to Att bokfora. Judged on the final state, after every referential action of the statement. Never fires its write while the verifikat still exists, so storno, correction relink, koppla-bort and the 1:N split lock write are untouched. Never touches is_business = false or is_ignored.';

REVOKE ALL ON FUNCTION public.release_bank_row_when_verifikat_deleted() FROM PUBLIC, anon, authenticated;

-- Pointer anchor: fk_transactions_journal_entry is ON DELETE SET NULL, and a
-- referential action is an UPDATE that fires row triggers. The WHEN clause is
-- evaluated without calling the function, so bank sync, categorisation and
-- every other write to transactions pays nothing.
DROP TRIGGER IF EXISTS transactions_release_when_verifikat_deleted ON public.transactions;
CREATE TRIGGER transactions_release_when_verifikat_deleted
  AFTER UPDATE OF journal_entry_id ON public.transactions
  FOR EACH ROW
  WHEN (OLD.journal_entry_id IS NOT NULL
        AND NEW.journal_entry_id IS NULL
        AND NEW.is_business IS TRUE)
  EXECUTE FUNCTION public.release_bank_row_when_verifikat_deleted();

-- Junction anchor: transaction_voucher_links.journal_entry_id is
-- ON DELETE CASCADE. For a samlingsverifikat with N>1 rows and for a 1:N split
-- the junction is the ONLY anchor, so the pointer trigger above never fires.
DROP TRIGGER IF EXISTS transaction_voucher_links_release_when_verifikat_deleted
  ON public.transaction_voucher_links;
CREATE TRIGGER transaction_voucher_links_release_when_verifikat_deleted
  AFTER DELETE ON public.transaction_voucher_links
  FOR EACH ROW
  EXECUTE FUNCTION public.release_bank_row_when_verifikat_deleted();

NOTIFY pgrst, 'reload schema';
