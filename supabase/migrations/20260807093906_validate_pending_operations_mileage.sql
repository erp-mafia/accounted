-- Validate the operation type CHECK re-added in 20260807093856.
-- Separate transaction to avoid a full-table scan under the stronger lock.

ALTER TABLE public.pending_operations
  VALIDATE CONSTRAINT pending_operations_operation_type_check;
