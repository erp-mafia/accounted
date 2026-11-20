-- Release a depreciation_schedules row from its voucher ONLY when that
-- voucher has been genuinely reversed by storno.
--
-- Background: a planenlig avskrivning posted from the asset register links
-- its depreciation_schedules row to the voucher (commit_asset_depreciation,
-- 20260920190200 / 20260923142743). The correction path for a posted
-- avskrivning is storno (BFL 5 kap. 5 §), but after reverseEntry() the row
-- kept pointing at the reversed voucher and enforce_depreciation_schedule_
-- immutability (20260516120000) refused any change to the link. So:
--   * commit_asset_depreciation refused the period ("already posted",
--     23505) and the register could never book the corrected amount;
--   * every reader that treats journal_entry_id IS NOT NULL as "posted"
--     (proposeAnnualPostings, the årsredovisning asset note, disposal's
--     accumulated depreciation) kept counting an avskrivning the ledger had
--     cancelled. The sidoordnad register drifted from the huvudbok (BFL
--     5 kap. 4 §, BFNAR 2013:2 kap. 4).
--
-- This is the same escape hatch enforce_opening_balance_immutability gives
-- closing_entry_id (20260720140000), with the same trust rule:
--   * the status='reversed' flag alone is not trusted (a writer-role member
--     can set it through PostgREST): the storno chain only the engine's
--     reverseEntry() produces must exist, i.e. a POSTED source_type='storno'
--     entry in the same company with reverses_id pointing at the voucher;
--   * the release is exactly "journal_entry_id -> NULL and posted_at -> NULL"
--     with asset_id, fiscal_period_id, company_id and planned_depreciation
--     unchanged. Anything else on a linked row is refused as before.
-- Re-posting needs no new rule: once the link is NULL the row is an unposted
-- proposal, which commit_asset_depreciation already adopts (UPDATE path).
--
-- Every other case stays exactly as immutable as 20260516120000 made it:
-- a live (posted) voucher cannot be unlinked, a link cannot be re-pointed to
-- another voucher, and planned_depreciation cannot change while linked. The
-- BEFORE DELETE guard (block_posted_depreciation_schedule_delete) and the
-- enforcement triggers of migration 017 are not touched.
--
-- Audit: depreciation_schedules has no audit trigger. The release is a
-- register change with legal weight (behandlingshistorik, BFNAR 2013:2
-- kap. 8), so it gets the same write_audit_log row the closing_entry_id
-- detach gets through audit_fiscal_periods (old and new state, including the
-- released journal_entry_id). Scoped to the release so ordinary proposal
-- churn does not flood audit_log.
--
-- pg-test: tests/pg/depreciation-schedule-storno-release.pg.test.ts

CREATE OR REPLACE FUNCTION public.enforce_depreciation_schedule_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF OLD.journal_entry_id IS NOT NULL THEN
    -- Storno release: the only change a linked row accepts.
    IF NEW.journal_entry_id IS NULL
       AND NEW.posted_at IS NULL
       AND NEW.planned_depreciation IS NOT DISTINCT FROM OLD.planned_depreciation
       AND NEW.asset_id IS NOT DISTINCT FROM OLD.asset_id
       AND NEW.fiscal_period_id IS NOT DISTINCT FROM OLD.fiscal_period_id
       AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id
       AND EXISTS (
         SELECT 1
         FROM public.journal_entries je
         JOIN public.journal_entries storno
           ON storno.reverses_id = je.id
          AND storno.source_type = 'storno'
          AND storno.status = 'posted'
          AND storno.company_id = OLD.company_id
         WHERE je.id = OLD.journal_entry_id
           AND je.company_id = OLD.company_id
           AND je.status = 'reversed'
       ) THEN
      RETURN NEW;
    END IF;

    IF NEW.planned_depreciation IS DISTINCT FROM OLD.planned_depreciation
       OR NEW.asset_id           IS DISTINCT FROM OLD.asset_id
       OR NEW.fiscal_period_id   IS DISTINCT FROM OLD.fiscal_period_id
       OR NEW.journal_entry_id   IS DISTINCT FROM OLD.journal_entry_id THEN
      RAISE EXCEPTION 'Cannot modify a posted depreciation schedule (id=%)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS audit_depreciation_schedule_release ON public.depreciation_schedules;
CREATE TRIGGER audit_depreciation_schedule_release
  AFTER UPDATE ON public.depreciation_schedules
  FOR EACH ROW
  WHEN (OLD.journal_entry_id IS NOT NULL AND NEW.journal_entry_id IS NULL)
  EXECUTE FUNCTION public.write_audit_log();
