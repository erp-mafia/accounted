SELECT set_config('lock_timeout', '5s', true);

-- Link basis: every new link records WHY two records are linked (building
-- blocks plan, Phase 2).
-- pg-test: tests/pg/link-basis.pg.test.ts
--
-- A link row said THAT two records belong together, never why: a person
-- picked the pair, a reference matched, an amount-and-date rule matched, an
-- agent proposed it and a person approved, another system carried it over.
-- Each link table gains two nullable columns:
--
--   link_basis     one value of the shared vocabulary (src/lib/links/
--                  link-basis.ts LINK_BASES; a unit test keeps the lists equal)
--   link_evidence  a small JSON object with what the writer saw (rule id,
--                  matched reference, score, decision receipt id, pending
--                  operation id, source system), at most 2000 bytes
--
-- Additive only. Existing rows keep NULL in both: unknown is never guessed,
-- so there is no backfill. The CHECKs are added NOT VALID here and validated
-- in 20261016160200, in a separate transaction, so this file never scans a
-- table under the ALTER's lock.
--
-- The tables, and the link each row's basis describes:
--   transactions                        the row's verifikat link
--                                       (journal_entry_id); 20261016160100
--                                       keeps the basis from outliving it
--   transaction_voucher_links           a bank line's share of a verifikat
--   invoice_payments                    a payment on a customer invoice
--   supplier_invoice_payments           a payment on a supplier invoice
--   document_attachments                the underlag's verifikat link
--                                       (journal_entry_id, set once, BFL 5
--                                       kap 6 §)
--   account_reconciliation_settlements  verifikat settled against each other
--                                       on a reconciliation account
--
-- document_links (Arkiv) keeps its own basis/method/evidence: it links a
-- document to a party, agreement or asset, not to the books, and its basis
-- (proven, guessed) answers a different question.

ALTER TABLE public.transactions
  ADD COLUMN link_basis text,
  ADD COLUMN link_evidence jsonb,
  ADD CONSTRAINT transactions_link_basis_check CHECK (link_basis IN (
    'user_confirmed', 'user_created', 'rule_ocr_reference', 'rule_amount_date',
    'rule_counterparty', 'agent_proposed_user_approved',
    'agent_autonomous_within_grant', 'client_asserted', 'import_carried_over',
    'system_derived'
  )) NOT VALID,
  ADD CONSTRAINT transactions_link_evidence_check CHECK (
    link_evidence IS NULL
    OR (jsonb_typeof(link_evidence) = 'object' AND octet_length(link_evidence::text) <= 2000)
  ) NOT VALID;

ALTER TABLE public.transaction_voucher_links
  ADD COLUMN link_basis text,
  ADD COLUMN link_evidence jsonb,
  ADD CONSTRAINT transaction_voucher_links_link_basis_check CHECK (link_basis IN (
    'user_confirmed', 'user_created', 'rule_ocr_reference', 'rule_amount_date',
    'rule_counterparty', 'agent_proposed_user_approved',
    'agent_autonomous_within_grant', 'client_asserted', 'import_carried_over',
    'system_derived'
  )) NOT VALID,
  ADD CONSTRAINT transaction_voucher_links_link_evidence_check CHECK (
    link_evidence IS NULL
    OR (jsonb_typeof(link_evidence) = 'object' AND octet_length(link_evidence::text) <= 2000)
  ) NOT VALID;

ALTER TABLE public.invoice_payments
  ADD COLUMN link_basis text,
  ADD COLUMN link_evidence jsonb,
  ADD CONSTRAINT invoice_payments_link_basis_check CHECK (link_basis IN (
    'user_confirmed', 'user_created', 'rule_ocr_reference', 'rule_amount_date',
    'rule_counterparty', 'agent_proposed_user_approved',
    'agent_autonomous_within_grant', 'client_asserted', 'import_carried_over',
    'system_derived'
  )) NOT VALID,
  ADD CONSTRAINT invoice_payments_link_evidence_check CHECK (
    link_evidence IS NULL
    OR (jsonb_typeof(link_evidence) = 'object' AND octet_length(link_evidence::text) <= 2000)
  ) NOT VALID;

ALTER TABLE public.supplier_invoice_payments
  ADD COLUMN link_basis text,
  ADD COLUMN link_evidence jsonb,
  ADD CONSTRAINT supplier_invoice_payments_link_basis_check CHECK (link_basis IN (
    'user_confirmed', 'user_created', 'rule_ocr_reference', 'rule_amount_date',
    'rule_counterparty', 'agent_proposed_user_approved',
    'agent_autonomous_within_grant', 'client_asserted', 'import_carried_over',
    'system_derived'
  )) NOT VALID,
  ADD CONSTRAINT supplier_invoice_payments_link_evidence_check CHECK (
    link_evidence IS NULL
    OR (jsonb_typeof(link_evidence) = 'object' AND octet_length(link_evidence::text) <= 2000)
  ) NOT VALID;

ALTER TABLE public.document_attachments
  ADD COLUMN link_basis text,
  ADD COLUMN link_evidence jsonb,
  ADD CONSTRAINT document_attachments_link_basis_check CHECK (link_basis IN (
    'user_confirmed', 'user_created', 'rule_ocr_reference', 'rule_amount_date',
    'rule_counterparty', 'agent_proposed_user_approved',
    'agent_autonomous_within_grant', 'client_asserted', 'import_carried_over',
    'system_derived'
  )) NOT VALID,
  ADD CONSTRAINT document_attachments_link_evidence_check CHECK (
    link_evidence IS NULL
    OR (jsonb_typeof(link_evidence) = 'object' AND octet_length(link_evidence::text) <= 2000)
  ) NOT VALID;

ALTER TABLE public.account_reconciliation_settlements
  ADD COLUMN link_basis text,
  ADD COLUMN link_evidence jsonb,
  ADD CONSTRAINT account_reconciliation_settlements_link_basis_check CHECK (link_basis IN (
    'user_confirmed', 'user_created', 'rule_ocr_reference', 'rule_amount_date',
    'rule_counterparty', 'agent_proposed_user_approved',
    'agent_autonomous_within_grant', 'client_asserted', 'import_carried_over',
    'system_derived'
  )) NOT VALID,
  ADD CONSTRAINT account_reconciliation_settlements_link_evidence_check CHECK (
    link_evidence IS NULL
    OR (jsonb_typeof(link_evidence) = 'object' AND octet_length(link_evidence::text) <= 2000)
  ) NOT VALID;

COMMENT ON COLUMN public.transactions.link_basis IS
  'Why the row is linked to its verifikat (journal_entry_id): src/lib/links/link-basis.ts. NULL when not recorded (rows linked before 2026-10-16, or by a writer that does not stamp yet). Cleared when the link changes without a new basis, kept when the link follows its verifikat to the correction (20261016160100).';
COMMENT ON COLUMN public.transactions.link_evidence IS
  'What the writer of the verifikat link saw: rule_id, reference, score, receipt_id, pending_operation_id, source_system. NULL when not recorded.';
COMMENT ON COLUMN public.transaction_voucher_links.link_basis IS
  'Why the bank line is linked to the verifikat: src/lib/links/link-basis.ts. NULL when not recorded.';
COMMENT ON COLUMN public.transaction_voucher_links.link_evidence IS
  'What the writer of the link saw: rule_id, reference, score, receipt_id, pending_operation_id, source_system. NULL when not recorded.';
COMMENT ON COLUMN public.invoice_payments.link_basis IS
  'Why the payment is linked to the invoice (and its transaction and verifikat): src/lib/links/link-basis.ts. NULL when not recorded. Orthogonal to source, which says where the payment came from.';
COMMENT ON COLUMN public.invoice_payments.link_evidence IS
  'What the writer of the payment link saw: rule_id, reference, score, receipt_id, pending_operation_id, source_system. NULL when not recorded.';
COMMENT ON COLUMN public.supplier_invoice_payments.link_basis IS
  'Why the payment is linked to the supplier invoice (and its transaction and verifikat): src/lib/links/link-basis.ts. NULL when not recorded.';
COMMENT ON COLUMN public.supplier_invoice_payments.link_evidence IS
  'What the writer of the payment link saw: rule_id, reference, score, receipt_id, pending_operation_id, source_system. NULL when not recorded.';
COMMENT ON COLUMN public.document_attachments.link_basis IS
  'Why the document is the underlag of its verifikat (journal_entry_id): src/lib/links/link-basis.ts. NULL when not recorded or not linked.';
COMMENT ON COLUMN public.document_attachments.link_evidence IS
  'What the writer of the underlag link saw: rule_id, reference, score, receipt_id, pending_operation_id, source_system. NULL when not recorded.';
COMMENT ON COLUMN public.account_reconciliation_settlements.link_basis IS
  'Why the verifikat were settled against each other: src/lib/links/link-basis.ts. NULL when not recorded.';
COMMENT ON COLUMN public.account_reconciliation_settlements.link_evidence IS
  'What the writer of the settlement saw: rule_id, reference, score, receipt_id, pending_operation_id, source_system. NULL when not recorded.';

NOTIFY pgrst, 'reload schema';
