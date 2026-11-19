-- get_entries_with_account_lines: the verifikat of a period that have a line
-- on given accounts, with their lines, in one round trip.
--
-- Why: the periodisk sammanställning and the reverse-charge basis scan
-- (rc-basis-gaps) need the few verifikat behind a handful of accounts (the
-- EU sales on 3108/3308/3107, the fiktiv moms on 2614/2624/2634). The
-- sammanställning asked PostgREST for the period's journal_entries with an
-- inner embed of those lines, ordered by id and paged by 1 000: the planner
-- walked journal_entries_pkey through every tenant's entries (1.86M rows) to
-- fill a page that the rare accounts never filled, 1.0-1.6 s for one month.
-- The basis scan paged every posted entry of the period and then its lines in
-- chunks of 100 ids: 196 statements for one month.
--
-- Now one SQL call reads the period's verifikat on the days those accounts
-- moved (ledger_account_days, once the company is built; every day of the
-- period until then) and probes each for a line on them. SECURITY INVOKER:
-- RLS scopes the entries and the lines to the caller.
--
-- Rows: every verifikat of p_company_id dated in [p_start, p_end] whose
-- status is in p_statuses (posted and/or reversed) with at least one line on
-- p_accounts, ordered by id, each with its lines on p_accounts
-- (p_all_lines false) or all of its lines (true), ordered by account,
-- sort_order and id.
--
-- pg-test: tests/pg/entries-with-account-lines.pg.test.ts

CREATE OR REPLACE FUNCTION public.get_entries_with_account_lines(
  p_company_id uuid,
  p_start date,
  p_end date,
  p_accounts text[],
  p_statuses text[],
  p_all_lines boolean
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_days date[];
BEGIN
  IF public.ledger_account_days_ready(p_company_id) THEN
    v_days := ARRAY(
      SELECT DISTINCT d.entry_date
      FROM public.ledger_account_days d
      WHERE d.company_id = p_company_id
        AND d.entry_date >= p_start
        AND d.entry_date <= p_end
        AND d.account_number = ANY (p_accounts)
        AND d.line_count > 0
    );
  ELSE
    v_days := ARRAY(
      SELECT g::date
      FROM generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') g
    );
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', e.id,
      'voucher_series', e.voucher_series,
      'voucher_number', e.voucher_number,
      'entry_date', e.entry_date,
      'description', e.description,
      'status', e.status,
      'source_type', e.source_type,
      'source_id', e.source_id,
      'reverses_id', e.reverses_id,
      'correction_of_id', e.correction_of_id,
      'lines', x.lines
    ) ORDER BY e.id)
    FROM public.journal_entries e
    CROSS JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'id', l.id,
        'account_number', l.account_number,
        'debit_amount', l.debit_amount,
        'credit_amount', l.credit_amount
      ) ORDER BY l.account_number, l.sort_order, l.id) AS lines
      FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = e.id
        AND (p_all_lines OR l.account_number = ANY (p_accounts))
    ) x
    WHERE e.company_id = p_company_id
      -- The literal list lets the planner use the posted-entries index.
      AND e.status IN ('posted', 'reversed')
      AND e.status = ANY (p_statuses)
      AND e.entry_date = ANY (v_days)
      AND e.entry_date >= p_start
      AND e.entry_date <= p_end
      AND EXISTS (
        SELECT 1 FROM public.journal_entry_lines a
        WHERE a.journal_entry_id = e.id
          AND a.account_number = ANY (p_accounts)
      )
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.get_entries_with_account_lines(uuid, date, date, text[], text[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_entries_with_account_lines(uuid, date, date, text[], text[], boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
