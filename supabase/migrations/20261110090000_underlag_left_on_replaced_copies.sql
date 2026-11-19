-- How many verifikat lack the underlag an earlier "Hämta underlag" left on
-- the copy a re-run migration then reversed (#51).
--
-- Replacing a fiscal year by an SIE re-sync reverses every verifikat the
-- previous import brought in (undo_sie_import_chunk: Makulering, then the
-- original flipped to reversed) and imports the year again. Documents stay
-- where they are: a document linked to a posted verifikat is never moved or
-- deleted (BFL 7 kap 2 §). So when the underlag were fetched before the
-- re-run, they hang on the reversed first copy while the live copy of the
-- same source voucher has none. The provider underlag sweep links to the live
-- copy only (voucher-ref-resolver.ts isLiveCopy), so running "Hämta underlag"
-- again gives the live copy its own document. The migration workspace offers
-- that run when this count is above zero; the function only reads.
--
-- A live copy counts when it is posted, carries a source ref, has no current
-- document of its own, sits in an open year (a closed or locked year refuses
-- the link: enforce_period_lock_documents, the predicate isPeriodLocked
-- mirrors), and a reversed copy with a current document carries the same
-- source voucher in the same fiscal year. The identity is the one
-- commit_provider_migration_followup proves (20261009135352), with the series
-- compared as stored so the reversed side is found on
-- idx_journal_entries_source_voucher: two imports of one source write the
-- same series, and a case that differs only drops the prompt, never shows a
-- wrong one.
--
-- plpgsql with force_custom_plan: the plan must see the company. A generic
-- plan estimates a few rows for any one company and nests loops over a whole
-- year per verifikat: tens of seconds for a synthetic company with five
-- re-run years, against about 50 ms planned for that company.
--
-- SECURITY INVOKER: the caller's RLS decides what it can count, and the
-- company is filtered explicitly on every table as well.
--
-- pg-test: tests/pg/underlag-left-on-replaced-copies.pg.test.ts

CREATE FUNCTION public.underlag_left_on_replaced_copies(p_company_id uuid)
RETURNS integer
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public SET statement_timeout = '8s' SET plan_cache_mode = force_custom_plan
AS $$
BEGIN
  RETURN (
    SELECT count(*)::integer
    FROM journal_entries live
    JOIN fiscal_periods fp ON fp.id = live.fiscal_period_id AND fp.company_id = p_company_id
    WHERE live.company_id = p_company_id
      AND live.status = 'posted'
      AND live.source_voucher_series IS NOT NULL
      AND live.source_voucher_number IS NOT NULL
      AND NOT fp.is_closed
      AND fp.locked_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM document_attachments d
        WHERE d.journal_entry_id = live.id AND d.company_id = p_company_id AND d.is_current_version
      )
      AND EXISTS (
        SELECT 1
        FROM journal_entries rev
        JOIN document_attachments rd
          ON rd.journal_entry_id = rev.id AND rd.company_id = p_company_id AND rd.is_current_version
        WHERE rev.company_id = p_company_id
          AND rev.status = 'reversed'
          AND rev.fiscal_period_id = live.fiscal_period_id
          AND rev.source_voucher_series = live.source_voucher_series
          AND rev.source_voucher_number = live.source_voucher_number
      )
  );
END
$$;

REVOKE ALL ON FUNCTION public.underlag_left_on_replaced_copies(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.underlag_left_on_replaced_copies(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
