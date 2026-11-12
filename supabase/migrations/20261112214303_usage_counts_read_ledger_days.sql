-- get_account_usage_counts reads the ledger summaries instead of every
-- journal line (2026-11-12).
--
-- It counted journal_entry_lines for the whole company on every call: one
-- probe of the lines index per verifikat, and, because it runs as the caller,
-- the journal_entry_lines_select policy re-checking the parent verifikat once
-- per line. Cost follows the company's whole history with a large constant.
-- Production, read-only as a member of the largest company (154 336
-- verifikat, 464 132 lines): 5 190 ms and 2.49 M buffers warm (1.85 M of them
-- the per-line policy check); cold it did not finish in 15 s. The
-- authenticated limit is 8 s, so the call already fails for that company and
-- each new one of its size. Usage counts sit behind the chart of accounts,
-- the cash-account settings and the webshop country rules. 8 101 calls since
-- 2026-09-11, slowest calls cut off just under the limit (a cancelled call is
-- not counted).
--
-- ledger_account_days (20261023093900) already holds, per company, account
-- and day, the debit, credit and line count of every posted and reversed
-- verifikat, kept in step by triggers in the same transaction as the lines.
-- Every report reads it; this function was left on the line path. Now:
--
--   get_account_usage_counts = sum(line_count) per account from the
--   summaries, plus the lines of the verifikat the summaries leave out
--   (drafts and cancelled: 10 327 of 3.07 M entries on production), read
--   through idx_journal_entries_company_not_posted. An account whose count
--   nets to zero is absent, as before: absence is the "unused" signal.
--
-- A company whose summaries are not built (ledger_account_days_ready false)
-- keeps the line path, unchanged, as every other reader of the summaries
-- does. All 3 790 companies on production are built today.
--
-- Same statement on production, as a member, generic plan forced: 72 ms for
-- the largest company, the same 161 accounts and 464 132 lines in total.
-- Compared row by row with the old function on three companies that have
-- drafts or cancelled verifikat (7 450, 1 900 and 142 of them): no differing
-- row. Cost now follows the company's account-days (19 102 rows for the
-- largest company), not its lines: ten times the history is tens of
-- milliseconds.
--
-- get_onboarding_books_summary has the same line-bound read and is not
-- changed here: its balance rule is being changed separately (an account
-- counts from its ingående balans), and the move to the summaries follows
-- that change so the function has one definition at a time.
--
-- Signature, return type, security (invoker) and grants are unchanged.

CREATE OR REPLACE FUNCTION public.get_account_usage_counts(p_company_id uuid)
RETURNS TABLE (account_number text, usage_count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT u.account_number, sum(u.n)::bigint AS usage_count
  FROM (
    -- Posted and reversed verifikat: the ledger summaries.
    SELECT d.account_number, sum(d.line_count)::bigint AS n
    FROM public.ledger_account_days d
    WHERE d.company_id = p_company_id
      AND (SELECT public.ledger_account_days_ready(p_company_id))
    GROUP BY d.account_number

    UNION ALL

    -- The verifikat the summaries leave out (draft, cancelled, and a status
    -- of NULL, which the column allows): a draft line still names the
    -- account. The lateral keeps the lines a probe per entry.
    SELECT l.account_number, count(*)::bigint
    FROM public.journal_entries je
    CROSS JOIN LATERAL (
      SELECT jl.account_number
      FROM public.journal_entry_lines jl
      WHERE jl.journal_entry_id = je.id
      OFFSET 0
    ) l
    WHERE je.company_id = p_company_id
      AND (je.status IS NULL OR (je.status <> 'posted' AND je.status <> 'reversed'))
      AND (SELECT public.ledger_account_days_ready(p_company_id))
    GROUP BY l.account_number

    UNION ALL

    -- Summaries not built for this company: every line, as before.
    SELECT l.account_number, count(*)::bigint
    FROM public.journal_entry_lines l
    JOIN public.journal_entries je ON je.id = l.journal_entry_id
    WHERE je.company_id = p_company_id
      AND NOT (SELECT public.ledger_account_days_ready(p_company_id))
    GROUP BY l.account_number
  ) u
  GROUP BY u.account_number
  HAVING sum(u.n) > 0;
$$;

NOTIFY pgrst, 'reload schema';
