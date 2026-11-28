-- What a customer invoice's own issue verifikat put on 151x.
-- pg-test: tests/pg/invoice-issue-receivable-sek.pg.test.ts
--
-- A SEK invoice with öresavrundning asks for its rounded "Att betala"
-- (999,75 kr is invoiced as 1 000 kr). From this change its issue verifikat
-- books that claim: 1510 at 1 000 and 3740 Öres- och kronutjämning at 0,25,
-- no moms on it (buildInvoiceRegistrationLines). Invoices issued before kept
-- the exact total on 1510 and book the öre when the payment arrives, and an
-- imported or hand-edited verifikat may book either way. So whether an
-- invoice's 151x carries its öre is a fact of its own issue verifikat, read
-- here:
--
--   the 151x balance (1513, Skatteverket's ROT/RUT share, excluded) of the
--   invoice's issue verifikat, followed through a storno to its correction
--   (live_journal_entry, 20261101120200), per invoice.
--
-- The settlement doors already clear what the ledger carries
-- (document_carried_sek, bookedOreRounding in lib/bookkeeping/ore-rounding.ts).
-- The kundreskontra reads this to count the öre the issue booked while the
-- customer's part is open, so it agrees with 1510; a kreditfaktura reads it
-- for its original to mirror the öre only when the original booked it. The
-- comparison with the customer's share (issueBookedOre in
-- lib/bookkeeping/ledger-carried-sek.ts) stays in TypeScript, so each row
-- carries the invoice's currency, total and deduction beside the figure.
-- Invoices without a live issue verifikat with 151x lines are not returned.
--
-- One json array, one object per invoice, as get_ar_ledger_invoices answers:
-- a scalar result, so PostgREST's max-rows cap does not apply.
--
-- SECURITY INVOKER: RLS scopes invoices and the ledger to the caller, and
-- every read also filters on p_company_id. Nothing is written.

CREATE OR REPLACE FUNCTION public.invoice_issue_receivable_sek(
  p_company_id uuid,
  p_invoice_ids uuid[]
)
RETURNS json
LANGUAGE sql
STABLE
SET search_path = public
AS $function$
  SELECT coalesce(
           json_agg(json_build_object(
             'invoice_id', r.id,
             'sek', r.sek,
             'currency', r.currency,
             'total', r.total,
             'deduction_total', r.deduction_total
           ) ORDER BY r.id),
           '[]'::json)
    FROM (
      SELECT i.id,
             ROUND(SUM(l.debit_amount - l.credit_amount), 2) AS sek,
             i.currency::text AS currency,
             i.total,
             i.deduction_total
        FROM public.invoices i
        CROSS JOIN LATERAL public.live_journal_entry(p_company_id, i.journal_entry_id) le
        JOIN public.journal_entry_lines l ON l.journal_entry_id = le.entry_id
       WHERE i.company_id = p_company_id
         AND i.id = ANY (p_invoice_ids)
         AND i.journal_entry_id IS NOT NULL
         AND le.entry_id IS NOT NULL
         AND l.account_number LIKE '151%'
         AND l.account_number <> '1513'
       GROUP BY i.id
    ) r
$function$;

REVOKE ALL ON FUNCTION public.invoice_issue_receivable_sek(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_issue_receivable_sek(uuid, uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.invoice_issue_receivable_sek(uuid, uuid[]) IS
  'What each invoice''s live issue verifikat put on 151x (1513 excluded), with its currency, total and deduction, for the öresavrundning its issue booked. Read by the kundreskontra and the kreditfaktura through fetchIssueBookedOre (lib/bookkeeping/ledger-carried-sek.ts). SECURITY INVOKER.';

-- The column's comment said display-only; it now decides the issue verifikat too.
COMMENT ON COLUMN public.invoices.ore_rounding IS
  'Per-invoice öresavrundning choice: the printed Att betala and the issue verifikat (1510 at the rounded amount, the öre on 3740). On a draft NULL inherits company_settings.ore_rounding; it freezes when the invoice is issued (invoices_freeze_ore_rounding).';

NOTIFY pgrst, 'reload schema';
