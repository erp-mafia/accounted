'use client'

import { useState } from 'react'
import { createClient, type BrowserSupabaseClient } from '@/lib/supabase/client'

/**
 * Stable browser Supabase client for realtime-enabled client components.
 *
 * The browser client itself is shared with normal data fetching; this hook
 * lazily creates the instance once so components can wire subscriptions
 * without recreating the client on every render. Channels authenticate with
 * the server-issued access token and pick up each rotation automatically
 * (lib/supabase/client.ts).
 */
export function useRealtimeSupabase(): BrowserSupabaseClient {
  const [supabase] = useState(() => createClient())
  return supabase
}
