import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceRoleClient } from '@/lib/supabase/service-client'

/**
 * The service-role client the TIC budget and response cache use. The Lens
 * client runs in request handlers, server components, extension services and
 * MCP tools alike, none of which hand it a client, and the budget tables are
 * service-role only. Null when the instance has no service-role config: the
 * budget then fails open and the shared cache is skipped, exactly as before
 * the budget existed.
 */
export function ticBudgetServiceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createServiceRoleClient(url, key)
}
