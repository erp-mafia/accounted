import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { isArkivBrainEnabled, isArkivEnabled } from '@/lib/arkiv/flag'
import { documentDate, documentTitle, underlagPayload } from '@/lib/arkiv/documents/title'
import type { Payload } from '@/lib/documents/extract/fields'
import { searchDocumentPages, type PageHit } from '@/lib/documents/read/search'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { NOT_STRUCTURED_MIME_FILTER } from '@/lib/documents/read/types'
import { folderQuery, isFolderKey } from '@/lib/arkiv/folders'

/**
 * GET /api/arkiv/documents?q=&year=
 * GET /api/arkiv/documents?folder=&year=&offset=&limit=
 * The Arkiv table: every admitted document with its type, counterparty,
 * amount and what it is tied to. `type` is a doc_type or one of the groups
 * (agreement, authority); `q` searches page text and file names. `folder`
 * pages one folder of the Dokument tree over the whole archive, newest
 * document date first (arkiv_document_page), with `next_offset` for the next page.
 */
export interface ArkivDocumentRow {
  document_id: string
  created_at: string
  file_name: string
  /** What the document is called: read off its record, the file name when nothing was read. */
  title: string
  /** The date the document carries; the upload date stands in when it has none. */
  document_date: string | null
  doc_type: string | null
  page_count: number | null
  counterparty: string | null
  amount: number | null
  currency: string | null
  /** An agreement's amount recurs: monthly, quarterly, yearly; null for a one-off or a non-agreement. */
  period: string | null
  linked: { journal_entry_id: string | null; voucher: string | null; agreement_id: string | null; expected: number; held: boolean; unclassified: boolean; reading: boolean }
  href: string
}

/** Who the document is from when it names no counterparty: the authority that issued it. */
const ISSUER: Record<string, string> = {
  'registration.bolagsverket': 'Bolagsverket',
  'filing.bolagsverket': 'Bolagsverket',
  'decision.skatteverket': 'Skatteverket',
  tax_account_statement: 'Skatteverket',
}

const querySchema = z.object({
  q: z.string().trim().max(200).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  folder: z.string().max(32).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
})

/** A folder page is small: the tree shows the first rows and fetches more on request. */
const FOLDER_PAGE_MAX = 200

export const GET = withRouteContext('arkiv.documents', async (request, ctx) => {
  if (!isArkivEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const parsed = validateQuery(request, querySchema)
  if (!parsed.success) return parsed.response
  const { q, year, limit, folder, offset } = parsed.data
  if (folder && !isFolderKey(folder)) return NextResponse.json({ error: 'Okänd mapp.' }, { status: 400 })

  // One folder, one page: the database orders and pages over the whole archive, and the rows keep that order.
  let pageOrder: string[] | null = null
  let nextOffset: number | null = null
  if (folder && isFolderKey(folder)) {
    const pageSize = Math.min(limit, FOLDER_PAGE_MAX)
    const { mode, types: folderTypes } = folderQuery(folder)
    const { data: page, error: pageError } = await ctx.supabase.rpc('arkiv_document_page', {
      p_company_id: ctx.companyId,
      p_mode: mode,
      p_types: folderTypes,
      p_year: year ?? null,
      p_offset: offset,
      // One more than asked says whether there is a next page without a count.
      p_limit: pageSize + 1,
    })
    if (pageError) return NextResponse.json({ error: getErrorMessage(pageError) }, { status: 500 })
    const ids = ((page ?? []) as Array<{ id: string }>).map((r) => r.id)
    nextOffset = ids.length > pageSize ? offset + pageSize : null
    pageOrder = ids.slice(0, pageSize)
    if (pageOrder.length === 0) return NextResponse.json({ data: [], next_offset: null })
  }

  let searchIds: string[] | null = null
  if (q && q.length >= 2) {
    let pages: PageHit[]
    try {
      pages = await searchDocumentPages(ctx.supabase, ctx.companyId, q, limit)
    } catch (err) {
      return NextResponse.json({ error: getErrorMessage(err) }, { status: 500 })
    }
    const names = await ctx.supabase
      .from('document_attachments')
      .select('id')
      .eq('company_id', ctx.companyId)
      .ilike('file_name', `%${q.replace(/[%_]/g, ' ')}%`)
      .limit(limit)
    if (names.error) return NextResponse.json({ error: getErrorMessage(names.error) }, { status: 500 })
    searchIds = [...new Set([...pages.map((p) => p.document_id), ...((names.data ?? []) as Array<{ id: string }>).map((d) => d.id)])]
    if (searchIds.length === 0) return NextResponse.json({ data: [] })
  }

  let query = ctx.supabase
    .from('document_attachments')
    .select('id, created_at, file_name, doc_type, admission_state, journal_entry_id, journal_entry_line_id, extracted_data, page_count')
    .eq('company_id', ctx.companyId)
    .in('admission_state', ['admitted', 'held'])
    .or(NOT_STRUCTURED_MIME_FILTER)
    .order('created_at', { ascending: false })
    .limit(pageOrder ? pageOrder.length : limit)
  if (searchIds) query = query.in('id', searchIds)
  if (pageOrder) query = query.in('id', pageOrder)
  const { data, error } = await query
  if (error) return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  const docs = (data ?? []) as Array<{ id: string; created_at: string; file_name: string; doc_type: string | null; admission_state: string; journal_entry_id: string | null; journal_entry_line_id?: string | null; extracted_data: Record<string, unknown> | null; page_count: number | null }>
  if (docs.length === 0) return NextResponse.json(pageOrder ? { data: [], next_offset: nextOffset } : { data: [] })
  const ids = docs.map((d) => d.id)

  const entryIds = docs.map((d) => d.journal_entry_id).filter((id): id is string => !!id)
  // Extractions and agreements are the brain's records: outside it the row is the document, its type and its verifikat.
  const brain = isArkivBrainEnabled(ctx.companyId)
  const none = Promise.resolve({ data: [], error: null })
  const [extractions, agreements, entries] = await Promise.all([
    brain ? ctx.supabase.from('document_extractions').select('document_id, payload').in('document_id', ids).eq('is_current', true) : none,
    brain ? ctx.supabase.from('agreements').select('id, source_document_id, title, counterparty_name, amount, currency, period').in('source_document_id', ids) : none,
    entryIds.length ? ctx.supabase.from('journal_entries').select('id, voucher_series, voucher_number').in('id', entryIds) : none,
  ])
  for (const r of [extractions, agreements, entries]) if (r.error) return NextResponse.json({ error: getErrorMessage(r.error) }, { status: 500 })
  const payloadByDoc = new Map(((extractions.data ?? []) as Array<{ document_id: string; payload: Payload }>).map((e) => [e.document_id, e.payload]))
  const agreementRows = (agreements.data ?? []) as Array<{
    id: string
    source_document_id: string
    title: string
    counterparty_name: string | null
    amount: string | null
    currency: string
    period: string | null
  }>
  const agreementByDoc = new Map(agreementRows.map((a) => [a.source_document_id, a]))
  const voucherOf = new Map(
    ((entries.data ?? []) as Array<{ id: string; voucher_series: string | null; voucher_number: number | null }>).map((e) => [
      e.id,
      `${e.voucher_series ?? ''}${e.voucher_number ?? ''}`,
    ]),
  )
  const expectedCount = new Map<string, number>()
  if (agreementRows.length) {
    const { data: expected, error: expectedError } = await ctx.supabase
      .from('agreement_obligations')
      .select('agreement_id')
      .in(
        'agreement_id',
        agreementRows.map((a) => a.id),
      )
      .eq('status', 'expected')
    if (expectedError) return NextResponse.json({ error: getErrorMessage(expectedError) }, { status: 500 })
    for (const o of (expected ?? []) as Array<{ agreement_id: string }>) expectedCount.set(o.agreement_id, (expectedCount.get(o.agreement_id) ?? 0) + 1)
  }

  const rows: ArkivDocumentRow[] = docs.map((d) => {
    // The brain's reading when there is one; the inbox's Underlag reading otherwise.
    const payload = payloadByDoc.get(d.id) ?? underlagPayload(d.extracted_data, d.doc_type)
    const agreement = agreementByDoc.get(d.id)
    const settled = (...names: string[]) => names.map((n) => payload[n]?.normalized).find((v) => v != null) ?? null
    const counterparty =
      agreement?.counterparty_name ??
      (d.doc_type ? (ISSUER[d.doc_type] ?? null) : null) ??
      (settled(
        'counterparty_name',
        'landlord_name',
        'lessor_name',
        'lender_name',
        'provider_name',
        'insurer_name',
        'investor_name',
        'customer_name',
        'supplier_name',
        'merchant_name',
        'issuer_name',
        'employee_name',
        'company_name',
      ) as string | null)
    const amount =
      agreement?.amount != null
        ? Number(agreement.amount)
        : (settled(
            'total_amount',
            'monthly_rent',
            'monthly_fee',
            'principal',
            'fee_amount',
            'premium_amount',
            'investment_amount',
            'monthly_salary',
            'net_result',
            'closing_balance',
            'amount',
          ) as number | null)
    return {
      document_id: d.id,
      created_at: d.created_at,
      file_name: d.file_name,
      title: documentTitle({ docType: d.doc_type, fileName: d.file_name, payload, agreementTitle: agreement?.title ?? null }),
      document_date: documentDate(d.doc_type, payload),
      doc_type: d.doc_type,
      page_count: d.page_count ?? null,
      counterparty,
      amount,
      currency: agreement?.currency ?? (settled('currency', 'rent_currency') as string | null) ?? (amount != null ? 'SEK' : null),
      period: agreement?.period ?? null,
      linked: {
        journal_entry_id: d.journal_entry_id,
        voucher: d.journal_entry_id ? (voucherOf.get(d.journal_entry_id) ?? null) : null,
        agreement_id: agreement?.id ?? null,
        expected: agreement ? (expectedCount.get(agreement.id) ?? 0) : 0,
        held: d.admission_state === 'held',
        // A person is asked only about what the model read and could not name. A document with no type yet is
        // still being read and typed (prod 2026-09-25: most archives were untyped history, and every row asked).
        // Never for a booked document: the verifikat already says what it is.
        unclassified: d.admission_state === 'admitted' && d.doc_type === 'other' && !d.journal_entry_id && !d.journal_entry_line_id,
        reading: d.admission_state === 'admitted' && d.doc_type == null,
      },
      href: agreement ? `/arkiv/avtal/${agreement.id}` : `/arkiv/dokument/${d.id}`,
    }
  })
  if (pageOrder) {
    // The database already filtered the year and ordered the page; keep its order.
    const position = new Map(pageOrder.map((id, i) => [id, i]))
    rows.sort((a, b) => (position.get(a.document_id) ?? 0) - (position.get(b.document_id) ?? 0))
    return NextResponse.json({ data: rows, next_offset: nextOffset })
  }
  const dated = (r: ArkivDocumentRow) => r.document_date ?? r.created_at.slice(0, 10)
  const inYear = year ? rows.filter((r) => dated(r).startsWith(String(year))) : rows
  inYear.sort((a, b) => (dated(a) < dated(b) ? 1 : dated(a) > dated(b) ? -1 : a.created_at < b.created_at ? 1 : -1))
  return NextResponse.json({ data: inYear })
})
