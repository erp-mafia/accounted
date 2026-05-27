import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { createDraftEntry, createJournalEntry } from '@/lib/bookkeeping/engine'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { CreateJournalEntrySchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

ensureInitialized()

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')
  const status = searchParams.get('status')
  const limit = parseInt(searchParams.get('limit') || '50')
  const offset = parseInt(searchParams.get('offset') || '0')
  const dateFrom = searchParams.get('date_from')
  const dateTo = searchParams.get('date_to')
  const sortDate = searchParams.get('sort_date') // 'asc' | 'desc'
  // 'series' optional filter — single uppercase letter A–Z. Ignored if any
  // other value is passed (defense against trivial injection / typos).
  const seriesRaw = searchParams.get('series')
  const seriesFilter = seriesRaw && /^[A-Z]$/.test(seriesRaw) ? seriesRaw : null
  // 'date_desc' (default) | 'date_asc' | 'voucher_asc' | 'voucher_desc'
  // sort_by overrides sort_date when present. sort_date is kept for backwards
  // compatibility with older clients.
  const sortBy = searchParams.get('sort_by')
  const isVoucherSort = sortBy === 'voucher_asc' || sortBy === 'voucher_desc'
  // Default on: when a fiscal period is selected, include follow-up entries
  // booked in later periods whose source aggregate (invoice, supplier invoice)
  // is dated inside the selected period. Pass include_related=false to
  // restore strict fiscal_period_id filtering.
  const includeRelated = searchParams.get('include_related') !== 'false'

  const dateAscending = sortDate === 'asc' || sortBy === 'date_asc'
  const sortDateParam = sortBy === 'date_asc' || sortDate === 'asc' ? 'asc' : 'desc'

  // Voucher-sort path: include_related RPC doesn't support voucher ordering,
  // so fall through to the direct query below. This means voucher sort is
  // *strict by fiscal_period_id* — cross-period follow-up entries that the
  // RPC normally surfaces under date sort are excluded under voucher sort.
  // That's intentional: voucher numbers are series-scoped within a fiscal
  // year (BFL 5 kap 6–7 §§), so showing series A1, A2 … alongside entries
  // belonging to a different year's series would be misleading. The trade-off
  // is that the visible row count may differ between sort modes for the same
  // period; the strict count is the BFL-compliant view of that year.
  if (periodId && includeRelated && !isVoucherSort) {
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
    })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const rows = data ?? []
    let entries = rows.map((r: { entry: unknown }) => r.entry) as Array<{ voucher_series?: string }>
    let count = rows.length > 0 ? Number((rows[0] as { total_count: number | string }).total_count) : 0

    // The list_fiscal_period_entries_with_related RPC doesn't accept a series
    // filter, so post-filter here. Recompute count from the filtered set so
    // the paginator stays consistent; consequence: when a series filter is
    // applied, the cross-period follow-up surfacing is still on but the
    // visible total drops to the matching subset.
    if (seriesFilter) {
      entries = entries.filter((e) => (e?.voucher_series ?? 'A') === seriesFilter)
      count = entries.length
    }

    return NextResponse.json({ data: entries, count })
  }

  let query = supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)', { count: 'exact' })
    .eq('company_id', companyId)

  if (isVoucherSort) {
    const voucherAscending = sortBy === 'voucher_asc'
    query = query
      .order('voucher_series', { ascending: voucherAscending })
      .order('voucher_number', { ascending: voucherAscending })
  } else if (sortDate === 'asc' || sortDate === 'desc' || sortBy === 'date_asc' || sortBy === 'date_desc') {
    query = query
      .order('entry_date', { ascending: dateAscending })
      .order('voucher_number', { ascending: dateAscending })
  } else {
    query = query
      .order('voucher_series', { ascending: true })
      .order('voucher_number', { ascending: true })
  }

  query = query.range(offset, offset + limit - 1)

  if (periodId) {
    query = query.eq('fiscal_period_id', periodId)
  }

  if (status) {
    query = query.eq('status', status)
  } else {
    query = query.neq('status', 'cancelled')
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

  const { data, error, count } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data, count })
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

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
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create journal entry' },
      { status: 400 }
    )
  }
}
