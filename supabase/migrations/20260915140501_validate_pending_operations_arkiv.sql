-- Validates the operation_type check re-added NOT VALID by 20260915140500
-- (arkiv_propose_fact), in its own transaction like 20260907160101.
ALTER TABLE public.pending_operations
  VALIDATE CONSTRAINT pending_operations_operation_type_check;
