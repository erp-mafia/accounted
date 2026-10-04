-- Validate the operation type CHECK re-added in 20261004120400.
-- Separate transaction: avoids a full-table scan under the stronger lock of
-- the preceding migration (same split as 20261003120100).

ALTER TABLE public.pending_operations
  VALIDATE CONSTRAINT pending_operations_operation_type_check;
