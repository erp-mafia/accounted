SELECT set_config('lock_timeout', '5s', true);

-- Validate the match-on-arrival CHECKs added NOT VALID in 20261017010000.
-- pg-test: skip (validates CHECKs only)
--
-- Separate transaction: the preceding ALTER held its lock only for the
-- catalog change, and VALIDATE CONSTRAINT here takes SHARE UPDATE EXCLUSIVE,
-- which lets reads and writes continue while it scans. Every existing row has
-- NULL in the new columns, so every row passes; nothing is rewritten.

ALTER TABLE public.invoice_inbox_items
  VALIDATE CONSTRAINT invoice_inbox_items_bank_match_basis_check;
ALTER TABLE public.invoice_inbox_items
  VALIDATE CONSTRAINT invoice_inbox_items_bank_match_evidence_level_check;
ALTER TABLE public.invoice_inbox_items
  VALIDATE CONSTRAINT invoice_inbox_items_bank_match_source_key_check;
