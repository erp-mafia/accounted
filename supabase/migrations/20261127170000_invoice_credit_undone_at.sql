-- "Ångra kreditering" of a customer invoice (lib/invoices/uncredit-invoice.ts).
-- pg-test: tests/pg/invoice-credit-undone.pg.test.ts
--
-- A credit whose kreditfaktura never reached the buyer can be undone: the
-- credit note's verifikat is cancelled with a storno and the original gets
-- its status back. The credit note itself is kept, with its number and its
-- archived PDF (BFL 7 kap; ML 17 kap 24 § p. 2, its löpnummer is never
-- used again), as 'cancelled'. That status already keeps it out of the
-- credit cap (enforce_credit_note_total_within_original), the kundreskontra
-- (get_ar_ledger_invoices) and the collection forwards
-- (collection_forward_credit_note skips one not yet forwarded).
--
-- credit_undone_at tells such a credit note from a cancelled draft: it was
-- issued and its credit undone at that time. The list and the invoice page
-- show it as Ångrad, and the credit flow never reopens it as a draft (a
-- draft that was never booked is reopened with its own KR number). Who
-- undid it and on what basis is in the event log (invoice.uncredited).
--
-- Only a cancelled credit note can carry it, and it cannot leave
-- 'cancelled' while it does. The CHECK is added NOT VALID and validated in
-- 20261127170100, the split 20261125180000 / 20261125180100 used, so this
-- DDL takes the lighter lock on a large table. The column is new and NULL
-- on every row, so every existing row passes.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS credit_undone_at timestamptz;

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_credit_undone_is_cancelled_credit_note;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_credit_undone_is_cancelled_credit_note
  CHECK (
    credit_undone_at IS NULL
    OR (status = 'cancelled' AND credited_invoice_id IS NOT NULL)
  )
  NOT VALID;

COMMENT ON COLUMN public.invoices.credit_undone_at IS
  'When the credit of this credit note was undone (Ångra kreditering, lib/invoices/uncredit-invoice.ts): its verifikat was cancelled with a storno and its original got its status back. Set only on a cancelled credit note, which keeps its number and is never reopened. Who undid it is in event_log (invoice.uncredited).';

NOTIFY pgrst, 'reload schema';
