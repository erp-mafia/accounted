import { COMPANY_SEARCH_MIN_CHARS } from './types'
import type { CompanyLookupResult, CompanySearchHit, CompanySuggestion } from './types'
import { normalizeOrgNumber } from './normalize-org-number'

/**
 * Outcome of a client-side TIC company lookup.
 *
 * - `found`: TIC answered with company data.
 * - `not_found`: TIC looked and the company does not exist (the handler's
 *   404 with body `{ error: 'Company not found' }`). Show the "hittas inte"
 *   path; the user continues manually.
 * - `disabled`: the lookup surface is not available at all: TIC extension
 *   off client-side, malformed orgnr, legacy 403, dispatcher 404
 *   ("Extension not found" / "Route not found"), or a feature-flag 503
 *   (`code: 'EXTENSION_DISABLED'`). Degrade silently to the manual path;
 *   there is nothing the user can do and nothing is wrong with their input.
 * - `error`: transient failure (429 rate limit, 502/504 upstream, 503
 *   NOT_CONFIGURED, 500, network). Show the advisory "kunde inte hämta"
 *   note and continue manually. Never blocks.
 * - `aborted`: the caller's AbortSignal fired; ignore the result.
 */
export type CompanyLookupOutcome =
  | { status: 'found'; result: CompanyLookupResult }
  | { status: 'not_found' }
  | { status: 'disabled' }
  | { status: 'error' }
  | { status: 'aborted' }

/**
 * Shared client-side TIC lookup for the onboarding surfaces (wizard Step 2
 * and the journey flow). One GET to the extension dispatcher; never throws.
 *
 * Fixes the historical 403/404 conflation: the dispatcher returns 404 for a
 * missing extension and 503 (`EXTENSION_DISABLED`) for a feature-flagged one,
 * while the TIC handler's own 404 means "company not found". A dispatcher-level
 * miss must degrade silently instead of telling the user their company
 * doesn't exist.
 *
 * TIC budget note: this is the ONLY function that may call the Lens-backed
 * `/lookup` from the client. Callers fire it once per confirmed orgnr
 * (Enter / picker selection), not per keystroke; the server keeps a 5-min
 * process cache as a second guard.
 */
export async function fetchCompanyLookup(
  orgNumber: string,
  opts: { ticEnabled: boolean; signal?: AbortSignal },
): Promise<CompanyLookupOutcome> {
  if (!opts.ticEnabled) return { status: 'disabled' }
  if (normalizeOrgNumber(orgNumber) === null) return { status: 'disabled' }

  let res: Response
  try {
    res = await fetch(
      `/api/extensions/ext/tic/lookup?org_number=${encodeURIComponent(orgNumber)}`,
      { signal: opts.signal },
    )
  } catch (err) {
    if ((err as Error).name === 'AbortError') return { status: 'aborted' }
    return { status: 'error' }
  }
  if (opts.signal?.aborted) return { status: 'aborted' }

  if (res.ok) {
    try {
      const { data } = (await res.json()) as { data: CompanyLookupResult }
      if (!data || typeof data !== 'object') return { status: 'error' }
      return { status: 'found', result: data }
    } catch {
      return { status: 'error' }
    }
  }

  return mapFailure(res)
}

export type CompanySearchOutcome =
  | { status: 'found'; hits: CompanySearchHit[] }
  | { status: 'not_found' }
  | { status: 'disabled' }
  | { status: 'error' }
  | { status: 'aborted' }

/**
 * Free-text counterpart of fetchCompanyLookup for the journey's orgnr field,
 * which also accepts a company name. Same dispatcher, same failure mapping,
 * same budget rule: fire once per Enter, never per keystroke. Each hit already
 * carries the full lookup result, so picking one needs no further call.
 */
export async function fetchCompanySearch(
  query: string,
  opts: { ticEnabled: boolean; signal?: AbortSignal },
): Promise<CompanySearchOutcome> {
  if (!opts.ticEnabled) return { status: 'disabled' }
  const trimmed = query.trim()
  if (trimmed.length < COMPANY_SEARCH_MIN_CHARS) return { status: 'disabled' }

  let res: Response
  try {
    res = await fetch(`/api/extensions/ext/tic/search?q=${encodeURIComponent(trimmed)}`, {
      signal: opts.signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') return { status: 'aborted' }
    return { status: 'error' }
  }
  if (opts.signal?.aborted) return { status: 'aborted' }

  if (res.ok) {
    try {
      const { data } = (await res.json()) as { data: CompanySearchHit[] }
      if (!Array.isArray(data)) return { status: 'error' }
      const hits = data.filter(
        (h) => h && typeof h.orgNumber === 'string' && h.result && typeof h.result === 'object',
      )
      return hits.length > 0 ? { status: 'found', hits } : { status: 'not_found' }
    } catch {
      return { status: 'error' }
    }
  }

  return mapFailure(res)
}

export type CompanySuggestOutcome =
  | { status: 'found'; suggestions: CompanySuggestion[]; truncated: boolean }
  | { status: 'empty'; truncated: boolean }
  | { status: 'disabled' }
  | { status: 'error' }
  | { status: 'aborted' }

/**
 * Search-as-you-type for the journey's orgnr field: SCB's företagsregister
 * via the core route, never TIC. Free, so the caller may fire it per
 * debounced keystroke; the AbortSignal drops the superseded request. A
 * 503 (SCB not configured in this environment) is `disabled` so the field
 * quietly stays an orgnr-or-Enter field; every other failure is `error`
 * and the picker just does not appear. Never throws.
 */
export async function fetchCompanySuggestions(
  query: string,
  opts: { signal?: AbortSignal } = {},
): Promise<CompanySuggestOutcome> {
  const trimmed = query.trim()
  if (trimmed.length < COMPANY_SEARCH_MIN_CHARS) return { status: 'disabled' }

  let res: Response
  try {
    res = await fetch(`/api/company/search?q=${encodeURIComponent(trimmed)}`, { signal: opts.signal })
  } catch (err) {
    if ((err as Error).name === 'AbortError') return { status: 'aborted' }
    return { status: 'error' }
  }
  if (opts.signal?.aborted) return { status: 'aborted' }

  if (res.ok) {
    try {
      const { data } = (await res.json()) as {
        data: { suggestions: CompanySuggestion[]; truncated: boolean }
      }
      if (!data || !Array.isArray(data.suggestions)) return { status: 'error' }
      const suggestions = data.suggestions.filter(
        (h) => h && typeof h.orgNumber === 'string' && typeof h.name === 'string',
      )
      const truncated = data.truncated === true
      return suggestions.length > 0 ? { status: 'found', suggestions, truncated } : { status: 'empty', truncated }
    } catch {
      return { status: 'error' }
    }
  }
  if (res.status === 503) return { status: 'disabled' }
  return { status: 'error' }
}

/** Shared non-ok mapping: dispatcher misses degrade silently, only the TIC
 *  handler's own 404 is a user-facing "not found". */
async function mapFailure(
  res: Response,
): Promise<{ status: 'not_found' } | { status: 'disabled' } | { status: 'error' }> {
  // Non-ok: read the body (best-effort) to disambiguate.
  let body: { error?: unknown; code?: unknown } = {}
  try {
    const parsed = (await res.json()) as unknown
    if (parsed && typeof parsed === 'object') {
      body = parsed as { error?: unknown; code?: unknown }
    }
  } catch {
    // Non-JSON error body: fall through to status-only mapping.
  }

  if (res.status === 403) return { status: 'disabled' }
  if (res.status === 404) {
    // TIC handler: { error: 'Company not found' }. Dispatcher: 'Extension
    // not found' / 'Route not found'. Only the former is a user-facing miss.
    return body.error === 'Company not found'
      ? { status: 'not_found' }
      : { status: 'disabled' }
  }
  if (res.status === 503 && body.code === 'EXTENSION_DISABLED') {
    return { status: 'disabled' }
  }
  return { status: 'error' }
}
