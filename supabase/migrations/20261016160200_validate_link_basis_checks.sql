SELECT set_config('lock_timeout', '5s', true);

-- Validate the link-basis CHECKs added NOT VALID in 20261016160000.
-- pg-test: covered-by tests/pg/link-basis.pg.test.ts
--
-- Separate transaction: the preceding ALTERs held their lock only for the
-- catalog change, and VALIDATE CONSTRAINT here takes SHARE UPDATE EXCLUSIVE,
-- which lets reads and writes continue while it scans. Every existing row
-- has NULL in both columns, so every row passes; nothing is rewritten.

ALTER TABLE public.transactions
  VALIDATE CONSTRAINT transactions_link_basis_check;
ALTER TABLE public.transactions
  VALIDATE CONSTRAINT transactions_link_evidence_check;

ALTER TABLE public.transaction_voucher_links
  VALIDATE CONSTRAINT transaction_voucher_links_link_basis_check;
ALTER TABLE public.transaction_voucher_links
  VALIDATE CONSTRAINT transaction_voucher_links_link_evidence_check;

ALTER TABLE public.invoice_payments
  VALIDATE CONSTRAINT invoice_payments_link_basis_check;
ALTER TABLE public.invoice_payments
  VALIDATE CONSTRAINT invoice_payments_link_evidence_check;

ALTER TABLE public.supplier_invoice_payments
  VALIDATE CONSTRAINT supplier_invoice_payments_link_basis_check;
ALTER TABLE public.supplier_invoice_payments
  VALIDATE CONSTRAINT supplier_invoice_payments_link_evidence_check;

ALTER TABLE public.document_attachments
  VALIDATE CONSTRAINT document_attachments_link_basis_check;
ALTER TABLE public.document_attachments
  VALIDATE CONSTRAINT document_attachments_link_evidence_check;

ALTER TABLE public.account_reconciliation_settlements
  VALIDATE CONSTRAINT account_reconciliation_settlements_link_basis_check;
ALTER TABLE public.account_reconciliation_settlements
  VALIDATE CONSTRAINT account_reconciliation_settlements_link_evidence_check;
