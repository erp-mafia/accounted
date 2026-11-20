import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Client for the bulk hard-delete RPCs (undo_bank_file_import,
 * undo_register_import, reset_fiscal_year).
 *
 * The authenticated role carries statement_timeout=8s on hosted Supabase,
 * and deleting a large import (thousands of journal_entries, each firing
 * write_audit_log with a JSONB old_state snapshot, plus cascading lines)
 * does not finish inside that budget: the RPC dies with "canceling
 * statement due to statement timeout" and rolls back. The service role has
 * no statement_timeout, so the RPC runs on it instead.
 *
 * Safe escalation: callers validate company ownership against the
 * RLS-scoped session client BEFORE the RPC, and the RPC itself (SECURITY
 * DEFINER) re-filters every statement on p_company_id.
 *
 * Falls back to the caller's client when the service key is absent
 * (unit tests, misconfigured self-hosted), same behavior as before.
 */
export async function rpcClientForBulkDelete(fallback: SupabaseClient): Promise<SupabaseClient> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return fallback
  const { createServiceClient } = await import('@/lib/supabase/server')
  return createServiceClient()
}
