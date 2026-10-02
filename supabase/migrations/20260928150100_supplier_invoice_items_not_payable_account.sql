-- A supplier invoice row is the invoice's own kontering, never the payable.
--
-- Every reader of supplier_invoice_items books each row as a line of the
-- verifikat and writes the payable leg itself: 2440 when the invoice is
-- registered, the bank when kontantmetoden books it at payment. A row on a
-- 244x account is that leg a second time. The provider migration stored the
-- source voucher's own 2440 row as a row of Visma and Fortnox invoices, so a
-- kontantmetod payment debited 2440 and credited the bank twice the invoice
-- (Visma rows), or credited 2440 instead of the bank (Fortnox rows). The
-- importer no longer writes that row; this makes it a rule of the table, for
-- every writer.
--
-- Only 244x. 26xx rows stay legal on purpose: a row on 2641 with no VAT of its
-- own is booked as it stands. That is how an agent-written invoice puts its
-- VAT on a line of its own, and how an imported row set keeps the source's
-- VAT when the provider states it nowhere else.
--
-- NOT VALID: rows stored before this migration stay until
-- repair_supplier_invoice_counter_items (next migration) has run for their
-- company, and a later migration validates the constraint. Every row inserted
-- or updated from now on is checked.
ALTER TABLE public.supplier_invoice_items
  ADD CONSTRAINT supplier_invoice_items_not_payable_account
  CHECK (account_number !~ '^244')
  NOT VALID;

COMMENT ON CONSTRAINT supplier_invoice_items_not_payable_account
  ON public.supplier_invoice_items
  IS 'A supplier invoice row is never on a 244x (leverantörsskulder) account: the booking engine writes the payable leg itself. NOT VALID until repair_supplier_invoice_counter_items has run for every company.';
