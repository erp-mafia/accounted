-- retain_sie_undo_reversal: an undone SIE import stays undone (PH 212).
--
-- Undoing an SIE import is a batch storno: undo_sie_import_chunk posts one
-- reversing verifikat per imported verifikat, flips each original to
-- 'reversed' and marks the job 'undone'. The import row then says the batch
-- is out of the ledger, and request_sie_import_undo answers an undone job
-- unchanged, so nothing can take the batch out a second time.
--
-- delete_last_voucher could still delete those stornos one by one from the
-- end of each series: each delete flips its original back from 'reversed'
-- to 'posted'. Done for the whole batch, every imported verifikat is active
-- again while the import says 'undone', and the user is stuck: the batch
-- entries can never be deleted (retain_sie_batch_entry) and the undo will
-- not run again. That is how one company ended up with an "undone" import
-- whose 99 verifikat were all posted.
--
-- This trigger guards the state itself rather than one caller: an entry of
-- an SIE import that is undoing or undone never goes back from 'reversed'
-- to 'posted'. delete_last_voucher is the only writer that makes that flip
-- (it does it before the DELETE), so its whole call is refused and nothing
-- is deleted. Stornos of a COMPLETED import's verifikat (a single
-- verifikat reversed by hand) stay deletable as before.
--
-- Default ERRCODE (P0001): reset_fiscal_year catches raise_exception and
-- answers with a typed refusal, and get-error-message.ts maps the text to a
-- Swedish sentence that says what to do instead.
--
-- pg-test: covered-by tests/pg/sie-undo-reversal-retained.pg.test.ts

CREATE OR REPLACE FUNCTION public.retain_sie_undo_reversal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.sie_imports si
     WHERE si.id = OLD.import_batch_id
       AND si.company_id = OLD.company_id
       AND (si.job_state IN ('undoing', 'undone') OR si.status IN ('undone', 'replaced'))
  ) THEN
    RAISE EXCEPTION 'Voucher of an undone SIE import cannot be restored; its storno must stay';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.retain_sie_undo_reversal() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER retain_sie_undo_reversal
  BEFORE UPDATE OF status ON public.journal_entries
  FOR EACH ROW
  WHEN (OLD.status = 'reversed' AND NEW.status = 'posted' AND OLD.import_batch_id IS NOT NULL)
  EXECUTE FUNCTION public.retain_sie_undo_reversal();
