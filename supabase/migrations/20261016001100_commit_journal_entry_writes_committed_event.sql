-- Migration: commit_journal_entry_writes_committed_event
--
-- journal_entry.committed becomes a transactional outbox row. Until now the
-- event reached event_log only through the in-process event bus, after
-- commit_journal_entry had returned (src/lib/bookkeeping/engine.ts): a crash
-- or a function timeout between the commit and the emit lost it for good, and
-- GET /api/events, the feed an outside agent catches up from, never had it.
-- commit_journal_entry now writes the row itself, in the transaction that
-- posts the verifikat, so the event exists if and only if the voucher was
-- posted. Same idea as the collections outbox (collection_payment_forwards,
-- written in the business transaction and drained afterwards).
--
-- 1. event_log.dedupe_key: a natural key for an event more than one writer
--    produces. The RPC writes 'journal_entry.committed:<entry id>'. The bus
--    handler (src/lib/events/handlers/event-log-handler.ts) still persists the
--    event it receives, with the same key and ON CONFLICT DO NOTHING
--    (src/lib/events/dedupe-key.ts): a no-op for an entry this RPC posted,
--    and the only write for one posted another way (reverseEntry's storno
--    posts by UPDATE), so nothing leaves the feed. A plain unique index, not a
--    partial one, so PostgREST can infer it for on_conflict; NULLs never
--    conflict, so every existing row (all NULL) is unaffected.
--
-- 2. commit_journal_entry: restated from its newest full definition
--    (20261012100100_restate_patched_functions) byte for byte, plus one
--    INSERT after the status UPDATE. The payload is what the bus handler
--    stores for this event, {"entry": <the posted row with its lines>}, so a
--    poller sees one shape whichever writer won. The posted row carries the
--    actor this RPC was given: commit_method, committed_actor_type and
--    committed_actor_label are set by the UPDATE just above the INSERT.
--    user_id is the caller (auth.uid()), or the entry's creator on the
--    service role, as for voucher_sequences.
--
-- Every SQL caller of this RPC (bulk_book_transactions, match_batch_allocate,
-- create_expense_payout_batch, link_invoice_to_voucher,
-- link_supplier_invoice_to_voucher, commit_asset_disposal,
-- commit_asset_depreciation, commit_opening_balance_replacement) already
-- announces each verifikat it posts with journal_entry.committed from
-- TypeScript, so no new event appears: it only can no longer be lost. SIE
-- imports, their undo and provider migrations post without this RPC and stay
-- silent. The company row lock this RPC takes first serialises
-- commits per company, so these rows commit in sequence order
-- within a company.
--
-- Webhook deliveries for the event are still queued by the bus handler after
-- the commit (src/lib/webhooks/handler.ts): event_log is the record to
-- reconcile deliveries against.
--
-- The CREATE UNIQUE INDEX scans event_log once (all NULL in the new column)
-- and blocks writes to it for that scan, which grows with the table.
-- Plain, not CONCURRENTLY: migrations run inside a transaction (precedent
-- 20260901140000). lock_timeout keeps the ALTER and the build from queueing
-- behind a long transaction, where every later write to event_log would
-- queue behind them; on a timeout the migration fails and is re-run
-- (precedent 20261012100500).
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.event_log
  ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS event_log_dedupe_key_key
  ON public.event_log (dedupe_key);

CREATE OR REPLACE FUNCTION public.commit_journal_entry(p_company_id uuid, p_entry_id uuid, p_commit_method text DEFAULT NULL::text, p_rubric_version text DEFAULT NULL::text, p_actor_type text DEFAULT NULL::text, p_actor_label text DEFAULT NULL::text)
 RETURNS TABLE(voucher_number integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_next integer;
  v_fiscal_period_id uuid;
  v_series text;
  v_entry_user_id uuid;
BEGIN
  IF (public.jwt_caller_is_end_user()
      OR current_setting('role', true) IN ('authenticated', 'anon')
      OR auth.uid() IS NOT NULL)
     AND NOT public.caller_can_write_company(p_company_id) THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_WRITE_DENIED' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('gnubok.actor_type', coalesce(p_actor_type, ''), true);
  PERFORM set_config('gnubok.actor_label', coalesce(p_actor_label, ''), true);

  -- Use the same first lock as cash-account promotion, before the draft row.
  PERFORM public.lock_cash_account_company(p_company_id);

  SELECT je.fiscal_period_id, COALESCE(je.voucher_series, 'A'), je.user_id
  INTO v_fiscal_period_id, v_series, v_entry_user_id
  FROM public.journal_entries je
  WHERE je.id = p_entry_id
    AND je.company_id = p_company_id
    AND je.status = 'draft'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft journal entry not found: %', p_entry_id;
  END IF;

  INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_company_id, COALESCE(auth.uid(), v_entry_user_id), v_fiscal_period_id, v_series, 1)
  ON CONFLICT (company_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = public.voucher_sequences.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_next;

  UPDATE public.journal_entries
  SET voucher_number = v_next,
      status = 'posted',
      commit_method = p_commit_method,
      rubric_version = p_rubric_version,
      committed_actor_type = p_actor_type,
      committed_actor_label = p_actor_label
  WHERE id = p_entry_id
    AND company_id = p_company_id;

  -- journal_entry.committed, in the transaction that posts the verifikat
  -- (migration 20261016001100): the event exists exactly when the entry was
  -- posted. Same payload the event-bus handler stores, and the same
  -- dedupe_key, so its later write for this entry is a no-op.
  INSERT INTO public.event_log (user_id, company_id, event_type, entity_id, data, dedupe_key)
  SELECT COALESCE(auth.uid(), v_entry_user_id),
         p_company_id,
         'journal_entry.committed',
         je.id,
         jsonb_build_object(
           'entry',
           to_jsonb(je) || jsonb_build_object(
             'lines',
             COALESCE(
               (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.sort_order, l.created_at, l.id)
                  FROM public.journal_entry_lines l
                 WHERE l.journal_entry_id = je.id),
               '[]'::jsonb
             )
           )
         ),
         'journal_entry.committed:' || je.id::text
    FROM public.journal_entries je
   WHERE je.id = p_entry_id
     AND je.company_id = p_company_id
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN QUERY SELECT v_next;
END;
$function$
;

NOTIFY pgrst, 'reload schema';
