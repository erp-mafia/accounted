import { NextResponse } from 'next/server'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { manualVoucherBusinessEvent } from '@/lib/bookkeeping/ledger-business-events'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingPort } from '@/lib/posting/port'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateDashboardJournalEntrySchema } from '@/lib/api/schemas'
import { applyVerifikatSearch, readVerifikatQuerySearch, verifikatSearchJoins } from '@/lib/bookkeeping/verifikat-search'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { dbError } from '@/lib/errors/db-error'
import { recordVoucherWarningsAcknowledged, runVoucherWarningsGuard } from '@/lib/bookkeeping/voucher-warnings-guard'
import { linkOpenBankRowsToVoucher } from '@/lib/reconciliation/voucher-bank-link'
import {
  MissingUnderlagQueryError,
  listMissingUnderlagPage,
  missingUnderlagOrder,
  type MissingUnderlagPage,
} from '@/lib/bookkeeping/missing-underlag'
import { MAX_ROWS_PER_REQUEST } from '@/lib/lists/collect-pages'
import { countUnderlagForJournalEntries } from '@/lib/core/documents/underlag-counts'
import { gateReviewedVatSettlement, reviewedVatSettlementRaceLost } from '@/lib/reports/vat-settlement-booking'

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
  // Collapse a correction group to the live correction: fold the reversed
  // original and its storno once a posted correction replaced them. A storno
  // with no correction stays visible (#3149). The full chain stays reachable.
  const collapseCorrections = searchParams.get('collapse_corrections') === 'true'
  // Hide every makulerad pair, not only corrected groups: each reversed
  // original (Omförd) and each storno, with or without a correction (PH 231).
  // Opt-in from the list's filter dialog; the default stays gapless (#3149).
  // The correction itself is posted and stays. Subsumes collapse_corrections.
  const hideReversed = searchParams.get('hide_reversed') === 'true'
  // Clamp pagination to bound DB work against oversized/pathological inputs
  // (compliance A.8.28 / ASVS V1.2.5). The ceiling is what one PostgREST
  // response can carry: a larger limit came back cut at 1,000 rows under a
  // count that claimed more, so "Alla" showed 1,000 of 3,000 verifikat as all.
  // The list UI collects "Alla" in chunks of this size (lib/lists/collect-pages).
  const MAX_LIMIT = MAX_ROWS_PER_REQUEST
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
  // order by the display_amount computed column (migration 20261018135300):
  // the amount the Belopp column shows (the single money line, else the
  // omslutning; voucherDisplayAmount), so the sort follows the number on
  // screen (crm#1280). PostgREST evaluates it per row, which the RPC path
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
  // The verifikat list asks for its rows' underlag counts with the rows
  // (include_counts=true) instead of a second request to
  // /api/documents/counts per page. Best effort: when the count reads fail
  // the counts are left out and the list asks the counts route as before.
  const includeCounts = searchParams.get('include_counts') === 'true'
  const listResponse = async (data: unknown[] | null, count: number | null) => {
    if (!includeCounts || !data || data.length === 0) return NextResponse.json({ data, count })
    try {
      const ids = (data as { id: string }[]).map((entry) => entry.id)
      const { counts, invoice_references } = await countUnderlagForJournalEntries(supabase, companyId, ids)
      return NextResponse.json({ data, count, attachment_counts: counts, invoice_references })
    } catch (err) {
      log.warn('underlag counts for the verifikat list failed', err)
      return NextResponse.json({ data, count })
    }
  }

  const dateAscending = sortDate === 'asc'
  const sortDateParam = soloDateKey ? (soloDateKey.ascending ? 'asc' : 'desc') : sortDate === 'asc' ? 'asc' : 'desc'

  if (missingUnderlag) {
    // The missing-underlag predicate spans documents, anchored supplier-invoice
    // references and issued customer invoices (BFL 5 kap 7 § hänvisning), and
    // journal_entry_no_doc_required exemptions, which PostgREST cannot express
    // as a row filter. The list_verifikat_missing_underlag RPC (the
    // verifikat_without_documents predicate that feeds the dashboard badge,
    // narrowed by this list's filters) resolves, sorts and pages the set in
    // one statement and returns the page's ids with the full filtered total,
    // so pagination and the dialog badge stay honest; this path then fetches
    // only the page's rows. The same helper backs the bulk "Inget underlag
    // krävs" route. Resolving the set here instead cost hundreds of
    // sequential round trips on a long ledger (crm#1390).
    //
    // collapse_corrections is deliberately NOT applied here: the dashboard
    // badge has no collapse notion, and hiding corrected originals would make
    // the filtered list disagree with the count that led the user here.
    let page: MissingUnderlagPage
    try {
      page = await listMissingUnderlagPage(
        supabase,
        companyId,
        { periodId, series: seriesFilter, dateFrom, dateTo, search },
        { order: missingUnderlagOrder(sortKeys, sortDate), limit, offset },
      )
    } catch (err) {
      if (err instanceof MissingUnderlagQueryError) {
        // err.message is the user-facing Swedish text; the driver error is
        // what an operator needs (a gateway 414 hid behind it in #2395).
        log.error('failed to resolve missing-underlag entries', err, { cause: err.cause })
        return NextResponse.json(
          { error: 'Verifikationerna kunde inte hämtas. Försök igen.' },
          { status: 500 }
        )
      }
      throw err
    }

    const { total, ids: pageIds } = page
    if (pageIds.length === 0) {
      return NextResponse.json({ data: [], count: total })
    }

    // Fetch the page's full rows in id chunks: an "Alla" chunk puts up to
    // MAX_LIMIT ids on this page, and a single .in() with that many ids
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
      if (error) return errorResponse(dbError(error, 'Missing-underlag page rows'), log, { requestId: ctx.requestId })
      for (const row of (chunkRows ?? []) as { id: string }[]) {
        rowsById.set(row.id, row)
      }
    }
    // Reassemble in the sorted page order (the .in() fetch has no order).
    const data = pageIds.map((id) => rowsById.get(id)).filter(Boolean)

    return listResponse(data, total)
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
  // hide_reversed takes the direct path too: the RPC has no such filter, and,
  // as with search, the hidden-pairs view stays strict to the selected year.
  if (periodId && includeRelated && (sortKeys.length === 0 || soloDateKey) && !search && !hideReversed) {
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

    if (error) return errorResponse(dbError(error, 'Fiscal period entries'), log, { requestId: ctx.requestId })

    const rows = data ?? []
    const entries = rows.map((r: { entry: unknown }) => r.entry)
    const count = rows.length > 0 ? Number((rows[0] as { total_count: number | string }).total_count) : 0

    return listResponse(entries, count)
  }

  // What the needle is besides text (lib/bookkeeping/verifikat-search.ts): a
  // voucher label, an account number (crm#1847), an amount or a
  // bokföringsdatum. The account and the amount look at the lines, through a
  // filtered join of their own next to `lines` (verifikatSearchJoins), which
  // applyVerifikatSearch below asks whether it found anything. The amount is
  // read only when a fiscal period bounds the request
  // (isBoundedVerifikatScope): with none, a number typed is searched as it
  // was before amounts were read.
  const needle = search ? readVerifikatQuerySearch(search, { periodId }) : null

  let query = supabase
    .from('journal_entries')
    .select(`*, lines:journal_entry_lines(*)${needle ? verifikatSearchJoins(needle) : ''}`, { count: 'exact' })
    .eq('company_id', companyId)

  if (sortKeys.length > 0) {
    // Apply the priority list in order. display_amount is a computed column
    // (a function on the row type), which PostgREST accepts in order=.
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
          query = query.order('display_amount', { ascending: key.ascending })
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

  if (search && needle) {
    query = applyVerifikatSearch(query, search, needle)
  }

  // Collapse correction groups (voucher-sort / search path): fold the reversed
  // originals a posted correction replaced, and their stornos, leaving the live
  // correction. A storno with no correction stays visible: it is the only row
  // that carries its voucher number, so hiding it showed a hole in the series
  // (#3149). Same rule as the RPC's p_collapse_corrections. Pagination/count
  // stay correct because these are query filters.
  if (hideReversed) {
    // Both halves of every makulerad pair, by their own columns: no prefetch,
    // and count/pagination stay exact. The correction (posted) stays.
    query = query.neq('status', 'reversed').neq('source_type', 'storno')
  } else if (collapseCorrections) {
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
      const idList = `(${correctedOriginalIds.join(',')})`
      query = query.not('id', 'in', idList)
      // PostgREST or=(...): a row survives unless it is a storno of a corrected
      // original. `is.null` keeps an unlinked storno visible, since
      // NULL NOT IN (...) is NULL and would otherwise drop it.
      query = query.or(`source_type.neq.storno,reverses_id.is.null,reverses_id.not.in.${idList}`)
    }
  }

  const { data, error, count } = await query

  // A statement timeout answers 503 TRANSIENT_ERROR (retryable) and any
  // other database failure 500, each with its code and the database's own
  // message in the log line.
  if (error) return errorResponse(dbError(error, 'Journal entries'), log, { requestId: ctx.requestId })

  return listResponse(data, count)
})

export const POST = withRouteContext(
  'bookkeeping.journal_entries.create',
  async (request, ctx) => {
  const { supabase, companyId, user, log } = ctx

  // source_type is limited to what the dashboard's own forms author: a
  // caller-chosen label must not claim an engine-owned exemption
  // (CreateDashboardJournalEntrySchema).
  const validation = await validateBody(request, CreateDashboardJournalEntrySchema)
  if (!validation.success) return validation.response
  const {
    acknowledged_warnings: acknowledgedWarnings,
    vat_settlement_period: vatSettlementPeriod,
    ...validBody
  } = validation.data
  let body = validBody

  const { searchParams } = new URL(request.url)
  const asDraft = searchParams.get('as_draft') === 'true'

  // A reviewed momsredovisning (the Moms page sends its period) passes the
  // same gates as the v1 and MCP booking: a period already settled refuses,
  // and the verifikat is keyed on the period, so a second settlement racing
  // this one from any door fails at the draft insert (accounted#58). A VAT
  // template applied in the plain form names no period and books as before.
  const settlementCtx = { supabase, companyId, userId: user.id, log }
  let settlementSourceId: string | null = null
  if (body.source_type === 'vat_settlement' && vatSettlementPeriod) {
    const gate = await gateReviewedVatSettlement(settlementCtx, vatSettlementPeriod)
    if (!gate.ok) {
      return errorResponseFromCode(gate.code, log, { details: gate.details, requestId: ctx.requestId })
    }
    settlementSourceId = gate.sourceId
    body = { ...body, source_id: gate.sourceId }
  }

  // Booking-time warnings on typed lines: a draft is checked when it is
  // committed, a posting now (lib/bookkeeping/voucher-warnings-guard.ts).
  const guard = asDraft
    ? null
    : await runVoucherWarningsGuard(supabase, companyId, body, log, { acknowledged: acknowledgedWarnings })
  if (guard && !guard.ok) {
    return errorResponseFromCode(guard.code, log, { details: guard.details, requestId: ctx.requestId })
  }

  // Posting port (step 2i): the engine gets the body unchanged and, while
  // POSTING_EVENTS is shadow or strict, the voucher's event (the kind its
  // source type names, the person's own: user_created) is linked to the
  // draft before a number is drawn. A draft records its event now, linked to
  // the draft; its later commit records nothing (as kassa and webbshop).
  const event = () =>
    manualVoucherBusinessEvent({ sourceType: body.source_type, entryDate: body.entry_date, linkBasis: linkBasisColumns('user_created') })

  try {
    const entry = asDraft
      ? await postingPort.draftJournalEntry({ supabase, companyId, userId: user.id, event, input: body })
      : await postingPort.postJournalEntry({ supabase, companyId, userId: user.id, event, input: body })
    if (guard?.ok && guard.acknowledged.length > 0) {
      await recordVoucherWarningsAcknowledged({
        companyId,
        userId: user.id,
        journalEntryId: entry.id,
        warnings: guard.acknowledged,
        door: 'dashboard_voucher',
        log,
      })
    }
    // A posted typed verifikat meets the open bank row it books
    // (lib/reconciliation/voucher-bank-link.ts); a draft does when it is committed.
    if (!asDraft) {
      await linkOpenBankRowsToVoucher(
        supabase,
        companyId,
        user.id,
        { journalEntryId: entry.id, entryDate: body.entry_date, lines: body.lines },
        log,
      )
    }
    return NextResponse.json({ data: entry })
  } catch (err) {
    if (settlementSourceId) {
      const raceLost = await reviewedVatSettlementRaceLost(settlementCtx, err, settlementSourceId)
      if (raceLost) {
        return errorResponseFromCode(raceLost.code, log, { details: raceLost.details, requestId: ctx.requestId })
      }
    }
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
