import { NextResponse } from 'next/server'
import { createDraftEntry, createJournalEntry } from '@/lib/bookkeeping/engine'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateJournalEntrySchema } from '@/lib/api/schemas'
import { escapeLikePattern } from '@/lib/invoices/duplicate-payment-guard'
import { parseVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  MissingUnderlagQueryError,
  resolveMissingUnderlagEntries,
  type MissingUnderlagEntry,
} from '@/lib/bookkeeping/missing-underlag'

ensureInitialized()

// Query params are hand-parsed with per-param clamping/regex validation (see
// each param's comment) rather than a Zod schema; response shapes are legacy
// `{ data, count }` / `{ error: string }` for the verifikat list UI.
export const GET = withRouteContext('bookkeeping.journal_entries.list', async (request, ctx) => {
  const { supabase, companyId, log } = ctx

  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')
  const status = searchParams.get('status')
  // Drafts get their own surface in the UI; the committed list excludes them.
  const excludeDraft = searchParams.get('exclude_draft') === 'true'
  // Collapse a correction group to the live correction (hide the storno and the
  // reversed original it replaced). The full chain stays reachable.
  const collapseCorrections = searchParams.get('collapse_corrections') === 'true'
  // Clamp pagination to bound DB work against oversized/pathological inputs
  // (compliance A.8.28 / ASVS V1.2.5). The UI page-size selector offers
  // 20/50/100/Alla; "Alla" sends a large limit which is capped at MAX_LIMIT.
  const MAX_LIMIT = 100000
  const rawLimit = parseInt(searchParams.get('limit') || '50', 10)
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT) : 50
  const rawOffset = parseInt(searchParams.get('offset') || '0', 10)
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0
  const dateFrom = searchParams.get('date_from')
  const dateTo = searchParams.get('date_to')
  const sortDate = searchParams.get('sort_date') // 'asc' | 'desc'
  // 'series' optional filter: single uppercase letter A-Z. Ignored if any
  // other value is passed (defense against trivial injection / typos).
  const seriesRaw = searchParams.get('series')
  const seriesFilter = seriesRaw && /^[A-Z]$/.test(seriesRaw) ? seriesRaw : null
  // Free-text search over the voucher description (verifikationstext). When set,
  // we take the direct-query path below (the include_related RPC can't search),
  // which filters strictly by fiscal_period_id. So search is scoped to the
  // selected fiscal period / company and (like voucher sort) does NOT surface
  // cross-period follow-up entries: every result stays inside the selected
  // year's series (the BFL-compliant per-year view). It narrows the period, it
  // never widens it.
  const search = searchParams.get('search')?.trim() || null
  // sort_by is a comma-separated priority list of `${column}_${direction}`
  // tokens over date | voucher | total | description (single tokens, the old
  // format, stay valid). Unknown tokens are ignored, repeated columns are
  // deduped, and the list is capped at 3 keys to bound DB work. Amount keys
  // order by the total_amount computed column (sum of debit lines, migration
  // 20260811100000): PostgREST evaluates it per row, which the RPC path
  // below cannot express. sort_by overrides sort_date when present;
  // sort_date is kept for backwards compatibility with older clients.
  const SORT_TOKEN_RE = /^(date|voucher|total|description)_(asc|desc)$/
  const MAX_SORT_KEYS = 3
  const sortKeys: { column: 'date' | 'voucher' | 'total' | 'description'; ascending: boolean }[] = []
  for (const token of (searchParams.get('sort_by') ?? '').split(',')) {
    const m = SORT_TOKEN_RE.exec(token.trim())
    if (!m) continue
    const column = m[1] as (typeof sortKeys)[number]['column']
    if (sortKeys.some((k) => k.column === column)) continue
    sortKeys.push({ column, ascending: m[2] === 'asc' })
    if (sortKeys.length === MAX_SORT_KEYS) break
  }
  // A single date key (or no keys at all) is the only shape the RPC path can
  // serve, via p_sort_date. Everything else falls through to the direct query.
  const soloDateKey = sortKeys.length === 1 && sortKeys[0].column === 'date' ? sortKeys[0] : null
  // Default on: when a fiscal period is selected, include follow-up entries
  // booked in later periods whose source aggregate (invoice, supplier invoice)
  // is dated inside the selected period. Pass include_related=false to
  // restore strict fiscal_period_id filtering.
  const includeRelated = searchParams.get('include_related') !== 'false'
  // Server-side "saknar underlag" filter (dashboard deep link + the list
  // dialog's "Visa saknade underlag" toggle). Committed view only: the
  // predicate is posted-only, so it is meaningless for the drafts view.
  const missingUnderlag = searchParams.get('missing_underlag') === 'true' && status !== 'draft'

  const dateAscending = sortDate === 'asc'
  const sortDateParam = soloDateKey ? (soloDateKey.ascending ? 'asc' : 'desc') : sortDate === 'asc' ? 'asc' : 'desc'

  if (missingUnderlag) {
    // The missing-underlag predicate spans three tables (current-version
    // documents, anchored supplier-invoice references per BFL 5 kap 7 §, and
    // journal_entry_no_doc_required exemptions), which PostgREST cannot
    // express as a row filter. So this path resolves the FULL missing set via
    // the shared helper (the same code the bulk "Inget underlag krävs" route
    // uses, mirroring the verifikat_without_documents RPC that feeds the
    // dashboard badge), sorts it with the active sort stack, pages it, and
    // fetches only the page's rows. count is the full filtered total, so
    // pagination and the dialog badge stay honest.
    //
    // collapse_corrections is deliberately NOT applied here: the dashboard
    // badge has no collapse notion, and hiding corrected originals would make
    // the filtered list disagree with the count that led the user here.
    let missing
    try {
      missing = await resolveMissingUnderlagEntries(supabase, companyId, {
        periodId,
        series: seriesFilter,
        dateFrom,
        dateTo,
        search,
      })
    } catch (err) {
      if (err instanceof MissingUnderlagQueryError) {
        log.error('failed to resolve missing-underlag entries', err)
        return NextResponse.json(
          { error: 'Verifikationerna kunde inte hämtas. Försök igen.' },
          { status: 500 }
        )
      }
      throw err
    }

    // Sort the full set with the same key semantics as the direct query
    // below: the sort stack in priority order, a voucher tiebreak in the last
    // key's direction unless voucher is already a key, and a final id
    // tiebreak for a stable total order across page requests.
    const keys =
      sortKeys.length > 0
        ? sortKeys
        : sortDate === 'asc' || sortDate === 'desc'
          ? [{ column: 'date' as const, ascending: dateAscending }]
          : []
    const compareVoucher = (a: MissingUnderlagEntry, b: MissingUnderlagEntry) => {
      const seriesA = a.voucher_series ?? ''
      const seriesB = b.voucher_series ?? ''
      if (seriesA !== seriesB) return seriesA < seriesB ? -1 : 1
      return (a.voucher_number ?? 0) - (b.voucher_number ?? 0)
    }
    const compareBy = (
      column: 'date' | 'voucher' | 'total' | 'description',
      a: MissingUnderlagEntry,
      b: MissingUnderlagEntry,
    ) => {
      switch (column) {
        case 'date': {
          const dateA = a.entry_date ?? ''
          const dateB = b.entry_date ?? ''
          return dateA < dateB ? -1 : dateA > dateB ? 1 : 0
        }
        case 'voucher':
          return compareVoucher(a, b)
        case 'total':
          return (a.total_amount ?? 0) - (b.total_amount ?? 0)
        case 'description': {
          const descA = a.description ?? ''
          const descB = b.description ?? ''
          return descA < descB ? -1 : descA > descB ? 1 : 0
        }
      }
    }
    const lastAscending = keys.length > 0 ? keys[keys.length - 1].ascending : true
    const sorted = [...missing].sort((a, b) => {
      for (const key of keys) {
        const cmp = compareBy(key.column, a, b)
        if (cmp !== 0) return key.ascending ? cmp : -cmp
      }
      if (!keys.some((k) => k.column === 'voucher')) {
        const cmp = compareVoucher(a, b)
        if (cmp !== 0) return lastAscending ? cmp : -cmp
      }
      const cmp = a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      return lastAscending ? cmp : -cmp
    })

    const total = sorted.length
    const pageIds = sorted.slice(offset, offset + limit).map((e) => e.id)
    if (pageIds.length === 0) {
      return NextResponse.json({ data: [], count: total })
    }

    // Fetch the page's full rows in id chunks: "Alla" as page size can put
    // thousands of ids on this page, and a single .in() with that many ids
    // would blow PostgREST's URL length limit.
    const ROW_CHUNK = 100
    const rowsById = new Map<string, unknown>()
    for (let i = 0; i < pageIds.length; i += ROW_CHUNK) {
      const chunk = pageIds.slice(i, i + ROW_CHUNK)
      const { data: chunkRows, error } = await supabase
        .from('journal_entries')
        .select('*, lines:journal_entry_lines(*)')
        .eq('company_id', companyId)
        .in('id', chunk)
      if (error) {
        log.error('failed to fetch missing-underlag page rows', error)
        return NextResponse.json(
          { error: 'Verifikationerna kunde inte hämtas. Försök igen.' },
          { status: 500 }
        )
      }
      for (const row of (chunkRows ?? []) as { id: string }[]) {
        rowsById.set(row.id, row)
      }
    }
    // Reassemble in the sorted page order (the .in() fetch has no order).
    const data = pageIds.map((id) => rowsById.get(id)).filter(Boolean)

    return NextResponse.json({ data, count: total })
  }

  // Non-date sorts (and stacked sorts): the include_related RPC only orders
  // by date, so fall through to the direct query below. This means these
  // sorts are *strict by fiscal_period_id*: cross-period follow-up entries
  // that the RPC normally surfaces under date sort are excluded.
  // That's intentional: voucher numbers are series-scoped within a fiscal
  // year (BFL 5 kap 6-7 §§), so showing series A1, A2 … alongside entries
  // belonging to a different year's series would be misleading. The trade-off
  // is that the visible row count may differ between sort modes for the same
  // period; the strict count is the BFL-compliant view of that year.
  if (periodId && includeRelated && (sortKeys.length === 0 || soloDateKey) && !search) {
    const { data, error } = await supabase.rpc('list_fiscal_period_entries_with_related', {
      p_company_id: companyId,
      p_period_id: periodId,
      p_include_related: true,
      p_status: status,
      p_date_from: dateFrom,
      p_date_to: dateTo,
      p_sort_date: sortDateParam,
      p_limit: limit,
      p_offset: offset,
      p_exclude_draft: excludeDraft,
      p_collapse_corrections: collapseCorrections,
      // Series filter lives in the RPC now (#798): filtering here after the RPC
      // paged would recompute count from one page only, breaking pagination.
      p_series: seriesFilter,
    })

    if (error) {
      log.error('failed to list fiscal period entries via RPC', error)
      return NextResponse.json(
        { error: 'Verifikationerna kunde inte hämtas. Försök igen.' },
        { status: 500 }
      )
    }

    const rows = data ?? []
    const entries = rows.map((r: { entry: unknown }) => r.entry)
    const count = rows.length > 0 ? Number((rows[0] as { total_count: number | string }).total_count) : 0

    return NextResponse.json({ data: entries, count })
  }

  let query = supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)', { count: 'exact' })
    .eq('company_id', companyId)

  if (sortKeys.length > 0) {
    // Apply the priority list in order. total_amount is a computed column (a
    // function on the row type), which PostgREST accepts in order=.
    for (const key of sortKeys) {
      switch (key.column) {
        case 'voucher':
          query = query
            .order('voucher_series', { ascending: key.ascending })
            .order('voucher_number', { ascending: key.ascending })
          break
        case 'date':
          query = query.order('entry_date', { ascending: key.ascending })
          break
        case 'total':
          query = query.order('total_amount', { ascending: key.ascending })
          break
        case 'description':
          query = query.order('description', { ascending: key.ascending })
          break
      }
    }
    // Stable pagination needs a total order: unless voucher is already a key,
    // tiebreak by series+number in the LAST key's direction, so a plain date
    // sort keeps same-date vouchers running the same way as the RPC (#972).
    if (!sortKeys.some((k) => k.column === 'voucher')) {
      const tiebreakAscending = sortKeys[sortKeys.length - 1].ascending
      query = query
        .order('voucher_series', { ascending: tiebreakAscending })
        .order('voucher_number', { ascending: tiebreakAscending })
    }
    // Final id tiebreak: series+number repeat across fiscal years, so on an
    // all-years scope equal sort keys could reshuffle between page requests
    // and duplicate or drop rows at page boundaries.
    query = query.order('id', { ascending: sortKeys[sortKeys.length - 1].ascending })
  } else if (sortDate === 'asc' || sortDate === 'desc') {
    // Legacy sort_date param (older clients). Tiebreak same-date vouchers in
    // the SAME direction as the date sort (#972).
    query = query
      .order('entry_date', { ascending: dateAscending })
      .order('voucher_series', { ascending: dateAscending })
      .order('voucher_number', { ascending: dateAscending })
      .order('id', { ascending: dateAscending })
  } else {
    query = query
      .order('voucher_series', { ascending: true })
      .order('voucher_number', { ascending: true })
      .order('id', { ascending: true })
  }

  query = query.range(offset, offset + limit - 1)

  if (periodId) {
    query = query.eq('fiscal_period_id', periodId)
  }

  if (status) {
    query = query.eq('status', status)
  } else {
    query = query.neq('status', 'cancelled')
    if (excludeDraft) {
      query = query.neq('status', 'draft')
    }
  }

  if (dateFrom) {
    query = query.gte('entry_date', dateFrom)
  }

  if (dateTo) {
    query = query.lte('entry_date', dateTo)
  }

  if (seriesFilter) {
    query = query.eq('voucher_series', seriesFilter)
  }

  if (search) {
    // Escape LIKE wildcards (\ % _) so they match literally, and cap the needle
    // length (≤200 chars): both handled by the shared escapeLikePattern helper.
    // The cap bounds DB work against oversized/pathological inputs (compliance
    // A.8.28 / ASVS V1.2.5); escaping prevents silent over-matching on values
    // like "50%". Supabase parameterises the value, so this is not about SQLi.
    const needle = `%${escapeLikePattern(search)}%`
    // The first thing a user searches for is the voucher's own label ("A209").
    // A description-only match never finds it (only OTHER vouchers that
    // mention A209 in their text), so a label-shaped needle also matches
    // voucher_series + voucher_number. The OR is a PostgREST filter list, so
    // the needle is double-quoted to keep commas/parentheses literal.
    const voucher = parseVoucher(search)
    if (voucher) {
      const quotedNeedle = `"${needle.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      query = query.or(
        `description.ilike.${quotedNeedle},and(voucher_series.eq.${voucher.series},voucher_number.eq.${voucher.number})`,
      )
    } else {
      query = query.ilike('description', needle)
    }
  }

  // Collapse correction groups (voucher-sort / search path): hide the storno
  // and the reversed originals a posted correction replaced, leaving the live
  // correction. Pagination/count stay correct because these are query filters.
  if (collapseCorrections) {
    query = query.neq('source_type', 'storno')
    const { data: corrections } = await supabase
      .from('journal_entries')
      .select('correction_of_id')
      .eq('company_id', companyId)
      .eq('source_type', 'correction')
      .eq('status', 'posted')
      .not('correction_of_id', 'is', null)
    const correctedOriginalIds = Array.from(
      new Set((corrections ?? []).map((r) => r.correction_of_id).filter(Boolean) as string[])
    )
    if (correctedOriginalIds.length > 0) {
      query = query.not('id', 'in', `(${correctedOriginalIds.join(',')})`)
    }
  }

  const { data, error, count } = await query

  if (error) {
    log.error('failed to list journal entries', error)
    return NextResponse.json(
      { error: 'Verifikationerna kunde inte hämtas. Försök igen.' },
      { status: 500 }
    )
  }

  return NextResponse.json({ data, count })
})

export const POST = withRouteContext(
  'bookkeeping.journal_entries.create',
  async (request, ctx) => {
  const { supabase, companyId, user, log } = ctx

  const validation = await validateBody(request, CreateJournalEntrySchema)
  if (!validation.success) return validation.response
  const body = validation.data

  const { searchParams } = new URL(request.url)
  const asDraft = searchParams.get('as_draft') === 'true'

  try {
    const entry = asDraft
      ? await createDraftEntry(supabase, companyId, user.id, body)
      : await createJournalEntry(supabase, companyId, user.id, body)
    return NextResponse.json({ data: entry })
  } catch (err) {
    const typed = bookkeepingErrorResponse(err)
    if (typed) return typed
    // Untyped errors map to Swedish via getErrorMessage: the raw message is
    // logged here and must never reach the user verbatim (issue #337).
    log.error('failed to create journal entry', err as Error)
    return NextResponse.json(
      { error: getErrorMessage(err, { context: 'journal_entry' }) },
      { status: 400 }
    )
  }
  },
  { requireWrite: true },
)
