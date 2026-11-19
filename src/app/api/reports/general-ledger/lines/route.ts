import { NextResponse } from 'next/server'
import {
  generateGeneralLedgerAccountPage,
  generateGeneralLedgerArrangedPage,
  type GeneralLedgerCursor,
} from '@/lib/reports/general-ledger'
import { parseLedgerRowSort, type LedgerRowSort } from '@/lib/reports/general-ledger-rows'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { parseDimensionFilterParams } from '@/lib/reports/dimension-filter'
import { parseReportDateRange, type DateRange } from '@/lib/reports/date-range'
import { isAccountNumber, isIsoDateShaped } from '@/lib/invariants'
import { isUuid } from '@/lib/invariants/uuid'

/** A search is a few words or a number: a longer one is refused, which bounds the work per line. */
const MAX_SEARCH_LENGTH = 200

/**
 * One account's huvudbok lines, a page at a time, with running balances
 * that continue from the account's opening balance. Without a cursor the
 * page starts at the window's first line; `after_date`, `after_voucher` and
 * `after_line` (the last line shown, as `next` returned it) continue it.
 *
 * `sort` (date, voucher, debit or credit, with _asc or _desc) and `search`
 * (text, a voucher label, an amount or a date) arrange the account's lines
 * instead: the answer is then a page of that arrangement, with `line_count`,
 * `next_offset` (continue with `offset`) and, under a search, the debit and
 * credit of everything it found. Every line keeps the balance it has in
 * ledger order. A request with none of the three is the ledger page above.
 */
export const GET = withRouteContext(
  'report.general_ledger.lines',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const periodId = searchParams.get('period_id')
    const account = searchParams.get('account')

    if (!periodId) {
      return errorResponseFromCode('REPORT_PERIOD_REQUIRED', log, { requestId })
    }
    if (!isAccountNumber(account)) {
      return NextResponse.json({ error: 'account must be a four-digit account number' }, { status: 400 })
    }

    const afterDate = searchParams.get('after_date')
    const afterVoucher = searchParams.get('after_voucher')
    const afterLine = searchParams.get('after_line')
    let after: GeneralLedgerCursor | undefined
    if (afterDate || afterVoucher || afterLine) {
      if (!isIsoDateShaped(afterDate) || !afterVoucher || !/^\d+$/.test(afterVoucher) || !isUuid(afterLine)) {
        return NextResponse.json({ error: 'after_date, after_voucher and after_line go together' }, { status: 400 })
      }
      after = { date: afterDate as string, voucher_number: Number(afterVoucher), line_id: afterLine as string }
    }

    const sortParam = searchParams.get('sort') || null
    const search = searchParams.get('search')?.trim() || null
    const offsetParam = searchParams.get('offset') || null
    const arranged = sortParam !== null || search !== null || offsetParam !== null
    let sort: LedgerRowSort | null = null
    if (arranged) {
      sort = parseLedgerRowSort(sortParam)
      if (sortParam !== null && !sort) {
        return NextResponse.json(
          { error: 'sort must be date, voucher, debit or credit followed by _asc or _desc' },
          { status: 400 },
        )
      }
      if (search !== null && search.length > MAX_SEARCH_LENGTH) {
        return NextResponse.json({ error: `search must be at most ${MAX_SEARCH_LENGTH} characters` }, { status: 400 })
      }
      if (offsetParam !== null && !/^\d{1,7}$/.test(offsetParam)) {
        return NextResponse.json({ error: 'offset must be a non-negative integer' }, { status: 400 })
      }
      if (after) {
        return NextResponse.json(
          { error: 'after_date, after_voucher and after_line continue the ledger order; continue a sort or a search with offset' },
          { status: 400 },
        )
      }
    }

    const dimFilter = parseDimensionFilterParams(searchParams)
    if (!dimFilter.ok) {
      return NextResponse.json({ error: dimFilter.error }, { status: 400 })
    }

    // Validate the optional date sub-range against the fiscal period bounds.
    const { data: period } = await supabase
      .from('fiscal_periods')
      .select('period_start, period_end')
      .eq('id', periodId)
      .eq('company_id', companyId!)
      .single()

    if (!period) {
      return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
    }
    const parsed = parseReportDateRange(searchParams, period)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }
    const range: DateRange = parsed.range

    try {
      const data = arranged
        ? await generateGeneralLedgerArrangedPage(supabase, companyId!, periodId, account!, {
            dimensions: dimFilter.dimensions,
            fromDate: range.fromDate,
            toDate: range.toDate,
            sort,
            search,
            offset: offsetParam === null ? 0 : Number(offsetParam),
          })
        : await generateGeneralLedgerAccountPage(supabase, companyId!, periodId, account!, {
            dimensions: dimFilter.dimensions,
            fromDate: range.fromDate,
            toDate: range.toDate,
            after,
          })
      return NextResponse.json({ data })
    } catch (err) {
      log.error('general ledger account page failed', err as Error, { periodId })
      return errorResponseFromCode('REPORT_GENERATION_FAILED', log, { requestId })
    }
  },
)
