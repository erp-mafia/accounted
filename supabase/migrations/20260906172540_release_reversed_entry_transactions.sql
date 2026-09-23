-- Release the bank transactions a reversed verifikat explained, atomically.
--
-- Issue #2061. reverseEntry (lib/bookkeeping/engine.ts) reset the pointer
-- column of every transaction pointing at the reversed entry and then, as a
-- second statement, dropped the supplementary transaction_voucher_links rows
-- of those transactions (a residual booking's role 'other' anchor to the small
-- residual verifikat, lib/reconciliation/residual.ts). Two statements leave a
-- window: a failed read before the reset, or a link created between the reset
-- and the delete, and the row is back in the half-anchored state the issue
-- describes (the worklist says att bokfora, the junction readers say booked).
--
-- One data-modifying CTE does both under the UPDATE's row locks and a single
-- snapshot: the DELETE sees only the links that existed when the statement
-- started, and only for the rows the UPDATE actually released. Links to the
-- reversed entry itself are left alone on purpose: the engine's junction
-- cleanup owns them (bulk-book N=1 writes a pointer AND a bank_line row to the
-- same entry, and that cleanup is what releases samlingsverifikat rows).
--
-- SECURITY INVOKER on purpose: RLS and the aa_enforce_company_writer_role
-- trigger apply exactly as they did to the two direct statements, for user
-- sessions and for the service role alike. No new privilege is minted.
--
-- pg-test: tests/pg/release-reversed-entry-transactions.pg.test.ts

CREATE OR REPLACE FUNCTION public.release_reversed_entry_transactions(
  p_company_id uuid,
  p_entry_id uuid
)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  WITH released AS (
    UPDATE public.transactions
       SET journal_entry_id = NULL,
           is_business = NULL,
           category = NULL,
           reconciliation_method = NULL
     WHERE company_id = p_company_id
       AND journal_entry_id = p_entry_id
     RETURNING id
  ),
  dropped AS (
    DELETE FROM public.transaction_voucher_links l
     WHERE l.company_id = p_company_id
       AND l.journal_entry_id <> p_entry_id
       AND l.transaction_id IN (SELECT id FROM released)
     RETURNING l.id
  )
  SELECT jsonb_build_object(
    'released', (SELECT count(*) FROM released),
    'dropped', (SELECT count(*) FROM dropped)
  );
$$;

REVOKE ALL ON FUNCTION public.release_reversed_entry_transactions(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_reversed_entry_transactions(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.release_reversed_entry_transactions(uuid, uuid) IS
  'Storno helper (#2061): in one statement, null the pointer column of every transaction that pointed at the reversed entry and drop those transactions'' transaction_voucher_links rows to OTHER entries (a residual booking''s supplementary anchor). Links to the reversed entry itself are left for the engine''s junction cleanup. Returns {released, dropped} counts.';
