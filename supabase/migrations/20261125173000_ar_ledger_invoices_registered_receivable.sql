-- The kundreskontra reads what each invoice's verifikat put on 1510.
-- pg-test: tests/pg/reskontra-population-rpc.pg.test.ts
--
-- A SEK invoice with öresavrundning is now booked at issue at the rounded
-- "Att betala" on 1510, the öre on 3740 (buildInvoiceRegistrationLines,
-- issueOreRounding): 999,75 kr issued as 1 000 kr debits 1510 1 000,00. The
-- invoice row still says total 999,75, so a reskontra of total less
-- paid_amount would sit 0,25 under 1510 for every open rounded invoice, and
-- the bokslut check "Kundreskontran stämmer inte mot konto 1510" would show it.
--
-- get_ar_ledger_invoices adds one fact per row, registered_receivable_sek:
-- what the row's posted verifikat (invoices.journal_entry_id) carries on 151x,
-- 1513 aside, for a SEK row; NULL for a foreign row, a row without a
-- verifikat, and a verifikat that is not posted. generateARLedger and the
-- customer drill-down add the in-band gap to the invoice's own receivable
-- while the customer's part is open (issue-rounding-carried.ts). Invoices
-- issued before this change carry the exact total and read a gap of 0, so
-- their reskontra rows do not move. Nothing else in the function changes; it
-- is copied from 20261023093950, the only earlier definition. CREATE OR
-- REPLACE keeps its grants.

CREATE OR REPLACE FUNCTION public.get_ar_ledger_invoices(
  p_company_id uuid,
  p_as_of_date date DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
STABLE
SET search_path TO ''
SET plan_cache_mode TO 'force_custom_plan'
AS $$
BEGIN
  RETURN (
    WITH population AS MATERIALIZED (
      SELECT i.id, i.customer_id, i.invoice_number, i.external_invoice_number, i.invoice_date,
             i.due_date, i.status, i.total, i.paid_amount, i.currency, i.exchange_rate,
             i.deduction_total, i.deduction_reclaimed_total, i.paid_at, i.journal_entry_id
      FROM public.invoices i
      WHERE i.company_id = p_company_id
        -- Proformas, delivery notes and quotes are never receivables.
        AND i.document_type = 'invoice'
        AND (p_customer_id IS NULL OR i.customer_id = p_customer_id)
        AND CASE
              WHEN p_as_of_date IS NULL THEN
                -- AR_LEDGER_STATUSES, plus paid invoices whose ROT/RUT
                -- deduction Skatteverket may still owe.
                i.status IN ('sent', 'overdue', 'partially_paid', 'credited')
                OR (i.status = 'paid' AND i.deduction_total > 0)
              ELSE
                -- COLLATE "C" (the same equality) keeps the planner from
                -- ANDing the company index with the status index, which
                -- matches nearly every row and only adds work.
                (i.status COLLATE "C") IN ('sent', 'overdue', 'partially_paid', 'credited', 'paid', 'written_off')
                AND i.invoice_date <= p_as_of_date
            END
        AND NOT (i.status = 'credited' AND i.total < 0)
        AND NOT (
          p_as_of_date IS NOT NULL
          AND i.status = 'written_off'
          AND EXISTS (
            SELECT 1
            FROM public.invoice_write_offs w
            WHERE w.company_id = p_company_id
              AND w.invoice_id = i.id
              AND w.kind = 'confirmed'
              AND w.entry_date <= p_as_of_date
              AND NOT EXISTS (
                SELECT 1
                FROM public.invoice_write_offs a
                WHERE a.company_id = p_company_id
                  AND a.kind = 'annulled'
                  AND a.reverses_id = w.id
                  AND a.entry_date <= p_as_of_date
              )
          )
        )
    ),
    payments AS (
      SELECT ip.invoice_id,
             coalesce(sum(ip.amount) FILTER (WHERE ip.payment_date <= p_as_of_date), 0) AS paid_through,
             coalesce(bool_and(ip.amount = round(ip.amount, 2)) FILTER (WHERE ip.payment_date <= p_as_of_date), true) AS in_ore
      FROM public.invoice_payments ip
      WHERE p_as_of_date IS NOT NULL
        AND ip.company_id = p_company_id
      GROUP BY ip.invoice_id
    ),
    survivors AS (
      SELECT p.*, pay.invoice_id IS NOT NULL AS has_payment_rows
      FROM population p
      LEFT JOIN payments pay ON pay.invoice_id = p.id
      WHERE NOT coalesce(
        CASE
          WHEN p_as_of_date IS NOT NULL THEN
            p.status = 'paid'
            AND p.deduction_total <= 0
            AND p.total >= 0
            AND CASE
                  WHEN pay.invoice_id IS NOT NULL THEN
                    p.total = round(p.total, 2) AND pay.in_ore AND pay.paid_through = p.total
                  ELSE
                    p.paid_amount = p.total
                    AND (p.paid_at IS NULL
                         -- The walk compares the date part of paid_at as
                         -- PostgREST prints it, in the session time zone.
                         OR left(to_json(p.paid_at) #>> '{}', 10) COLLATE "C" <= p_as_of_date::text COLLATE "C")
                END
          ELSE
            -- Live: a paid ROT/RUT invoice whose Skatteverket share is paid
            -- out. Its open share (skatteverket-share.ts) is zero exactly
            -- when its settled begäran items reach the claim, the deduction
            -- not reclaimed; every amount there is in whole öre.
            p.status = 'paid'
            AND p.deduction_total > 0
            AND p.total >= 0
            AND (
              SELECT coalesce(sum(
                       CASE
                         WHEN rq.status = 'paid' THEN greatest(0, p.deduction_total - p.deduction_reclaimed_total)
                         ELSE coalesce(it.decided_amount, 0)
                       END), 0)
              FROM public.rot_rut_payout_request_items it
              JOIN public.rot_rut_payout_requests rq ON rq.id = it.request_id
              WHERE it.invoice_id = p.id
                AND rq.company_id = p_company_id
                AND rq.settlement_journal_entry_id IS NOT NULL
            ) >= greatest(0, p.deduction_total - p.deduction_reclaimed_total)
        END,
        false
      )
    ),
    customer_order AS (
      -- uuid has no min(); its text form sorts the same under "C".
      SELECT coalesce(p.customer_id, '00000000-0000-0000-0000-000000000000'::uuid) AS customer_key,
             min(p.id::text COLLATE "C") AS first_id
      FROM population p
      GROUP BY 1
    )
    SELECT coalesce(json_agg(row_to_json(r) ORDER BY o.first_id, s.id), '[]'::json)
    FROM survivors s
    JOIN customer_order o
      ON o.customer_key = coalesce(s.customer_id, '00000000-0000-0000-0000-000000000000'::uuid)
    CROSS JOIN LATERAL (
      SELECT s.id, s.customer_id,
             (SELECT c.name FROM public.customers c WHERE c.id = s.customer_id) AS customer_name,
             s.invoice_number, s.external_invoice_number, s.invoice_date, s.due_date, s.status,
             s.total, s.paid_amount, s.currency, s.exchange_rate, s.deduction_total,
             s.deduction_reclaimed_total, s.paid_at, s.journal_entry_id, s.has_payment_rows,
             -- A SEK invoice or credit note: what its posted verifikat carries
             -- on 151x, 1513 aside. The öresavrundning its issue booked is
             -- read off it (registrationOreRounding), so the reskontra owes
             -- what 1510 carries while the customer's part is open.
             CASE WHEN coalesce(s.currency, 'SEK') = 'SEK' AND s.journal_entry_id IS NOT NULL THEN (
               SELECT round(sum(l.debit_amount - l.credit_amount), 2)
               FROM public.journal_entry_lines l
               JOIN public.journal_entries e ON e.id = l.journal_entry_id
               WHERE l.journal_entry_id = s.journal_entry_id
                 AND e.company_id = p_company_id
                 AND e.status = 'posted'
                 AND l.account_number LIKE '151%'
                 AND l.account_number <> '1513'
             ) END AS registered_receivable_sek,
             -- As of a date: the amounts of the payment rows dated on or
             -- before it, in id order (fetchPaymentsAsOf's walk).
             CASE WHEN s.has_payment_rows THEN (
               SELECT coalesce(array_agg(ip.amount ORDER BY ip.id), '{}')
               FROM public.invoice_payments ip
               WHERE ip.company_id = p_company_id
                 AND ip.invoice_id = s.id
                 AND ip.payment_date <= p_as_of_date
             ) END AS payment_amounts,
             -- A credit note's verifikat linked as payment of other
             -- invoices (credit-note-settlement.ts reads these).
             CASE WHEN s.total < 0 AND s.journal_entry_id IS NOT NULL THEN (
               SELECT coalesce(json_agg(row_to_json(lr) ORDER BY lr.id), '[]'::json)
               FROM (
                 SELECT l.id, l.invoice_id, l.journal_entry_id, l.amount, l.currency,
                        l.payment_exchange_rate, l.payment_date,
                        (SELECT json_build_object('invoice_date', li.invoice_date)
                         FROM public.invoices li
                         WHERE li.id = l.invoice_id) AS invoice
                 FROM public.invoice_payments l
                 WHERE l.company_id = p_company_id
                   AND l.journal_entry_id = s.journal_entry_id
               ) lr
             ) END AS credit_links,
             -- The begäran items of a ROT/RUT invoice whose begäran has a
             -- settlement verifikat (skatteverket-share.ts reads these).
             CASE WHEN s.deduction_total > 0 THEN (
               SELECT coalesce(json_agg(row_to_json(pr) ORDER BY pr.id), '[]'::json)
               FROM (
                 SELECT it.id, it.decided_amount, rq.status AS request_status,
                        (SELECT e.entry_date
                         FROM public.journal_entries e
                         WHERE e.id = rq.settlement_journal_entry_id) AS settlement_entry_date
                 FROM public.rot_rut_payout_request_items it
                 JOIN public.rot_rut_payout_requests rq ON rq.id = it.request_id
                 WHERE it.invoice_id = s.id
                   AND rq.company_id = p_company_id
                   AND rq.settlement_journal_entry_id IS NOT NULL
               ) pr
             ) END AS payout_items,
             -- One customer: the verifikat the invoice was booked by, the
             -- invoice engine's own (the latest when there are several) or
             -- else the one it is linked to (crm#1094).
             CASE WHEN p_customer_id IS NOT NULL THEN coalesce(
               (SELECT json_build_object('id', e.id, 'voucher_number', e.voucher_number,
                                         'voucher_series', e.voucher_series, 'description', e.description)
                FROM public.journal_entries e
                WHERE e.company_id = p_company_id
                  AND e.source_type = 'invoice_created'
                  AND e.source_id = s.id
                  AND e.status IN ('posted', 'reversed')
                ORDER BY e.created_at DESC, e.id DESC
                LIMIT 1),
               (SELECT json_build_object('id', e.id, 'voucher_number', e.voucher_number,
                                         'voucher_series', e.voucher_series, 'description', e.description)
                FROM public.journal_entries e
                WHERE e.company_id = p_company_id
                  AND e.id = s.journal_entry_id
                  AND e.status IN ('posted', 'reversed'))
             ) END AS voucher
    ) r
  );
END;
$$;

COMMENT ON FUNCTION public.get_ar_ledger_invoices(uuid, date, uuid) IS
  'The kundreskontra population (live, or as of a date) as one json array of the facts generateARLedger, generateARReconciliation and the customer drill-down read. SECURITY INVOKER.';
