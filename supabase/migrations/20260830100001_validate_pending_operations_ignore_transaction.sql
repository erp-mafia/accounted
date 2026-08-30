-- Validate the operation type CHECK re-added in 20260830100000.
-- This separate transaction avoids a full-table scan while the preceding
-- migration holds its stronger table lock.

ALTER TABLE public.pending_operations
  VALIDATE CONSTRAINT pending_operations_operation_type_check;
