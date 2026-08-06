-- Direct inserts of posted journal entries previously bypassed
-- check_balance_on_post, which only covers draft-to-posted updates. Reuse the
-- same deferred balance function so an atomic transaction may insert the
-- header and lines together, while zero-line or unbalanced posted entries are
-- rejected when the transaction constraints are evaluated.
CREATE CONSTRAINT TRIGGER check_balance_on_posted_insert
  AFTER INSERT ON public.journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.status = 'posted')
  EXECUTE FUNCTION public.check_journal_entry_balance();
