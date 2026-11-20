SELECT set_config('lock_timeout', '5s', true);

-- A bank row's link basis describes its CURRENT verifikat link, never an
-- earlier one.
-- pg-test: tests/pg/link-basis.pg.test.ts
--
-- transactions.link_basis (20261016160000) says why journal_entry_id points
-- where it points. That pointer changes after the link was made: the
-- uncategorize routes and a storno detach it, the SIE undo and the sandbox
-- teardown clear it, an FK action nulls it when its verifikat is deleted,
-- and SQL writers that do not stamp a basis yet (bulk_book_transactions and
-- the other RPCs listed in src/lib/links/__tests__/link-basis-coverage.test.ts)
-- set it. Each of those would otherwise leave the basis of the old link on
-- the row, which reads as a recorded reason for a link nobody recorded one for.
--
-- The rule, applied whenever journal_entry_id changes:
--   - the same UPDATE sets link_basis or link_evidence: what it set is kept,
--     even when it is the value the row already had (a bank row linked to a
--     verifikat by a person and then matched to an invoice by a person is
--     user_confirmed twice);
--   - the link moved between a verifikat and its correction (correctEntry
--     re-points the row to the entry whose correction_of_id is the old one;
--     delete_last_voucher points it back when it deletes that correction):
--     kept, the link follows the verifikat it was recorded for, as role and
--     allocated_amount do on the voucher links;
--   - anything else: link_basis and link_evidence are cleared, so the row
--     reads "not recorded" rather than a stale reason.
--
-- Whether an UPDATE sets a column is not visible in a row trigger, only
-- whether it changed it. A column-specific trigger fires exactly when the
-- column is in the UPDATE's SET list, so two triggers carry it: the first
-- (BEFORE UPDATE OF link_basis, link_evidence, named to fire first) notes the
-- row in a transaction-local setting when the same row's journal_entry_id
-- changes; the second (BEFORE UPDATE OF journal_entry_id) consumes the note.
-- Row-level BEFORE triggers run per row in name order, so a multi-row UPDATE
-- notes and consumes row by row, and a rolled-back statement or savepoint
-- takes its note with it.
--
-- BEFORE UPDATE OF only, so every other write to the hot transactions table
-- skips both. SECURITY INVOKER: they read the company's own verifikat, which
-- every role that may update the row may read.

CREATE OR REPLACE FUNCTION public.transactions_link_basis_note_stamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
    PERFORM pg_catalog.set_config('accounted.link_basis_stamped_row', NEW.id::text, true);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.transactions_link_basis_note_stamp() IS
  'Notes that an UPDATE which changes transactions.journal_entry_id also sets link_basis/link_evidence, for transactions_link_basis_follows_link (20261016160100).';

CREATE OR REPLACE FUNCTION public.transactions_link_basis_follows_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF NEW.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id THEN
    RETURN NEW;
  END IF;
  -- The same UPDATE stamped this row's basis: keep what it set.
  IF pg_catalog.current_setting('accounted.link_basis_stamped_row', true) = NEW.id::text THEN
    PERFORM pg_catalog.set_config('accounted.link_basis_stamped_row', '', true);
    RETURN NEW;
  END IF;
  IF OLD.link_basis IS NULL AND OLD.link_evidence IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.journal_entry_id IS NOT NULL
     AND OLD.journal_entry_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.journal_entries je
       WHERE (je.id = NEW.journal_entry_id AND je.correction_of_id = OLD.journal_entry_id)
          OR (je.id = OLD.journal_entry_id AND je.correction_of_id = NEW.journal_entry_id)
     ) THEN
    RETURN NEW;
  END IF;
  NEW.link_basis := NULL;
  NEW.link_evidence := NULL;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.transactions_link_basis_follows_link() IS
  'Clears transactions.link_basis/link_evidence when journal_entry_id changes without the same UPDATE setting a basis, except when the link moves between a verifikat and its correction (20261016160100).';

REVOKE ALL ON FUNCTION public.transactions_link_basis_note_stamp() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.transactions_link_basis_follows_link() FROM PUBLIC, anon;

-- Name order is fire order: the note must run before the rule reads it.
CREATE TRIGGER transactions_link_basis_1_note_stamp
  BEFORE UPDATE OF link_basis, link_evidence ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.transactions_link_basis_note_stamp();

CREATE TRIGGER transactions_link_basis_2_follows_link
  BEFORE UPDATE OF journal_entry_id ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.transactions_link_basis_follows_link();
