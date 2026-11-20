SELECT set_config('lock_timeout', '5s', true);

-- Validate the CHECK added NOT VALID in 20261017000000.
--
-- Separate transaction: the preceding ALTER held its lock only for the
-- catalog change, and VALIDATE CONSTRAINT here takes SHARE UPDATE EXCLUSIVE,
-- which lets reads and writes continue while it scans. Every existing row
-- has NULL in the new column, so every row passes; nothing is rewritten.

ALTER TABLE public.suppliers
  VALIDATE CONSTRAINT suppliers_default_purchase_category_check;
