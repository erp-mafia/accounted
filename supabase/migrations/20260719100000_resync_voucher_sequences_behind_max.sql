-- Data repair: resync voucher_sequences counters that lag behind the highest
-- committed voucher number in their (company, fiscal period, series).
--
-- The pre-RPC SIE import path (replaced by
-- 20260712150000_import_sie_journal_entries_rpc) inserted imported vouchers
-- with explicit numbers but left the series counter untouched. Affected
-- companies then fail year-end readiness ("Sequence counter integrity error")
-- and every new voucher in the series crashes on
-- uq_journal_entries_voucher_number, because next_voucher_number hands out
-- numbers that are already taken.
--
-- Idempotent, data-only: raises last_number to the observed max where it is
-- behind; never lowers a counter (counter-ahead is a legal state handled by
-- voucher_gap_explanations) and never touches journal entries. Drafts are
-- excluded; cancelled entries keep voucher_number 0 and are filtered out.
--
-- Change record (ISO 27001 A.8.32 / BFNAR 2013:2 behandlingshistorik): these
-- statements were executed manually against production (pwxtzglxptnnvjrpixpg)
-- and staging (metjnjrhvujscngnpzdv) on 2026-07-19 ~11:30-12:30 UTC to unblock
-- a customer's year-end (support case, DECISIONS.md 2026-07-19). This migration
-- is the reviewed change record for that repair; replay is a no-op.
UPDATE public.voucher_sequences vs
SET last_number = m.max_num,
    updated_at = now()
FROM (
  SELECT company_id, fiscal_period_id, voucher_series,
         max(voucher_number) AS max_num
  FROM public.journal_entries
  WHERE status <> 'draft'
    AND voucher_number IS NOT NULL
    AND voucher_number > 0
  GROUP BY company_id, fiscal_period_id, voucher_series
) m
WHERE vs.company_id = m.company_id
  AND vs.fiscal_period_id = m.fiscal_period_id
  AND vs.voucher_series = m.voucher_series
  AND vs.last_number < m.max_num;

-- Second failure shape of the same bug: committed vouchers whose (company,
-- period, series) has NO voucher_sequences row at all. next_voucher_number
-- would then INSERT a fresh row starting at 1 and the next voucher collides
-- with an existing number. Create the missing rows at the observed max,
-- attributed to the company owner (same fallback next_voucher_number uses;
-- companies without created_by are skipped rather than violating NOT NULL).
-- ON CONFLICT DO UPDATE with GREATEST keeps this idempotent AND closes the
-- race where next_voucher_number inserts the row (starting at 1) between the
-- max() snapshot and this INSERT: the conflict path raises such a row to the
-- observed max instead of silently leaving it at 1. The WHERE guard makes
-- healthy rows a no-op, so a counter is never lowered.
INSERT INTO public.voucher_sequences
  (company_id, user_id, fiscal_period_id, voucher_series, last_number)
SELECT m.company_id, c.created_by, m.fiscal_period_id, m.voucher_series, m.max_num
FROM (
  SELECT company_id, fiscal_period_id, voucher_series,
         max(voucher_number) AS max_num
  FROM public.journal_entries
  WHERE status <> 'draft'
    AND voucher_number IS NOT NULL
    AND voucher_number > 0
  GROUP BY company_id, fiscal_period_id, voucher_series
) m
JOIN public.companies c ON c.id = m.company_id
WHERE c.created_by IS NOT NULL
ON CONFLICT (company_id, fiscal_period_id, voucher_series) DO UPDATE
SET last_number = GREATEST(public.voucher_sequences.last_number, EXCLUDED.last_number),
    updated_at = now()
WHERE public.voucher_sequences.last_number < EXCLUDED.last_number;
