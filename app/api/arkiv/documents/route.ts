import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { DOC_TYPES, isDocType } from '@/lib/documents/classify/taxonomy'
import { getErrorMessage } from '@/lib/errors/get-error-message'

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
  doc_type: string | null
  counterparty: string | null
  amount: number | null
  currency: string | null
  linked: { journal_entry_id: string | null; agreement_id: string | null; facts: number; held: boolean }
  href: string
}

const GROUPS: Record<string, string[]> = {
  agreement: DOC_TYPES.filter((t) => t.startsWith('agreement.')),
  authority: ['registration.bolagsverket', 'filing.bolagsverket', 'decision.skatteverket'],
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
    const [pages, names] = await Promise.all([
      ctx.supabase.rpc('search_document_pages', { p_company_id: ctx.companyId, p_query: q, p_limit: limit }),
      ctx.supabase.from('document_attachments').select('id').eq('company_id', ctx.companyId).ilike('file_name', `%${q.replace(/[%_]/g, ' ')}%`).limit(limit),
    ])
    if (pages.error) return NextResponse.json({ error: getErrorMessage(pages.error) }, { status: 500 })
    if (names.error) return NextResponse.json({ error: getErrorMessage(names.error) }, { status: 500 })
    searchIds = [...new Set([...((pages.data ?? []) as Array<{ document_id: string }>).map((p) => p.document_id), ...((names.data ?? []) as Array<{ id: string }>).map((d) => d.id)])]
    if (searchIds.length === 0) return NextResponse.json({ data: [] })
  }

  let query = ctx.supabase
    .from('document_attachments')
    .select('id, created_at, file_name, doc_type, admission_state, journal_entry_id')
    .eq('company_id', ctx.companyId)
    .in('admission_state', ['admitted', 'held'])
    .order('created_at', { ascending: false })
    .limit(limit)
  if (types) query = query.in('doc_type', types)
  if (year) query = query.gte('created_at', `${year}-01-01`).lt('created_at', `${year + 1}-01-01`)
  if (searchIds) query = query.in('id', searchIds)
  const { data, error } = await query
  if (error) return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  const docs = (data ?? []) as Array<{ id: string; created_at: string; file_name: string; doc_type: string | null; admission_state: string; journal_entry_id: string | null }>
  if (docs.length === 0) return NextResponse.json({ data: [] })
  const ids = docs.map((d) => d.id)

  const [extractions, agreements, facts] = await Promise.all([
    ctx.supabase.from('document_extractions').select('document_id, payload').in('document_id', ids).eq('is_current', true),
    ctx.supabase.from('agreements').select('id, source_document_id, counterparty_name, amount, currency').in('source_document_id', ids),
    ctx.supabase.from('company_facts').select('source_document_id').in('source_document_id', ids).is('sys_to', null).neq('rank', 'deprecated'),
  ])
  for (const r of [extractions, agreements, facts]) if (r.error) return NextResponse.json({ error: getErrorMessage(r.error) }, { status: 500 })
  const payloadByDoc = new Map(((extractions.data ?? []) as Array<{ document_id: string; payload: Record<string, { normalized: unknown }> }>).map((e) => [e.document_id, e.payload]))
  const agreementByDoc = new Map(((agreements.data ?? []) as Array<{ id: string; source_document_id: string; counterparty_name: string | null; amount: string | null; currency: string }>).map((a) => [a.source_document_id, a]))
  const factCount = new Map<string, number>()
  for (const f of (facts.data ?? []) as Array<{ source_document_id: string }>) factCount.set(f.source_document_id, (factCount.get(f.source_document_id) ?? 0) + 1)

  const rows: ArkivDocumentRow[] = docs.map((d) => {
    const payload = payloadByDoc.get(d.id) ?? {}
    const agreement = agreementByDoc.get(d.id)
    const settled = (...names: string[]) => names.map((n) => payload[n]?.normalized).find((v) => v != null) ?? null
    const counterparty = agreement?.counterparty_name ?? (settled('counterparty_name', 'landlord_name', 'lessor_name', 'lender_name', 'provider_name', 'company_name') as string | null)
    const amount = agreement?.amount != null ? Number(agreement.amount) : (settled('total_amount', 'monthly_rent', 'monthly_fee', 'principal', 'fee_amount', 'amount') as number | null)
    return {
      document_id: d.id,
      created_at: d.created_at,
      file_name: d.file_name,
      doc_type: d.doc_type,
      counterparty,
      amount,
      currency: agreement?.currency ?? (settled('currency', 'rent_currency') as string | null) ?? (amount != null ? 'SEK' : null),
      linked: { journal_entry_id: d.journal_entry_id, agreement_id: agreement?.id ?? null, facts: factCount.get(d.id) ?? 0, held: d.admission_state === 'held' },
      href: agreement ? `/arkiv/avtal/${agreement.id}` : `/arkiv/dokument/${d.id}`,
    }
  })
  return NextResponse.json({ data: rows })
})
