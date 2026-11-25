-- What an invoice's own issue verifikat put on 151x (crm#2283).
-- pg-test: tests/pg/invoice-issue-receivable-sek.pg.test.ts
--
-- A customer invoice with öresavrundning asks for its rounded "Att betala"
-- (999,75 kr is invoiced as 1 000 kr). From this change the issue verifikat
-- books that claim: 1510 at 1 000 and 3740 Öres- och kronutjämning at 0,25,
-- the way Fortnox and Spiris book it. Invoices issued before kept the exact
-- total on 1510 and book the öre when the payment arrives, and an imported
-- verifikat may book either way. So whether an invoice's 151x carries its
-- öre is a fact of its own issue verifikat, read here:
--
--   the 151x balance (1513, Skatteverket's ROT/RUT share, excluded) of the
--   invoice's issue verifikat, followed through a storno to its correction
--   (live_journal_entry, 20261101120200), per invoice.
--
-- The settlement doors already clear what the ledger carries
-- (document_carried_sek, bookedOreRounding in lib/bookkeeping/ore-rounding.ts).
-- The kundreskontra and the kreditfaktura read this to count, and to mirror,
-- the öre the issue booked: compared with the invoice's customer share by
-- bookedOreRounding, a gap under one krona is that öre, anything else is no
-- öresavrundning. Invoices without a live issue verifikat are not returned.
--
-- SECURITY INVOKER: RLS scopes invoices and the ledger to the caller.

CREATE OR REPLACE FUNCTION public.invoice_issue_receivable_sek(
  p_company_id uuid,
  p_invoice_ids uuid[]
)
RETURNS TABLE (invoice_id uuid, sek numeric)
LANGUAGE sql
STABLE
SET search_path = public
AS $function$
  SELECT i.id, ROUND(COALESCE(SUM(l.debit_amount - l.credit_amount), 0), 2)
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
$function$;

REVOKE ALL ON FUNCTION public.invoice_issue_receivable_sek(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_issue_receivable_sek(uuid, uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.invoice_issue_receivable_sek(uuid, uuid[]) IS
  'What each invoice''s live issue verifikat put on 151x (1513 excluded), for the öresavrundning its issue booked (crm#2283). Read by the kundreskontra and the kreditfaktura through fetchIssueReceivableSek (lib/bookkeeping/ledger-carried-sek.ts). SECURITY INVOKER.';
