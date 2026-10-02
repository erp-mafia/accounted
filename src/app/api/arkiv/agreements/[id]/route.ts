import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isArkivBrainEnabled } from '@/lib/arkiv/flag'
import { todayIso } from '@/lib/arkiv/agreements/dates'
import type { FactRow } from '@/lib/arkiv/facts/store'
import { predicateDef } from '@/lib/arkiv/facts/predicates'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/arkiv/agreements/[id]
 * The agreement page: its facts with sources, the source excerpt, expected
 * payments, the dates in Viktiga datum, the fact history, and what refers
 * to it.
 */
export interface AgreementFactView {
  fact_id: string
  predicate: string
  label: string
  value_text: string
  valid_from: string | null
  valid_to: string | null
  sys_from: string
  sys_to: string | null
  rank: string
  source_kind: string
  source: { document_id: string | null; page: number | null; quote: string | null }
}

export interface AgreementRecordView {
  id: string
  kind: string
  title: string
  status: string
  counterparty: { party_id: string | null; name: string | null }
  starts_on: string | null
  ends_on: string | null
  amount: number | null
  currency: string
  period: string | null
  source: { document_id: string; file_name: string; page: number | null; field: string | null; quote: string | null }
  facts: AgreementFactView[]
  history: AgreementFactView[]
  obligations: Array<{
    id: string
    kind: string
    due_on: string
    amount: number
    currency: string
    estimate: boolean
    status: string
    direction: 'out' | 'in'
    transaction_id: string | null
  }>
  deadlines: Array<{ id: string; title: string; due_date: string; status: string; page: number | null }>
  /** Assets a document of the agreement is tied to. */
  assets: Array<{ asset_id: string; label: string }>
  documents: Array<{ document_id: string; file_name: string; basis: string; method: string }>
  verifikat_count: number
}

/** The field whose excerpt the page shows: the money first, then what the agreement is about. */
const AMOUNT_FIELDS = [
  'monthly_rent',
  'monthly_fee',
  'instalment_amount',
  'principal',
  'fee_amount',
  'premium_amount',
  'investment_amount',
  'monthly_salary',
  'amount',
  'parties_summary',
  'subject',
  'service_description',
  'cover_description',
  'employee_name',
]

/** The fields each derived deadline was computed from, so it can point at its page. */
const DEADLINE_FIELDS: Record<string, string[]> = {
  notice: ['notice_months', 'notice_period', 'ends_on'],
  end: ['ends_on'],
  maturity: ['maturity_on', 'term_months'],
  amortisation_start: ['amortisation_free_months', 'disbursed_on'],
  closing: ['closing_on'],
}

function deadlinePage(sources: Record<string, { page: number | null }>, sourceKey: string | null): number | null {
  const key = sourceKey?.split(':').pop() ?? ''
  for (const field of DEADLINE_FIELDS[key] ?? []) if (sources[field]?.page) return sources[field].page
  return null
}

export const GET = withRouteContext('arkiv.agreement', async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
  if (!isArkivBrainEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { id } = await params
  const { data, error } = await ctx.supabase
    .from('agreements')
    .select('id, kind, title, status, counterparty_party_id, counterparty_name, starts_on, ends_on, amount, currency, period, source_document_id, sources')
    .eq('id', id)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (error) return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const a = data as {
    id: string
    kind: string
    title: string
    status: string
    counterparty_party_id: string | null
    counterparty_name: string | null
    starts_on: string | null
    ends_on: string | null
    amount: string | null
    currency: string
    period: string | null
    source_document_id: string
    sources: Record<string, { page: number | null; quote: string | null }>
  }
  const today = todayIso()

  const [party, source, facts, obligations, deadlines, links] = await Promise.all([
    a.counterparty_party_id
      ? ctx.supabase.from('parties').select('id, display_name').eq('id', a.counterparty_party_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    ctx.supabase.from('document_attachments').select('id, file_name').eq('id', a.source_document_id).maybeSingle(),
    ctx.supabase
      .from('company_facts')
      .select(
        'id, company_id, subject_kind, subject_id, predicate, value, value_text, single_valued, valid_from, valid_to, sys_from, sys_to, rank, deprecation_reason, supersedes_id, status, source_kind, source_document_id, source_extraction_id, sources, confidence, rationale, approved_by_user_id, created_at',
      )
      .eq('company_id', ctx.companyId)
      .eq('subject_kind', 'agreement')
      .eq('subject_id', id)
      .order('sys_from', { ascending: false })
      .limit(300),
    ctx.supabase
      .from('agreement_obligations')
      .select('id, kind, due_on, amount, currency, amount_is_estimate, status, direction, transaction_id')
      .eq('agreement_id', id)
      .gte('due_on', `${Number(today.slice(0, 4)) - 1}-01-01`)
      .order('due_on', { ascending: true })
      .limit(60),
    ctx.supabase
      .from('deadlines')
      .select('id, title, due_date, status, source_key')
      .eq('company_id', ctx.companyId)
      .like('source_key', `agreement:${id}:%`)
      .eq('is_completed', false)
      .is('dismissed_at', null)
      .order('due_date', { ascending: true }),
    ctx.supabase.from('document_links').select('document_id, basis, method').eq('agreement_id', id).is('retired_at', null).limit(50),
  ])
  for (const r of [party, source, facts, obligations, deadlines, links]) if (r.error) return NextResponse.json({ error: getErrorMessage(r.error) }, { status: 500 })

  const linkRows = (links.data ?? []) as Array<{ document_id: string; basis: string; method: string }>
  const docIds = [...new Set([a.source_document_id, ...linkRows.map((l) => l.document_id)])]
  const documents = await ctx.supabase.from('document_attachments').select('id, file_name, journal_entry_id').in('id', docIds)
  if (documents.error) return NextResponse.json({ error: getErrorMessage(documents.error) }, { status: 500 })
  const docRows = (documents.data ?? []) as Array<{ id: string; file_name: string; journal_entry_id: string | null }>
  const fileName = new Map(docRows.map((d) => [d.id, d.file_name]))
  const assetLinks = await ctx.supabase.from('document_links').select('asset_id').in('document_id', docIds).eq('target_kind', 'asset').is('retired_at', null).limit(20)
  if (assetLinks.error) return NextResponse.json({ error: getErrorMessage(assetLinks.error) }, { status: 500 })
  const assetRows = ((assetLinks.data ?? []) as Array<{ asset_id: string | null }>).filter((l): l is { asset_id: string } => !!l.asset_id)
  const assets = assetRows.length
    ? await ctx.supabase
        .from('assets')
        .select('id, name')
        .in(
          'id',
          assetRows.map((l) => l.asset_id),
        )
    : { data: [], error: null }
  if (assets.error) return NextResponse.json({ error: getErrorMessage(assets.error) }, { status: 500 })
  const assetName = new Map(((assets.data ?? []) as Array<{ id: string; name: string }>).map((x) => [x.id, x.name]))

  const factView = (f: FactRow): AgreementFactView => {
    const first = f.sources[0] ?? {}
    return {
      fact_id: f.id,
      predicate: f.predicate,
      label: predicateDef(f.predicate)?.label ?? f.predicate,
      value_text: f.value_text,
      valid_from: f.valid_from,
      valid_to: f.valid_to,
      sys_from: f.sys_from,
      sys_to: f.sys_to,
      rank: f.rank,
      source_kind: f.source_kind,
      source: { document_id: f.source_document_id ?? first.document_id ?? null, page: first.page ?? null, quote: first.quote ?? null },
    }
  }
  const factRows = (facts.data ?? []) as FactRow[]
  const sourceField = AMOUNT_FIELDS.find((f) => a.sources[f]) ?? Object.keys(a.sources)[0] ?? null

  const view: AgreementRecordView = {
    id: a.id,
    kind: a.kind,
    title: a.title,
    status: a.status,
    counterparty: { party_id: a.counterparty_party_id, name: (party.data as { display_name: string } | null)?.display_name ?? a.counterparty_name },
    starts_on: a.starts_on,
    ends_on: a.ends_on,
    amount: a.amount == null ? null : Number(a.amount),
    currency: a.currency,
    period: a.period,
    source: {
      document_id: a.source_document_id,
      file_name: (source.data as { file_name: string } | null)?.file_name ?? '',
      page: sourceField ? (a.sources[sourceField]?.page ?? null) : null,
      field: sourceField,
      quote: sourceField ? (a.sources[sourceField]?.quote ?? null) : null,
    },
    facts: factRows.filter((f) => f.sys_to == null && f.rank !== 'deprecated' && f.status === 'confirmed').map(factView),
    history: factRows.filter((f) => f.sys_to != null || f.rank === 'deprecated').map(factView),
    obligations: (
      (obligations.data ?? []) as Array<{
        id: string
        kind: string
        due_on: string
        amount: string
        currency: string
        amount_is_estimate: boolean
        status: string
        direction: 'out' | 'in'
        transaction_id: string | null
      }>
    ).map((o) => ({
      id: o.id,
      kind: o.kind,
      due_on: o.due_on,
      amount: Number(o.amount),
      currency: o.currency,
      estimate: o.amount_is_estimate,
      status: o.status,
      direction: o.direction,
      transaction_id: o.transaction_id,
    })),
    deadlines: ((deadlines.data ?? []) as Array<{ id: string; title: string; due_date: string; status: string; source_key: string | null }>).map((d) => ({
      id: d.id,
      title: d.title,
      due_date: d.due_date,
      status: d.status,
      page: deadlinePage(a.sources, d.source_key),
    })),
    assets: assetRows.map((l) => ({ asset_id: l.asset_id, label: assetName.get(l.asset_id) ?? '' })),
    documents: docIds.map((docId) => ({
      document_id: docId,
      file_name: fileName.get(docId) ?? '',
      basis: linkRows.find((l) => l.document_id === docId)?.basis ?? 'proven',
      method: linkRows.find((l) => l.document_id === docId)?.method ?? 'derived',
    })),
    verifikat_count: docRows.filter((d) => d.journal_entry_id).length,
  }
  return NextResponse.json({ data: view })
})
