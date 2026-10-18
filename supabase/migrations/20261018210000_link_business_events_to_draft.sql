-- The SQL posting functions link the posting port's business events to the
-- drafts they write (posting port, the SQL step of Phase 2).
-- pg-test: tests/pg/sql-posting-business-events.pg.test.ts
--
-- WHY
-- ---
-- Six SQL functions draft AND commit their verifikat inside one transaction
-- (bulk_book_transactions, match_batch_allocate, link_invoice_to_voucher,
-- link_supplier_invoice_to_voucher, create_expense_payout_batch,
-- commit_opening_balance_replacement), so the TypeScript port cannot write
-- the business_event_entries link between the draft and the number: the
-- draft only exists inside the function. Their callers now record the
-- events through the port first and hand the ids to the function, which
-- links them to each draft it writes BEFORE commit_journal_entry draws the
-- voucher number, as the engine does for the drafts it writes
-- (src/lib/bookkeeping/business-event-link.ts).
--
-- WHAT
-- ----
-- public.link_business_events_to_draft(company, draft, event ids, role,
-- mode): the one place that writes those links, called by the six
-- functions (their own migrations follow this one). It mirrors
-- linkBusinessEventToDraft:
--   * no ids (NULL, empty, only NULLs): writes nothing, answers 0. That is
--     every call while POSTING_EVENTS is off, and every call from code that
--     predates the ids.
--   * mode 'strict': the insert runs as is, so a refused link (an event of
--     another company, an unknown event, a verifikat that is not a draft:
--     business_event_entries_guard and the foreign keys) raises, the calling
--     function's transaction rolls back and no voucher number is drawn.
--   * any other mode ('shadow', NULL): the insert runs in its own
--     subtransaction; a refusal is logged as a WARNING (server log) and the
--     posting goes ahead without the link.
-- The mode comes from the caller (the application's POSTING_EVENTS, passed
-- as p_event_mode); SQL reads no environment.
-- Duplicate ids are linked once (business_event_entries_event_entry).
--
-- Not callable by any API role: SECURITY INVOKER, executed by the posting
-- functions as their owner. The link's own checks (company, draft status)
-- are the trigger's, unchanged.
--
-- Nothing here touches journal_entries, journal_entry_lines, voucher
-- numbering (commit_journal_entry) or the migration 017 triggers.

CREATE OR REPLACE FUNCTION public.link_business_events_to_draft(
  p_company_id uuid,
  p_journal_entry_id uuid,
  p_event_ids uuid[],
  p_role text,
  p_event_mode text
)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_ids uuid[];
  v_linked integer := 0;
  v_message text;
  v_state text;
BEGIN
  SELECT COALESCE(array_agg(DISTINCT e), ARRAY[]::uuid[])
    INTO v_ids
  FROM unnest(COALESCE(p_event_ids, ARRAY[]::uuid[])) AS e
  WHERE e IS NOT NULL;

  IF cardinality(v_ids) = 0 THEN
    RETURN 0;
  END IF;

  IF p_event_mode = 'strict' THEN
    INSERT INTO public.business_event_entries (business_event_id, journal_entry_id, company_id, role)
    SELECT e, p_journal_entry_id, p_company_id, p_role
    FROM unnest(v_ids) AS e;
    GET DIAGNOSTICS v_linked = ROW_COUNT;
    RETURN v_linked;
  END IF;

  BEGIN
    INSERT INTO public.business_event_entries (business_event_id, journal_entry_id, company_id, role)
    SELECT e, p_journal_entry_id, p_company_id, p_role
    FROM unnest(v_ids) AS e;
    GET DIAGNOSTICS v_linked = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    RAISE WARNING 'business event link not written (shadow); the posting goes ahead without it: journal entry %, company %, % (%)',
      p_journal_entry_id, p_company_id, v_message, v_state;
    v_linked := 0;
  END;
  RETURN v_linked;
END;
$function$;

REVOKE ALL ON FUNCTION public.link_business_events_to_draft(uuid, uuid, uuid[], text, text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.link_business_events_to_draft(uuid, uuid, uuid[], text, text) IS
  'Links the posting port''s business events to a draft verifikat a SQL posting function wrote, before commit_journal_entry draws its number. No ids: nothing. strict: a refused link raises (no number drawn). shadow or NULL: a refused link is logged as a WARNING and the posting goes ahead. Called only by the posting functions.';
