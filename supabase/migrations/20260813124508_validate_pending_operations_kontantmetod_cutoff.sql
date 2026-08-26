-- Validate the operation type CHECK re-added in 20260813124507.
-- Kept separate to avoid a full-table scan under the stronger DDL lock.

ALTER TABLE public.pending_operations
  VALIDATE CONSTRAINT pending_operations_operation_type_check;
