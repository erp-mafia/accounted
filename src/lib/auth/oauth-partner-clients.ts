import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Partner OAuth clients: rows in oauth_partner_clients (migration
 * 20261119132951), read with the service role. A row names a partner
 * platform and one callback, exact or a hardened prefix, on the partner's own
 * https host. The MCP OAuth endpoints accept a redirect URI that matches an
 * active row, the consent page names the partner as a verified client, and
 * keys minted through it carry the client `partner:<slug>`.
 *
 * Adding a partner is an INSERT, revoking one an UPDATE of revoked_at; no
 * deploy. The table's CHECK constraints hold the same shapes as the code
 * below, and the code checks them again, so a row that slipped past them
 * still matches nothing.
 */

export type PartnerClientMatch = 'exact' | 'prefix'

export interface PartnerClientRow {
  id: string
  slug: string
  name: string
  host: string
  path: string
  match: PartnerClientMatch
  created_at: string
}

/** The partner a redirect URI resolved to. */
export interface PartnerClient {
  id: string
  slug: string
  name: string
}

/** api_keys.client of a key minted through a partner. */
export function partnerClientValue(slug: string): string {
  return `partner:${slug}`
}

/** The slug behind an api_keys.client value, or null when it is not a partner's. */
export function partnerSlugOf(client: string | null | undefined): string | null {
  if (typeof client !== 'string') return null
  return /^partner:([a-z][a-z0-9_]{1,39})$/.exec(client)?.[1] ?? null
}

const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
/** One or more plain path segments and an optional final slash: no dot segment, percent-encoding, query or fragment. */
const SEGMENTS = /^(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+\/?$/

/**
 * The host of an https redirect URI as written, or null. Read from the raw
 * string, never through `new URL`: the match below compares raw strings, so
 * the host it looks up must be the one the browser will be sent to. Only a
 * lower-case host followed by a slash or the end qualifies, so a port,
 * userinfo or an upper-case host finds no row.
 */
export function redirectUriHost(uri: string): string | null {
  return /^https:\/\/([a-z0-9.-]+)(\/|$)/.exec(uri)?.[1] ?? null
}

/** True when `uri` is the row's callback: exact, or under its prefix as plain path segments. */
export function partnerRowMatches(uri: string, row: Pick<PartnerClientRow, 'host' | 'path' | 'match'>): boolean {
  if (typeof uri !== 'string' || !HOST.test(row.host) || row.host.length > 253) return false
  if (row.path !== '/' && !SEGMENTS.test(row.path)) return false
  const origin = `https://${row.host}`
  if (row.match === 'exact') return uri === origin + row.path
  if (row.match !== 'prefix' || row.path === '/') return false
  const base = origin + row.path.replace(/\/$/, '')
  return uri.startsWith(base) && SEGMENTS.test(uri.slice(base.length))
}

/** Exact rows before prefixes, a longer path before a shorter one, then the older row. */
function precedence(a: PartnerClientRow, b: PartnerClientRow): number {
  if (a.match !== b.match) return a.match === 'exact' ? -1 : 1
  if (a.path.length !== b.path.length) return b.path.length - a.path.length
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
}

/** Active rows read per host: far above any real partner, and keeps the read bounded. */
const ROWS_PER_HOST = 50

/**
 * The partner whose active row matches `uri`, or null. Throws when the table
 * cannot be read, so the caller decides how to fail (the allowlist fails
 * closed for the partner and lets the member registrations answer).
 */
export async function findPartnerClient(uri: string, client: SupabaseClient): Promise<PartnerClient | null> {
  const host = redirectUriHost(uri)
  if (!host) return null
  const { data, error } = await client
    .from('oauth_partner_clients')
    .select('id, slug, name, host, path, match, created_at')
    .eq('host', host)
    .is('revoked_at', null)
    .order('created_at', { ascending: true })
    .limit(ROWS_PER_HOST)
  if (error) throw error
  const hit = ((data ?? []) as PartnerClientRow[]).filter((row) => partnerRowMatches(uri, row)).sort(precedence)[0]
  return hit ? { id: hit.id, slug: hit.slug, name: hit.name } : null
}

/**
 * The names the records give keys minted through partners, by slug: the
 * newest row of each slug, revoked rows included, so a revoked partner's old
 * keys keep their name. A slug without a row, or a failed read, is left out.
 */
export async function partnerClientNames(client: SupabaseClient, slugs: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const wanted = [...new Set(slugs)]
  if (wanted.length === 0) return names
  const { data, error } = await client
    .from('oauth_partner_clients')
    .select('slug, name, created_at')
    .in('slug', wanted)
    .order('created_at', { ascending: false })
    .limit(ROWS_PER_HOST * wanted.length)
  if (error) return names
  for (const row of (data ?? []) as Pick<PartnerClientRow, 'slug' | 'name'>[]) {
    if (!names.has(row.slug) && typeof row.name === 'string' && row.name.trim()) names.set(row.slug, row.name.trim())
  }
  return names
}
