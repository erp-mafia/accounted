-- Hard blocks also hold for supplier invoices and Inkorg underlag
-- (accounted#145, follow-up to #130 step 2, 20261031150000_booking_review_rules).
--
-- booking_review_entry_matches judged only drafts that book a bank row
-- (source_type bank_transaction, or a manual samlingsverifikat with
-- bank_booking_context). A supplier invoice registered from the Inkorg, by a
-- rule for automatic booking, by an agent's approved operation or by a v1
-- key posts supplier_invoice_registered with no bank row behind it, so a
-- block on its accounts, its VAT, its supplier or its amount never reached
-- commit_journal_entry. The same held for the kontantmetoden payment that
-- books the purchase (supplier_invoice_cash_payment) and for an Inkorg
-- underlag booked directly without a bank row (inbox_item).
--
-- What a rule judges a draft by, per source type (mirrored by
-- BOOKING_REVIEW_SOURCES in src/lib/booking-review/match.ts, pinned by
-- tests/pg/booking-review-supplier-invoices.pg.test.ts):
--   bank_transaction, manual        the bank rows it books, as before; a
--                                   draft that books none is not matched;
--   supplier_invoice_registered,    the supplier invoice (source_id): the
--   supplier_invoice_cash_payment   supplier card's name is the
--                                   counterparty and the invoice total in
--                                   SEK the amount; a kontantmetoden payment
--                                   from the bank also has its bank rows;
--   inbox_item                      the Inkorg item (source_id): its matched
--                                   supplier's name and the seller the
--                                   reading names are the counterparty, the
--                                   verifikat's gross (the larger side of its
--                                   lines off 26xx) the amount.
-- Accounts and VAT are read off the lines, as before. Every other source
-- type is never matched. A payment of a registered invoice
-- (supplier_invoice_paid) settles a purchase already judged when it was
-- registered, moves only 2440 and the bank, and is also posted by
-- match_batch_allocate, which no person's review can stamp. A supplier
-- credit note books its invoice's own lines on the other side. A customer
-- invoice is the company's own issued document: refusing its booking leaves
-- an issued invoice outside the books instead of stopping anything. An
-- utlägg is the claim a person files, keyed to them and not to a seller.
-- Storno, rättelse, imports and closing entries stay exempt.
--
-- 1. booking_review_entry_parties: new. The counterparties a draft books,
--    each with the SEK amount it moves. Read only, no API role calls it.
-- 2. booking_review_entry_matches: restated from 20261031150000 with the
--    same signature, judging the parties above. commit_journal_entry calls
--    it by name, so commit_journal_entry is not restated.
-- 3. commit_reviewed_journal_entry: restated from 20261031150000 with the
--    same signature. The amount a booking_review limit is judged on, and the
--    stamp records, is the bank rows' sum when the draft books any, else the
--    document's amount; everything else is unchanged.
--
-- Nothing here touches the migration 017 triggers, posted entries or their
-- lines. Deploy window: the code that ships first needs nothing from this
-- migration; until it runs, the database judges bank rows only, as today.
--
-- pg-test: tests/pg/booking-review-supplier-invoices.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. booking_review_entry_parties
-- =============================================================================

-- kind: 'bank_row', 'supplier_invoice' or 'inbox_item'. An Inkorg item gives
-- one row per name it carries (the supplier card, the reading's seller),
-- each with the same amount; a name that identifies no one keys as ''.
CREATE FUNCTION public.booking_review_entry_parties(p_company_id uuid, p_entry_id uuid)
RETURNS TABLE(kind text, counterparty_key text, amount_sek numeric)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH entry AS (
    SELECT je.id, je.source_type, je.source_id, je.bank_booking_context
      FROM public.journal_entries je
     WHERE je.id = p_entry_id
       AND je.company_id = p_company_id
  )
  SELECT 'bank_row'::text,
         public.grant_counterparty_key(t.merchant_name, t.original_description, t.description),
         abs(coalesce(t.amount_sek, t.amount))
    FROM entry e
   CROSS JOIN LATERAL jsonb_array_elements(coalesce(e.bank_booking_context, '[]'::jsonb)) AS c(item)
    JOIN public.transactions t
      ON t.id = (c.item->>'transaction_id')::uuid
     AND t.company_id = p_company_id
  UNION ALL
  SELECT 'supplier_invoice'::text,
         public.grant_counterparty_key(s.name, NULL, NULL),
         abs(coalesce(si.total_sek, si.total * coalesce(si.exchange_rate, 1)))
    FROM entry e
    JOIN public.supplier_invoices si
      ON si.id = e.source_id
     AND si.company_id = p_company_id
    JOIN public.suppliers s
      ON s.id = si.supplier_id
     AND s.company_id = p_company_id
   WHERE e.source_type IN ('supplier_invoice_registered', 'supplier_invoice_cash_payment')
  UNION ALL
  SELECT 'inbox_item'::text,
         public.grant_counterparty_key(n.name, NULL, NULL),
         g.gross
    FROM entry e
    JOIN public.invoice_inbox_items i
      ON i.id = e.source_id
     AND i.company_id = p_company_id
    LEFT JOIN public.suppliers s
      ON s.id = i.matched_supplier_id
     AND s.company_id = p_company_id
   CROSS JOIN LATERAL (
     SELECT greatest(coalesce(sum(l.debit_amount), 0), coalesce(sum(l.credit_amount), 0)) AS gross
       FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = e.id
        AND l.account_number !~ '^26'
   ) g
   CROSS JOIN LATERAL (VALUES (s.name), (i.extracted_data->'supplier'->>'name')) AS n(name)
   WHERE e.source_type = 'inbox_item'
$$;

COMMENT ON FUNCTION public.booking_review_entry_parties(uuid, uuid) IS
  'The counterparties a draft books, as hard blocks (booking_review_rules) judge them: its bank rows, the supplier invoice a registration or kontantmetoden payment books, or the Inkorg item a direct booking books, each with its counterparty key (grant_counterparty_key) and SEK amount. accounted#145.';

REVOKE ALL ON FUNCTION public.booking_review_entry_parties(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_review_entry_parties(uuid, uuid) TO service_role;

-- =============================================================================
-- 2. booking_review_entry_matches: the parties, not only bank rows
-- =============================================================================

-- The company's active rules that match the draft, as [{id, rule_id,
-- version}], or [] (also for a source type no rule judges: a payment of a
-- registered invoice, a credit note, a customer invoice, an utlägg, a storno,
-- a rättelse, an import). Read only; no API role calls it directly.
CREATE OR REPLACE FUNCTION public.booking_review_entry_matches(p_company_id uuid, p_entry_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_source_type text;
  v_context jsonb;
  v_lines jsonb;
  v_accounts text[];
  v_vat text[];
  v_matches jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.booking_review_rules r WHERE r.company_id = p_company_id AND r.revoked_at IS NULL
  ) THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT je.source_type, je.bank_booking_context
    INTO v_source_type, v_context
    FROM public.journal_entries je
   WHERE je.id = p_entry_id
     AND je.company_id = p_company_id;
  IF NOT FOUND
     OR v_source_type IS NULL
     OR v_source_type NOT IN ('bank_transaction', 'manual', 'supplier_invoice_registered',
                              'supplier_invoice_cash_payment', 'inbox_item')
     -- A bank booking is judged only when it books a bank row.
     OR (v_source_type IN ('bank_transaction', 'manual')
         AND jsonb_array_length(coalesce(v_context, '[]'::jsonb)) = 0) THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'account_number', l.account_number,
           'debit_amount', l.debit_amount,
           'credit_amount', l.credit_amount)), '[]'::jsonb),
         coalesce(array_agg(DISTINCT l.account_number), '{}')
    INTO v_lines, v_accounts
    FROM public.journal_entry_lines l
   WHERE l.journal_entry_id = p_entry_id;
  v_vat := public.booking_review_vat_classes(v_lines);

  WITH parties AS (
    SELECT p.counterparty_key, p.amount_sek
      FROM public.booking_review_entry_parties(p_company_id, p_entry_id) AS p
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'rule_id', r.rule_id, 'version', r.version)
                            ORDER BY r.created_at, r.id), '[]'::jsonb)
    INTO v_matches
    FROM public.booking_review_rules r
   WHERE r.company_id = p_company_id
     AND r.revoked_at IS NULL
     AND r.valid_from <= now()
     AND (r.accounts IS NULL OR r.accounts && v_accounts)
     AND (r.vat_treatment IS NULL OR r.vat_treatment = ANY (v_vat))
     AND ((r.counterparty_key IS NULL AND r.amount_from_sek IS NULL)
          OR EXISTS (
            SELECT 1 FROM parties b
             WHERE (r.counterparty_key IS NULL OR b.counterparty_key = r.counterparty_key)
               AND (r.amount_from_sek IS NULL OR b.amount_sek >= r.amount_from_sek)));
  RETURN v_matches;
END;
$$;

REVOKE ALL ON FUNCTION public.booking_review_entry_matches(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_review_entry_matches(uuid, uuid) TO service_role;

-- =============================================================================
-- 3. commit_reviewed_journal_entry: the amount of a booking without a bank row
-- =============================================================================

-- Restated from 20261031150000; only the amount changes: the bank rows' sum
-- when the draft books any (as before), else the supplier invoice's or the
-- Inkorg underlag's amount (booking_review_entry_parties).
CREATE OR REPLACE FUNCTION public.commit_reviewed_journal_entry(
  p_company_id uuid,
  p_entry_id uuid,
  p_reviewer_id uuid DEFAULT NULL,
  p_rubric_version text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS TABLE(voucher_number integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_reviewer uuid;
  v_matches jsonb;
  v_amount numeric(14, 2);
  v_limits_set boolean;
  v_limit_found boolean;
  v_limit numeric(14, 2);
BEGIN
  IF public.jwt_caller_is_end_user()
     OR current_setting('role', true) IN ('authenticated', 'anon')
     OR auth.uid() IS NOT NULL THEN
    v_reviewer := auth.uid();
    IF v_reviewer IS NULL
       OR (p_reviewer_id IS NOT NULL AND p_reviewer_id <> v_reviewer)
       OR NOT public.caller_can_write_company(p_company_id) THEN
      RAISE EXCEPTION 'BOOKING_REVIEW_REVIEWER_DENIED' USING ERRCODE = '42501';
    END IF;
  ELSE
    v_reviewer := p_reviewer_id;
    IF v_reviewer IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.company_members cm
       WHERE cm.company_id = p_company_id
         AND cm.user_id = v_reviewer
         AND cm.role NOT IN ('viewer', 'invoicer')) THEN
      RAISE EXCEPTION 'BOOKING_REVIEW_REVIEWER_DENIED' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- The lock order of commit_journal_entry: the company, then the draft.
  PERFORM public.lock_cash_account_company(p_company_id);
  PERFORM 1 FROM public.journal_entries je
   WHERE je.id = p_entry_id AND je.company_id = p_company_id AND je.status = 'draft'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft journal entry not found: %', p_entry_id;
  END IF;

  v_matches := public.booking_review_entry_matches(p_company_id, p_entry_id);
  IF v_matches <> '[]'::jsonb THEN
    SELECT coalesce(
             CASE WHEN bool_or(p.kind = 'bank_row')
                  THEN sum(p.amount_sek) FILTER (WHERE p.kind = 'bank_row')
                  ELSE max(p.amount_sek)
             END, 0)
      INTO v_amount
      FROM public.booking_review_entry_parties(p_company_id, p_entry_id) AS p;

    v_limits_set := EXISTS (
      SELECT 1 FROM public.company_attest_limits l
       WHERE l.company_id = p_company_id AND l.scope = 'booking_review');
    IF v_limits_set THEN
      SELECT true, l.max_amount_sek INTO v_limit_found, v_limit
        FROM public.company_attest_limits l
       WHERE l.company_id = p_company_id AND l.scope = 'booking_review' AND l.user_id = v_reviewer;
      IF NOT coalesce(v_limit_found, false) OR (v_limit IS NOT NULL AND v_limit < v_amount) THEN
        RAISE EXCEPTION 'BOOKING_REVIEW_LIMIT: % SEK, limit %', v_amount, coalesce(v_limit::text, 'none')
          USING ERRCODE = '42501',
                DETAIL = jsonb_build_object('amount_sek', v_amount, 'limit_sek', v_limit, 'has_limit', coalesce(v_limit_found, false))::text;
      END IF;
    END IF;

    INSERT INTO public.booking_review_stamps AS s
      (journal_entry_id, company_id, reviewed_by, reviewed_at, amount_sek, limit_sek, rules)
    VALUES (p_entry_id, p_company_id, v_reviewer, now(), v_amount, v_limit, v_matches)
    ON CONFLICT (journal_entry_id) DO UPDATE
      SET reviewed_by = EXCLUDED.reviewed_by,
          reviewed_at = EXCLUDED.reviewed_at,
          amount_sek = EXCLUDED.amount_sek,
          limit_sek = EXCLUDED.limit_sek,
          rules = EXCLUDED.rules;
  END IF;

  RETURN QUERY
    SELECT c.voucher_number
      FROM public.commit_journal_entry(p_company_id, p_entry_id, 'user_accept', p_rubric_version, 'user', p_actor_label) AS c;
END;
$function$;

REVOKE ALL ON FUNCTION public.commit_reviewed_journal_entry(uuid, uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commit_reviewed_journal_entry(uuid, uuid, uuid, text, text) TO authenticated, service_role;

COMMENT ON TABLE public.booking_review_stamps IS
  'A person''s review of a booking a booking_review_rules row matched: who, when, the amount (the bank rows'' SEK sum, else the supplier invoice''s or Inkorg underlag''s) and the booking_review limit it was judged on, and the matching rules. Written only by commit_reviewed_journal_entry in the transaction that posts the verifikat; commit_journal_entry refuses a matched draft without it.';

NOTIFY pgrst, 'reload schema';
