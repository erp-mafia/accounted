-- Sender-declared document kind on inbox items (issue #2129).
--
-- The shared inbox address now accepts plus-addressing: a mail sent to
-- <local_part>+lev@<domain> is a leverantörsfaktura, +ver is bokföringsunderlag
-- (kvitto). The tag is the sender's statement, so it lives in its own column
-- rather than inside extracted_data: retry-extraction overwrites that JSONB
-- container wholesale, and the sender's choice must survive it. The inbox UI
-- lets kind_hint win over the AI's extracted_data.documentKind for the row
-- badge and the type filter.
--
-- Nullable on purpose: every existing row and every untagged mail stays
-- unhinted and keeps showing the AI classification.

ALTER TABLE public.invoice_inbox_items
  ADD COLUMN IF NOT EXISTS kind_hint text NULL
  CONSTRAINT invoice_inbox_items_kind_hint_check
  CHECK (kind_hint IN ('supplier_invoice', 'receipt'));

COMMENT ON COLUMN public.invoice_inbox_items.kind_hint IS
  'Sender-declared document kind from the +lev / +ver plus-address tag. Wins over extracted_data.documentKind in the inbox UI. NULL when the sender said nothing.';

NOTIFY pgrst, 'reload schema';
