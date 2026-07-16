-- Validate the pending_operations operation_type CHECK constraint that
-- 20260713100000 and 20260713121000 added NOT VALID.
--
-- Deliberately a separate migration file: each migration runs in its own
-- transaction, and Postgres holds locks until commit. Putting VALIDATE in the
-- same transaction as ADD CONSTRAINT would keep the ACCESS EXCLUSIVE lock
-- through the validation scan and gain nothing. Here, VALIDATE only takes
-- SHARE UPDATE EXCLUSIVE, so staged-operation writes proceed during the scan.
--
-- The validation cannot fail: every previous operation_type list is a strict
-- subset of the list added by 20260713121000.

ALTER TABLE public.pending_operations
  VALIDATE CONSTRAINT pending_operations_operation_type_check;
