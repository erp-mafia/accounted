import type { SupabaseClient } from '@supabase/supabase-js'
import { currentAppVersion } from '@/lib/reports/app-version'

/**
 * Program version log (`app_releases`, migration 20260901103000).
 *
 * BFNAR 2013:2 p. 9.16 second paragraph: new program versions are changes to
 * the bookkeeping system that must be dated in the behandlingshistorik. Vercel
 * has no hook we can trust to write a row at deploy time, so the runtime
 * records each build the first time it answers a request: an insert that is a
 * no-op when the version is already known. A module-level guard keeps it to
 * one round-trip per function instance and version.
 */

/**
 * A service-role client, or a factory for one. The factory form exists for
 * `/api/version`, which is public and polled constantly: building a client on
 * every probe to then hit the module guard is pure waste, so the guard runs
 * first and the client is only constructed on the one request that writes.
 */
type ServiceClientLike = Pick<SupabaseClient, 'from'>
type ServiceClientSource = ServiceClientLike | (() => ServiceClientLike)

let recordedVersion: string | null = null

export interface AppReleaseRow {
  version: string
  first_seen_at: string
  source: string
}

/**
 * Record the running version if this instance has not already. Never throws:
 * a failed bookkeeping of the version must not fail the request carrying it.
 * Returns the version recorded (or already known), null when unknown.
 */
export async function recordAppRelease(
  serviceClient: ServiceClientSource,
  rawVersion: string | null = currentAppVersion(),
): Promise<string | null> {
  // Same 12-character form as currentAppVersion(), whatever the caller passes
  // (the /api/version probe has the full commit SHA).
  const version = rawVersion ? rawVersion.slice(0, 12) : null
  if (!version) return null
  if (recordedVersion === version) return version
  try {
    // Inside the try: a missing service key (local dev, self-hosted without
    // one) throws on construction, and the version probe must survive that.
    const client = typeof serviceClient === 'function' ? serviceClient() : serviceClient
    const { error } = await client
      .from('app_releases')
      .upsert({ version, source: 'runtime' }, { onConflict: 'version', ignoreDuplicates: true })
    if (!error) recordedVersion = version
  } catch {
    // swallowed on purpose, see above
  }
  return version
}

/** Test hook: forget the per-instance guard. */
export function resetAppReleaseGuardForTests(): void {
  recordedVersion = null
}

/** Versions first seen inside [fromTs, toTs], oldest first. Readable by every signed-in user. */
export async function fetchAppReleases(
  supabase: Pick<SupabaseClient, 'from'>,
  window: { fromTs: string; toTs: string },
): Promise<AppReleaseRow[]> {
  const { data, error } = await supabase
    .from('app_releases')
    .select('version, first_seen_at, source')
    .gte('first_seen_at', window.fromTs)
    .lte('first_seen_at', window.toTs)
    .order('first_seen_at', { ascending: true })
  if (error) throw new Error(`Failed to fetch app releases: ${error.message}`)
  return (data as AppReleaseRow[] | null) ?? []
}
