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

/**
 * Who saved something (a remembered fact, an own instruction), for surfaces
 * that show the person by name and never by e-mail.
 */
export interface Creator {
  /** The full name; null when the person gave none, the account was deleted, or the profile could not be read. */
  name: string | null
  /** The account was deleted (the profiles tombstone). A profile that could not be read is not deleted. */
  deleted: boolean
}

/** A creator who gave no name, or whose profile could not be read. */
export const UNNAMED_CREATOR: Creator = { name: null, deleted: false }

/**
 * Creators by user id, for surfaces that must never show an e-mail: unlike
 * resolvePersonNames, the e-mail is not even read. A deleted account keeps
 * its profiles row as a tombstone (anonymize_user_account sets deleted_at and
 * anonymized_at), so "deleted" is that positive signal only; a missing row or
 * a failed read is left out, and creatorOf reads it as UNNAMED_CREATOR.
 *
 * `profiles` RLS is self-only: the caller passes a service-role client and
 * only ids taken from rows it already read for the company. Best-effort like
 * resolvePersonNames: never fails the surface that asked.
 */
export async function resolveCreators(
  client: Pick<SupabaseClient, 'from'>,
  userIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, Creator>> {
  const creators = new Map<string, Creator>()
  const ids = [...new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    try {
      const { data, error } = await client.from('profiles').select('id, full_name, deleted_at, anonymized_at').in('id', ids.slice(i, i + ID_CHUNK))
      if (error) continue
      for (const row of (data ?? []) as { id: string; full_name: string | null; deleted_at: string | null; anonymized_at: string | null }[]) {
        const deleted = row.deleted_at != null || row.anonymized_at != null
        creators.set(row.id, { name: deleted ? null : row.full_name?.trim() || null, deleted })
      }
    } catch {
      // Best-effort, see above.
    }
  }
  return creators
}

/** The creator of a row: null when the row records none, UNNAMED_CREATOR when the profile was not read. */
export function creatorOf(creators: ReadonlyMap<string, Creator>, userId: string | null | undefined): Creator | null {
  if (!userId) return null
  return creators.get(userId) ?? UNNAMED_CREATOR
}

/**
 * The creator in an agent payload (MCP): `created_by` with the name, or
 * `created_by_deleted` when the account was deleted; nothing when neither is
 * known, so a payload never carries an e-mail or a placeholder label.
 */
export function creatorFields(creator: Creator | null | undefined): { created_by?: string; created_by_deleted?: true } {
  if (creator?.name) return { created_by: creator.name }
  if (creator?.deleted) return { created_by_deleted: true }
  return {}
}
