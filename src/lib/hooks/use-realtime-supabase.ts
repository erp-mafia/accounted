'use client'

import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'

/**
 * Stable browser Supabase client for realtime-enabled client components.
 *
 * The browser client itself is shared with normal data fetching; this hook
 * lazily creates the instance once so components can wire subscriptions
 * without recreating the client on every render.
 */
export function useRealtimeSupabase(): SupabaseClient {
  const [supabase] = useState(() => createClient())
  return supabase
}
