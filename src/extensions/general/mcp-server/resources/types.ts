import type { SupabaseClient } from '@supabase/supabase-js'
import type { ApiKeyScope } from '@/lib/auth/api-keys'

export interface ResourceContext {
  supabase: SupabaseClient
  companyId: string
  userId: string
  scopes: ApiKeyScope[]
  query?: URLSearchParams
}

export interface McpResource {
  uri: string
  name: string
  description: string
  mimeType: string
  read: (ctx: ResourceContext) => Promise<unknown>
}
