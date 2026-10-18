/**
 * The stored icon for each counterpart of a list, in one query. Server only.
 *
 * Each counterpart's domain is resolved here (./resolve.ts, pure), and the
 * domains with a found icon are read from vendor_logos with the service
 * role (the table has no member policies). What leaves is a public URL into
 * our own logos bucket, named by content hash: the browser never learns the
 * domain and never contacts the vendor. A failed read is no logo, never a
 * failed list.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import { resolveVendorDomain, type CounterpartHints } from './resolve'
import { LOGO_BUCKET } from './schedule'

export interface CounterpartRef extends CounterpartHints {
  /** The caller's key for the row (an item id, a transaction id). */
  key: string
}

/** Domains per query: a few hundred hosts keep the request line short. */
const IN_CHUNK = 300

/**
 * key -> public icon URL, for the counterparts that have one. Rows without
 * a resolvable domain, or whose domain has no found icon, are absent.
 */
export async function vendorLogoUrls(
  counterparts: readonly CounterpartRef[],
  client?: SupabaseClient,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const domainOf = new Map<string, string>()
  for (const c of counterparts) {
    const resolved = resolveVendorDomain(c)
    if (resolved) domainOf.set(c.key, resolved.domain)
  }
  const domains = [...new Set(domainOf.values())]
  if (domains.length === 0) return out

  try {
    const service = client ?? createServiceClient()
    const pathOf = new Map<string, string>()
    for (let i = 0; i < domains.length; i += IN_CHUNK) {
      const { data, error } = await service
        .from('vendor_logos')
        .select('domain, storage_path')
        .eq('status', 'found')
        .in('domain', domains.slice(i, i + IN_CHUNK))
      if (error) return out
      for (const row of (data ?? []) as Array<{ domain: string; storage_path: string | null }>) {
        if (row.storage_path) pathOf.set(row.domain, row.storage_path)
      }
    }
    const urlOf = new Map<string, string>()
    for (const [key, domain] of domainOf) {
      const path = pathOf.get(domain)
      if (!path) continue
      let url = urlOf.get(path)
      if (!url) {
        url = service.storage.from(LOGO_BUCKET).getPublicUrl(path).data.publicUrl
        urlOf.set(path, url)
      }
      out.set(key, url)
    }
  } catch {
    // No logo is a fine answer; the list itself must not fail over one.
  }
  return out
}
