/**
 * The verifikat list's view in the address of /bookkeeping (crm#1998).
 *
 * The list keeps its filters, its search text and its page in the query, so
 * the browser's Back from a verifikat, the "Verifikat" link in a verifikat's
 * top bar, a reload and a shared link all open the list as it was. The sort
 * order, the page size and the row density are not part of the view: they
 * are a per-company preference the list keeps in localStorage.
 *
 * Keys, each left out at its default:
 *   status=draft          the Utkast view (the bokslut checklist links here)
 *   series=B              one verifikationsserie, A-Z
 *   from, to              the date range, YYYY-MM-DD
 *   q                     the search text
 *   corrections=all|hide  storno and omförda verifikat (collapse is the default)
 *   missing=true          Visa saknade underlag
 *   scope=all|<period id> this visit's own year, in place of the sidebar's
 *   page=3                1-based
 *
 * Two arrival links keep their older keys: missingUnderlag=true (Hem's
 * "Verifikat utan underlag", the push notification) turns the filter on for
 * all years, and gaps=<period id> (the bokslut preflight) opens the visit on
 * that räkenskapsår. The writer puts the keys above in their place, so the
 * filter someone turns on inside the list never reads back as that arrival.
 */

import { isSaneDateString } from '@/lib/invariants/iso-date'
import { isUuid } from '@/lib/invariants/uuid'

export type VerifikatListMode = 'committed' | 'drafts'
export type VerifikatCorrectionView = 'all' | 'collapse' | 'hide'

export interface VerifikatListQuery {
  mode: VerifikatListMode
  /** One series letter A-Z; null is every series. */
  series: string | null
  /** YYYY-MM-DD or ''. */
  dateFrom: string
  /** YYYY-MM-DD or ''. */
  dateTo: string
  /** The search text, trimmed; '' is no search. */
  search: string
  correctionView: VerifikatCorrectionView
  missingOnly: boolean
  /**
   * The visit's own year scope: periodId null is all years, a period id that
   * räkenskapsår. null follows the app-wide year in the sidebar.
   */
  visitScope: { periodId: string | null } | null
  /** 0-based page index. */
  page: number
}

export const DEFAULT_VERIFIKAT_LIST_QUERY: Readonly<VerifikatListQuery> = {
  mode: 'committed',
  series: null,
  dateFrom: '',
  dateTo: '',
  search: '',
  correctionView: 'collapse',
  missingOnly: false,
  visitScope: null,
  page: 0,
}

const VIEW_KEYS = ['status', 'series', 'from', 'to', 'q', 'corrections', 'missing', 'scope', 'page'] as const
const ARRIVAL_KEYS = ['missingUnderlag', 'gaps'] as const

const SERIES_LETTER_RE = /^[A-Z]$/
const PAGE_RE = /^[1-9]\d{0,5}$/

type QueryReader = { get(name: string): string | null }

/** The list's view from the query; anything unreadable is left at its default. */
export function readVerifikatListQuery(params: QueryReader): VerifikatListQuery {
  const series = params.get('series')?.trim().toUpperCase() ?? ''
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const corrections = params.get('corrections')
  const scope = params.get('scope')
  const gaps = params.get('gaps')
  const page = params.get('page') ?? ''
  const arrivedMissing = params.get('missingUnderlag') === 'true'

  let visitScope: VerifikatListQuery['visitScope'] = null
  if (scope === 'all') visitScope = { periodId: null }
  else if (isUuid(scope)) visitScope = { periodId: scope }
  // The dashboard count is over all years, so its link opens on all of them.
  else if (arrivedMissing) visitScope = { periodId: null }
  else if (isUuid(gaps)) visitScope = { periodId: gaps }

  const mode: VerifikatListMode = params.get('status') === 'draft' ? 'drafts' : 'committed'
  return {
    mode,
    series: SERIES_LETTER_RE.test(series) ? series : null,
    dateFrom: isSaneDateString(from) ? from : '',
    dateTo: isSaneDateString(to) ? to : '',
    search: params.get('q')?.trim() ?? '',
    correctionView: corrections === 'all' || corrections === 'hide' ? corrections : 'collapse',
    // Posted verifikat only, as the list's own switch to Utkast does.
    missingOnly: mode === 'committed' && (params.get('missing') === 'true' || arrivedMissing),
    visitScope,
    page: PAGE_RE.test(page) ? Number(page) - 1 : 0,
  }
}

/**
 * `base` with the list's view written in: its own keys and the two arrival
 * keys replaced, every other parameter kept where it was. A view at its
 * defaults writes nothing, so the untouched list stays at plain /bookkeeping.
 */
export function writeVerifikatListQuery(
  base: string | URLSearchParams,
  query: VerifikatListQuery,
): URLSearchParams {
  const params = new URLSearchParams(base)
  for (const key of [...VIEW_KEYS, ...ARRIVAL_KEYS]) params.delete(key)
  if (query.mode === 'drafts') params.set('status', 'draft')
  if (query.series && SERIES_LETTER_RE.test(query.series)) params.set('series', query.series)
  if (query.dateFrom) params.set('from', query.dateFrom)
  if (query.dateTo) params.set('to', query.dateTo)
  if (query.search) params.set('q', query.search)
  if (query.correctionView !== 'collapse') params.set('corrections', query.correctionView)
  if (query.missingOnly) params.set('missing', 'true')
  if (query.visitScope) params.set('scope', query.visitScope.periodId ?? 'all')
  if (query.page > 0) params.set('page', String(query.page + 1))
  return params
}
