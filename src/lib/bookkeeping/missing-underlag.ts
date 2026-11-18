import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import { escapeLikePattern } from '@/lib/supabase/like-pattern'
import { parseVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * "Posted verifikat that lack underlag", scoped by the journal list's filters.
 *
 * Resolved by the list_verifikat_missing_underlag RPC (migration
 * 20261023001000) in ONE statement: the verifikat_without_documents predicate
 * (posted + document-requiring source type, no current-version document, no
 * BFL 5 kap 7 § hänvisning via a supplier invoice whose retained document is
 * anchored or via an issued customer invoice that points at the entry, no
 * journal_entry_no_doc_required exemption), narrowed by the list's filters,
 * sorted and paged in SQL. Used by the journal list's missing_underlag filter
 * and the bulk "Inget underlag krävs" route, so the two can never disagree,
 * and pinned to the dashboard badge's RPC by
 * tests/pg/list-verifikat-missing-underlag.pg.test.ts.
 *
 * The set used to be resolved here in TypeScript: every candidate verifikat
 * read into the server, then probed 150 ids at a time against five tables, one
 * chunk after the other. That cost grew with the ledger rather than with the
 * answer, and a ten-year ledger waited through hundreds of round trips before
 * the first page showed (crm#1390).
 */

export interface MissingUnderlagFilters {
  periodId?: string | null
  /** Single uppercase verifikationsserie (A-Z); null/undefined = all. */
  series?: string | null
  dateFrom?: string | null
  dateTo?: string | null
  /** Free-text ilike over the voucher description; a voucher label also matches series + number. */
  search?: string | null
}

/** A column the RPC can order the missing set by (its p_order allowlist). */
export type MissingUnderlagOrderColumn =
  | 'entry_date'
  | 'voucher_series'
  | 'voucher_number'
  | 'description'
  | 'display_amount'
  | 'id'

export interface MissingUnderlagOrderTerm {
  column: MissingUnderlagOrderColumn
  ascending: boolean
}

/** The journal list's sort keys, as the list route parses `sort_by`. */
export interface JournalListSortKey {
  column: 'date' | 'voucher' | 'total' | 'description'
  ascending: boolean
}

/**
 * The complete order of the missing set for the list's sort, with the same
 * key semantics as the list's direct query: the sort stack in priority order,
 * a series+number tiebreak in the last key's direction unless voucher is
 * already a key, and a final id tiebreak so pages never overlap. Amount keys
 * order by display_amount, the amount the Belopp column shows (crm#1280). No
 * keys: the legacy `sort_date` (date, series, number, id in that direction),
 * else series+number ascending.
 */
export function missingUnderlagOrder(
  sortKeys: readonly JournalListSortKey[],
  legacySortDate: string | null,
): MissingUnderlagOrderTerm[] {
  const keys: JournalListSortKey[] =
    sortKeys.length > 0
      ? [...sortKeys]
      : legacySortDate === 'asc' || legacySortDate === 'desc'
        ? [{ column: 'date', ascending: legacySortDate === 'asc' }]
        : []
  const terms: MissingUnderlagOrderTerm[] = []
  for (const { column, ascending } of keys) {
    switch (column) {
      case 'date':
        terms.push({ column: 'entry_date', ascending })
        break
      case 'voucher':
        terms.push({ column: 'voucher_series', ascending }, { column: 'voucher_number', ascending })
        break
      case 'total':
        terms.push({ column: 'display_amount', ascending })
        break
      case 'description':
        terms.push({ column: 'description', ascending })
        break
    }
  }
  const lastAscending = keys.length > 0 ? keys[keys.length - 1].ascending : true
  if (!keys.some((k) => k.column === 'voucher')) {
    terms.push(
      { column: 'voucher_series', ascending: lastAscending },
      { column: 'voucher_number', ascending: lastAscending },
    )
  }
  terms.push({ column: 'id', ascending: lastAscending })
  return terms
}

/**
 * Query failure. `userMessage` is already mapped through getErrorMessage()
 * (user-facing Swedish), never a raw driver message. `cause` is the raw
 * PostgREST error (or the RPC's refusal code) for the server log: the mapped
 * text alone hid a gateway 414 behind "Något gick fel" for a whole evening of
 * proxy-log reading (#2395).
 */
export class MissingUnderlagQueryError extends Error {
  constructor(
    public readonly userMessage: string,
    public readonly cause: PostgrestError | unknown,
  ) {
    super(userMessage)
  }
}

/** Most ids one call returns: the RPC clamps p_limit to the same ceiling. */
export const MISSING_UNDERLAG_PAGE_MAX = 1000

export interface MissingUnderlagPage {
  /** The full filtered total, over every page. */
  total: number
  /** One page of verifikat ids, in the requested order. */
  ids: string[]
}

/**
 * One page of the missing set plus its full total, in one RPC call.
 *
 * @throws MissingUnderlagQueryError when the RPC fails or refuses.
 */
export async function listMissingUnderlagPage(
  supabase: SupabaseClient,
  companyId: string,
  filters: MissingUnderlagFilters,
  {
    order = [],
    limit,
    offset = 0,
  }: { order?: readonly MissingUnderlagOrderTerm[]; limit: number; offset?: number },
): Promise<MissingUnderlagPage> {
  const search = filters.search?.trim() || null
  // This path reads the needle itself, as text and as a voucher label: a
  // label-shaped needle ("A209") also matches series+number, so searching
  // for a voucher by its own label works with the filter on. The journal
  // list's direct query reads more (an account number, an amount, a
  // bokföringsdatum: lib/bookkeeping/verifikat-search.ts). The RPC takes
  // none of those, so the list's search box names only the text and the
  // label while the filter is on.
  const voucher = search ? parseVoucher(search) : null

  const { data, error } = await supabase.rpc('list_verifikat_missing_underlag', {
    p_company_id: companyId,
    p_period_id: filters.periodId ?? null,
    p_series: filters.series ?? null,
    p_date_from: filters.dateFrom ?? null,
    p_date_to: filters.dateTo ?? null,
    p_search_pattern: search ? `%${escapeLikePattern(search)}%` : null,
    p_search_voucher_series: voucher?.series ?? null,
    p_search_voucher_number: voucher?.number ?? null,
    p_order: order.map((t) => `${t.column}.${t.ascending ? 'asc' : 'desc'}`),
    p_limit: limit,
    p_offset: offset,
  })
  if (error) throw new MissingUnderlagQueryError(getUserErrorMessage(error), error)

  const result = data as { ok?: boolean; code?: string; total_count?: number; ids?: string[] } | null
  if (!result?.ok) {
    const code = result?.code ?? 'LIST_VERIFIKAT_MISSING_UNDERLAG_NO_RESULT'
    throw new MissingUnderlagQueryError(getUserErrorMessage(new Error(code)), code)
  }
  return { total: Number(result.total_count ?? 0), ids: result.ids ?? [] }
}

/**
 * Every id in the missing set, for the bulk action that marks them all. Pages
 * through the RPC in id order at its ceiling, so the call count follows the
 * size of the answer (one call per 1,000 missing verifikat), not the ledger.
 *
 * @throws MissingUnderlagQueryError when a page fails.
 */
export async function listAllMissingUnderlagIds(
  supabase: SupabaseClient,
  companyId: string,
  filters: MissingUnderlagFilters,
): Promise<string[]> {
  const order: MissingUnderlagOrderTerm[] = [{ column: 'id', ascending: true }]
  const ids: string[] = []
  for (;;) {
    const page = await listMissingUnderlagPage(supabase, companyId, filters, {
      order,
      limit: MISSING_UNDERLAG_PAGE_MAX,
      offset: ids.length,
    })
    ids.push(...page.ids)
    if (page.ids.length < MISSING_UNDERLAG_PAGE_MAX || ids.length >= page.total) return ids
  }
}
