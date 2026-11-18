-- Match on arrival: an inbox item's proposal that a bank row already paid it.
-- pg-test: skip (additive nullable columns, CHECKs and an index only: no trigger, function or policy)
--
-- Many supplier invoices are already paid when they are entered, and many
-- payments are marked paid by hand with no bank row, which is where double
-- bookings come from. The bank-row
-- matchers run only when a bank row arrives, and only against invoices
-- already registered; nothing looked in the bank when an invoice or a receipt
-- arrived. src/lib/documents/bank-match now does, with the bank feed's own
-- supplier-invoice passes and the receipt matcher, and records what it found
-- here.
--
-- A proposal, never a link and never a booking:
--   bank_match_transaction_id   the bank row that looks like the payment;
--                               SET NULL when the row is deleted
--   bank_match_basis            what paired them, in the link-basis vocabulary
--                               (src/lib/links/link-basis.ts RULE_LINK_BASES):
--                               rule_ocr_reference, rule_counterparty,
--                               rule_amount_date
--   bank_match_evidence_level   how far it can be trusted, never a score:
--                               exakt (OCR and amount), stark (amount and the
--                               payee's giro), trolig (amount, date and name)
--   bank_match_checked_at       when the matcher last wrote its answer; NULL
--                               means it never looked
--   bank_match_source_key       a fingerprint of the reading the answer came
--                               from: a reader shows the proposal only while
--                               the item still reads the same
--
-- Why not the columns that exist: matched_transaction_id is a person's (or an
-- agent's) pairing, which mirrors the document onto the bank row and which
-- bulk booking books as it stands, so a proposal written there would book
-- without anyone confirming it. suggestion_log is append-only and records a
-- decision after it was made (an outcome is required); a proposal that is
-- recomputed when a bank row arrives is neither.
--
-- Readers check the bank row again at read time (still unbooked, not linked
-- to anything else), so a row booked elsewhere after the proposal was written
-- is never shown. Additive only: existing rows keep NULL everywhere, nothing
-- is backfilled. The CHECKs are added NOT VALID and validated in
-- 20261017010100, in a separate transaction.

SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.invoice_inbox_items
  ADD COLUMN bank_match_transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  ADD COLUMN bank_match_basis text,
  ADD COLUMN bank_match_evidence_level text,
  ADD COLUMN bank_match_checked_at timestamptz,
  ADD COLUMN bank_match_source_key text,
  ADD CONSTRAINT invoice_inbox_items_bank_match_basis_check CHECK (
    bank_match_basis IN ('rule_ocr_reference', 'rule_counterparty', 'rule_amount_date')
  ) NOT VALID,
  ADD CONSTRAINT invoice_inbox_items_bank_match_evidence_level_check CHECK (
    bank_match_evidence_level IN ('exakt', 'stark', 'trolig')
  ) NOT VALID,
  ADD CONSTRAINT invoice_inbox_items_bank_match_source_key_check CHECK (
    bank_match_source_key IS NULL OR length(bank_match_source_key) <= 64
  ) NOT VALID;

COMMENT ON COLUMN public.invoice_inbox_items.bank_match_transaction_id IS
  'Match on arrival: the bank row that looks like this item''s payment. A proposal a person confirms, never a link (matched_transaction_id is the link) and never a booking.';
COMMENT ON COLUMN public.invoice_inbox_items.bank_match_basis IS
  'What paired the proposal: rule_ocr_reference, rule_counterparty or rule_amount_date (the link-basis vocabulary).';
COMMENT ON COLUMN public.invoice_inbox_items.bank_match_evidence_level IS
  'exakt (OCR and amount), stark (amount and payee giro), trolig (amount, date window and name). Never a score.';
COMMENT ON COLUMN public.invoice_inbox_items.bank_match_checked_at IS
  'When match on arrival last wrote its answer for this item; NULL when it never looked.';
COMMENT ON COLUMN public.invoice_inbox_items.bank_match_source_key IS
  'Fingerprint of the reading the proposal was computed from; readers drop a proposal whose item no longer reads the same.';

-- The foreign key's probe when a bank row is deleted (bank file undo, a
-- migration reset) looks rows up by this column.
CREATE INDEX idx_invoice_inbox_items_bank_match_transaction
  ON public.invoice_inbox_items (bank_match_transaction_id)
  WHERE bank_match_transaction_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
