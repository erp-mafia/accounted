import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { todayIso } from '@/lib/arkiv/agreements/dates'
import type { AgreementKind, Period } from '@/lib/arkiv/agreements/derive'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/arkiv/agreements
 * The company's agreements as derived from its documents: what each one
 * costs and how often, the next expected payment and whether it arrived, the
 * dates in Viktiga datum, and the source page. 404 outside the rollout.
 */
export interface AgreementListItem {
  id: string
  kind: AgreementKind
  title: string
  status: 'active' | 'ended'
  counterparty: { party_id: string | null; name: string | null }
  amount: number | null
  currency: string
  period: Period | null
  starts_on: string | null
  ends_on: string | null
  next_payment: { due_on: string; amount: number; currency: string; status: 'expected' | 'matched' | 'missed' | 'waived'; kind: string } | null
  notice_deadline: { due_date: string; title: string } | null
  end_deadline: { due_date: string; title: string } | null
  source: { document_id: string; file_name: string; page: number | null }
  /** The nightly lint found another agreement read from another file with the same kind, counterparty, amount and start. */
  duplicate: boolean
}

interface AgreementRow {
  id: string
  kind: AgreementKind
  title: string
  status: 'active' | 'ended'
  counterparty_party_id: string | null
  counterparty_name: string | null
  amount: number | null
  currency: string
  period: Period | null
  starts_on: string | null
  ends_on: string | null
  source_document_id: string
  sources: Record<string, { page: number | null }>
}

interface ObligationRow {
  agreement_id: string
  due_on: string
  amount: number
  currency: string
  status: 'expected' | 'matched' | 'missed' | 'waived'
  kind: string
}

interface DeadlineRow {
  source_key: string
  due_date: string
  title: string
}

const AMOUNT_FIELDS = ['monthly_rent', 'monthly_fee', 'instalment_amount', 'principal', 'fee_amount']

export const GET = withRouteContext('arkiv.agreements', async (_request, ctx) => {
  if (!isArkivEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const today = todayIso()
  const { data: agreementData, error } = await ctx.supabase
    .from('agreements')
    .select('id, kind, title, status, counterparty_party_id, counterparty_name, amount, currency, period, starts_on, ends_on, source_document_id, sources')
    .eq('company_id', ctx.companyId)
    .order('status', { ascending: true })
    .order('ends_on', { ascending: true, nullsFirst: false })
    .limit(500)
  if (error) return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  const agreements = (agreementData ?? []) as AgreementRow[]
  if (agreements.length === 0) return NextResponse.json({ data: [] })
  const ids = agreements.map((a) => a.id)

  const [parties, obligations, deadlines, documents, duplicates] = await Promise.all([
    ctx.supabase
      .from('parties')
      .select('id, display_name')
      .in(
        'id',
        agreements.map((a) => a.counterparty_party_id).filter((id): id is string => !!id),
      ),
    ctx.supabase
      .from('agreement_obligations')
      .select('agreement_id, due_on, amount, currency, status, kind')
      .in('agreement_id', ids)
      .neq('status', 'waived')
      .order('due_on', { ascending: true }),
    ctx.supabase
      .from('deadlines')
      .select('source_key, due_date, title')
      .eq('company_id', ctx.companyId)
      .like('source_key', 'agreement:%')
      .eq('is_completed', false)
      .is('dismissed_at', null),
    ctx.supabase
      .from('document_attachments')
      .select('id, file_name')
      .in(
        'id',
        agreements.map((a) => a.source_document_id),
      ),
    ctx.supabase.from('arkiv_findings').select('detail').eq('company_id', ctx.companyId).eq('kind', 'agreement_duplicate').eq('status', 'open').limit(200),
  ])
  for (const result of [parties, obligations, deadlines, documents, duplicates])
    if (result.error) return NextResponse.json({ error: getErrorMessage(result.error) }, { status: 500 })
  const duplicateIds = new Set(((duplicates.data ?? []) as Array<{ detail: { agreement_ids?: string[] } }>).flatMap((f) => f.detail.agreement_ids ?? []))

  const partyName = new Map(((parties.data ?? []) as Array<{ id: string; display_name: string }>).map((p) => [p.id, p.display_name]))
  const fileName = new Map(((documents.data ?? []) as Array<{ id: string; file_name: string }>).map((d) => [d.id, d.file_name]))
  const deadlineByKey = new Map(((deadlines.data ?? []) as DeadlineRow[]).map((d) => [d.source_key, d]))
  const obligationsByAgreement = new Map<string, ObligationRow[]>()
  for (const o of (obligations.data ?? []) as ObligationRow[]) obligationsByAgreement.set(o.agreement_id, [...(obligationsByAgreement.get(o.agreement_id) ?? []), o])

  const items: AgreementListItem[] = agreements.map((a) => {
    const rows = obligationsByAgreement.get(a.id) ?? []
    const next =
      rows.find((o) => o.due_on >= today && o.status === 'expected') ?? [...rows].reverse().find((o) => o.status === 'missed') ?? rows.find((o) => o.due_on >= today) ?? null
    const pageField = AMOUNT_FIELDS.find((f) => a.sources[f]?.page != null) ?? Object.keys(a.sources).find((f) => a.sources[f]?.page != null)
    const deadline = (key: string) => {
      const d = deadlineByKey.get(`agreement:${a.id}:${key}`)
      return d ? { due_date: d.due_date, title: d.title } : null
    }
    return {
      id: a.id,
      kind: a.kind,
      title: a.title,
      status: a.status,
      counterparty: { party_id: a.counterparty_party_id, name: (a.counterparty_party_id && partyName.get(a.counterparty_party_id)) || a.counterparty_name },
      amount: a.amount == null ? null : Number(a.amount),
      currency: a.currency,
      period: a.period,
      starts_on: a.starts_on,
      ends_on: a.ends_on,
      next_payment: next ? { due_on: next.due_on, amount: Number(next.amount), currency: next.currency, status: next.status, kind: next.kind } : null,
      notice_deadline: deadline('notice'),
      end_deadline: deadline('end') ?? deadline('maturity'),
      source: { document_id: a.source_document_id, file_name: fileName.get(a.source_document_id) ?? '', page: pageField ? (a.sources[pageField]?.page ?? null) : null },
      duplicate: duplicateIds.has(a.id),
    }
  })
  return NextResponse.json({ data: items })
})
