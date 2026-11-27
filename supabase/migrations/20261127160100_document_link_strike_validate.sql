SELECT set_config('lock_timeout', '5s', true);

-- Validate the CHECK added NOT VALID in 20261127160000.
-- pg-test: covered-by tests/pg/document-link-strike.pg.test.ts
--
-- Separate transaction: the ALTER there held its lock only for the catalog
-- change, and VALIDATE CONSTRAINT here takes SHARE UPDATE EXCLUSIVE, which
-- lets reads and writes continue while it scans. Every existing row has NULL
-- in all four columns, so every row passes and nothing is rewritten.

ALTER TABLE public.document_attachments
  VALIDATE CONSTRAINT document_attachments_link_strike_check;
