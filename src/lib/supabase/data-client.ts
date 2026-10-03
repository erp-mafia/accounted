import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * A Supabase client that can query data (PostgREST, Storage, Realtime),
 * with or without an auth client of its own.
 *
 * The browser client has none: the session is server-held and the browser
 * only receives short-lived access tokens (lib/supabase/client.ts). Helpers
 * that run in both places take this type, so a server client (which has
 * `auth`) and the browser client both fit, and the compiler still keeps
 * `auth` out of reach wherever the browser client flows.
 */
export type SupabaseDataClient = Omit<SupabaseClient, 'auth'>
