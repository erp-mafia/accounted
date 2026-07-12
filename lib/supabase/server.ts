import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

// During Docker builds, NEXT_PUBLIC_* vars are placeholder sentinels
// replaced at runtime by docker-entrypoint.sh.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const isBuildPlaceholder = url?.startsWith('__')
const safeUrl = isBuildPlaceholder ? 'https://placeholder.supabase.co' : url
const safeKey = isBuildPlaceholder ? 'placeholder' : key

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    safeUrl,
    safeKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  )
}

export function createServiceClient() {
  // Stateless service-role client: no cookies.
  // Passing user session cookies causes @supabase/ssr to send the
  // user's JWT as the Authorization header, which overrides the
  // service role key and re-enables RLS. A cookie-less client
  // ensures the service role key is used for authorization,
  // properly bypassing RLS on every query.
  return createServerClient(
    safeUrl,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll: () => [], setAll: () => {} } }
  )
}
