-- Reviewed repair snapshots are operator-only evidence. The owner/admin
-- archive path already reads them with its verified service-role client.
REVOKE ALL ON public.sie_duplicate_repair_items FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS sie_repair_items_read ON public.sie_duplicate_repair_items;
GRANT SELECT ON public.sie_duplicate_repair_items TO service_role;

-- Trigger checks continue through sie_active_repair_for_entry(), whose
-- SECURITY DEFINER lookup verifies company membership for browser callers.
NOTIFY pgrst, 'reload schema';
