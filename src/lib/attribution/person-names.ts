import type { SupabaseClient } from '@supabase/supabase-js'

/** Ids per profiles read: well under the gateway's request-line limit. */
const ID_CHUNK = 100

/**
 * The names attribution lines give the people agents act for: the full name
 * when they gave one, else the e-mail. `profiles` RLS is self-only, so the
 * caller passes a service-role client; the read is scoped to exactly these
 * ids. Best-effort: a failed read leaves names out (the line then names the
 * agent alone), never fails the surface that asked.
 */
export async function resolvePersonNames(
  client: Pick<SupabaseClient, 'from'>,
  userIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const ids = [...new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    try {
      const { data, error } = await client.from('profiles').select('id, email, full_name').in('id', ids.slice(i, i + ID_CHUNK))
      if (error) continue
      for (const row of (data ?? []) as { id: string; email: string | null; full_name: string | null }[]) {
        const name = row.full_name?.trim() || row.email?.trim()
        if (name) names.set(row.id, name)
      }
    } catch {
      // Best-effort, see above.
    }
  }
  return names
}
