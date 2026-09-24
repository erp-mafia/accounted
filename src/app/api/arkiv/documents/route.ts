import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { isArkivBrainEnabled, isArkivEnabled } from '@/lib/arkiv/flag'
import { DOC_TYPES, isDocType } from '@/lib/documents/classify/taxonomy'
import { documentDate, documentTitle, underlagPayload } from '@/lib/arkiv/documents/title'
import type { Payload } from '@/lib/documents/extract/fields'
import { searchDocumentPages, type PageHit } from '@/lib/documents/read/search'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { NOT_STRUCTURED_MIME_FILTER } from '@/lib/documents/read/types'

/**
 * GET /api/arkiv/documents?type=&q=&year=
 * The Arkiv table: every admitted document with its type, counterparty,
 * amount and what it is tied to. `type` is a doc_type or one of the groups
 * (agreement, authority); `q` searches page text and file names.
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
  counterparty: string | null
  amount: number | null
  currency: string | null
  /** An agreement's amount recurs: monthly, quarterly, yearly; null for a one-off or a non-agreement. */
  period: string | null
  linked: { journal_entry_id: string | null; voucher: string | null; agreement_id: string | null; expected: number; held: boolean; unclassified: boolean }
  href: string
}

const AUTHORITY = ['registration.bolagsverket', 'filing.bolagsverket', 'decision.skatteverket']
const CORPORATE = ['minutes.board', 'minutes.agm', 'share_subscription_list', 'annual_report']
const NAMED = new Set(['receipt', 'supplier_invoice', 'bank_statement', ...AUTHORITY, ...CORPORATE])
const GROUPS: Record<string, string[]> = {
  agreement: DOC_TYPES.filter((t) => t.startsWith('agreement.')),
  authority: AUTHORITY,
  corporate: CORPORATE,
  other: DOC_TYPES.filter((t) => !t.startsWith('agreement.') && !NAMED.has(t)),
}
/** Who the document is from when it names no counterparty: the authority that issued it. */
const ISSUER: Record<string, string> = {
  'registration.bolagsverket': 'Bolagsverket',
  'filing.bolagsverket': 'Bolagsverket',
  'decision.skatteverket': 'Skatteverket',
  tax_account_statement: 'Skatteverket',
}

const querySchema = z.object({
  type: z.string().max(64).optional(),
  q: z.string().trim().max(200).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

export const GET = withRouteContext('arkiv.documents', async (request, ctx) => {
  if (!isArkivEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const parsed = validateQuery(request, querySchema)
  if (!parsed.success) return parsed.response
  const { type, q, year, limit } = parsed.data
  const types = type ? (GROUPS[type] ?? (isDocType(type) ? [type] : null)) : null
  if (type && !types) return NextResponse.json({ error: 'Okänd typ.' }, { status: 400 })

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
    .select('id, created_at, file_name, doc_type, admission_state, journal_entry_id, extracted_data')
    .eq('company_id', ctx.companyId)
    .in('admission_state', ['admitted', 'held'])
    .or(NOT_STRUCTURED_MIME_FILTER)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (types) query = query.in('doc_type', types)
  if (searchIds) query = query.in('id', searchIds)
  const { data, error } = await query
  if (error) return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  const docs = (data ?? []) as Array<{ id: string; created_at: string; file_name: string; doc_type: string | null; admission_state: string; journal_entry_id: string | null; extracted_data: Record<string, unknown> | null }>
  if (docs.length === 0) return NextResponse.json({ data: [] })
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
        unclassified: d.admission_state === 'admitted' && (d.doc_type == null || d.doc_type === 'other'),
      },
      href: agreement ? `/arkiv/avtal/${agreement.id}` : `/arkiv/dokument/${d.id}`,
    }
  })
  const dated = (r: ArkivDocumentRow) => r.document_date ?? r.created_at.slice(0, 10)
  const inYear = year ? rows.filter((r) => dated(r).startsWith(String(year))) : rows
  inYear.sort((a, b) => (dated(a) < dated(b) ? 1 : dated(a) > dated(b) ? -1 : a.created_at < b.created_at ? 1 : -1))
  return NextResponse.json({ data: inYear })
})
