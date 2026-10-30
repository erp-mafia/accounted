/**
 * The permission shadow's only I/O (./shadow.ts): one insert per logged
 * disagreement into permission_shadow_log, after the response, through the
 * service role (the table has no policy for any other role).
 *
 * The unit test setup replaces this module (tests/unit/setup.ts), so no door
 * test reaches a database through it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceRoleClient } from '@/lib/supabase/service-client'

/** One row of permission_shadow_log: ids and codes only, never a request body or a name. */
export interface ShadowRow {
  company_id: string
  user_id: string
  agent_identity_id: string | null
  api_key_id: string | null
  principal_kind: 'person' | 'agent' | 'assistant'
  door: string
  method: string | null
  today_outcome: 'allow' | 'stage' | 'deny'
  today_code: string | null
  decide_outcome: 'allow' | 'stage' | 'sign' | 'deny'
  decide_reason: string
  permission: string
  expected: boolean
  expected_reason: string | null
}

function serviceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('permission shadow: Supabase service credentials are not configured')
  return createServiceRoleClient(url, key)
}

export async function insertShadowRow(row: ShadowRow): Promise<void> {
  const { error } = await serviceClient().from('permission_shadow_log').insert(row)
  if (error) throw new Error(`permission shadow insert failed: ${error.message}`)
}
