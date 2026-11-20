SELECT set_config('lock_timeout', '5s', true);

-- Validate the CHECK replaced NOT VALID in 20261017123100.
--
-- Separate transaction: the preceding ALTER held its lock only for the
-- catalog change, and VALIDATE CONSTRAINT here takes SHARE UPDATE EXCLUSIVE,
-- which lets reads and writes continue while it scans. The column carries
-- no value in the old two-segment shape, so every row passes; nothing is
-- rewritten.

ALTER TABLE public.suppliers
  VALIDATE CONSTRAINT suppliers_default_purchase_category_check;
