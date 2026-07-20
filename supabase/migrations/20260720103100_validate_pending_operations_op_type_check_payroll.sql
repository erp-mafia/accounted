-- Validate the operation_type CHECK re-added NOT VALID in 20260720103000.
-- Runs in its own transaction so the scan takes SHARE UPDATE EXCLUSIVE only
-- (same split as 20260717091000 after 20260717090000).

ALTER TABLE public.pending_operations
  VALIDATE CONSTRAINT pending_operations_operation_type_check;
