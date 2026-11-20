-- Validate the operation type CHECK re-added in 20260925230000.
-- Separate transaction: avoids a full-table scan under the stronger lock of
-- the preceding migration (same split as 20260925220001).

ALTER TABLE public.pending_operations
  VALIDATE CONSTRAINT pending_operations_operation_type_check;
