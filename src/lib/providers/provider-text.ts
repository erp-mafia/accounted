/**
 * Every provider client (Bokio, Fortnox, Visma, Briox, Björn Lundén, Wint)
 * hands its parsed JSON body through `cleanProviderPayload` before anything
 * else reads it, so no provider string can carry an invisible control
 * character into the database.
 *
 * Why here and not per field: Postgres `text` rejects U+0000 outright, so one
 * NUL inside a Bokio invoice number made the insert AND its per-row retry fail
 * and the invoice was silently absent from the import. The other C0 controls
 * are accepted by Postgres but are equally invisible, break copy/paste and
 * never mean anything in an invoice number, a name or an address. Cleaning the
 * whole payload once, at the boundary where provider data enters the process,
 * covers every field every mapper will ever read instead of the one that
 * happened to fail first.
 *
 * Tab, line feed and carriage return are kept: they are legitimate in free
 * text such as descriptions and notes.
 */

const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/** Remove control characters (except tab, LF, CR) from one provider string. */
export function cleanProviderText(value: string): string {
  return value.replace(UNSAFE_CONTROL_CHARACTERS, '')
}

/**
 * Deep-clean every string value in a parsed provider JSON body. Object keys
 * are left alone: they come from the provider's schema, not from user input.
 * Returns the input unchanged (same reference) for non-string scalars.
 */
export function cleanProviderPayload<T>(value: T): T {
  if (typeof value === 'string') return cleanProviderText(value) as T
  if (Array.isArray(value)) return value.map((item) => cleanProviderPayload(item)) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = cleanProviderPayload(item)
    }
    return out as T
  }
  return value
}
