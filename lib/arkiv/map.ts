import type { SupabaseClient } from '@supabase/supabase-js'
import { documentDate, documentTitle } from '@/lib/arkiv/documents/title'
import { predicateDef } from '@/lib/arkiv/facts/predicates'
import type { Payload } from '@/lib/documents/extract/fields'

/**
 * The map (phase 8): a few kilobytes an agent reads before it searches,
 * so it knows what the archive holds, what the company is, what runs and
 * what waits, and where to go for more. Constant in size, never the data
 * itself: every entry is a ref to open. The same shape feeds the briefing.
 */
export interface ArkivMap {
  company: { name: string; org_number: string | null; record_ref: string }
  documents: {
    total: number
    by_group: Record<'agreements' | 'authority' | 'corporate' | 'receipts_invoices' | 'statements' | 'other', number>
    latest: Array<{
      record_ref: string
      title: string
      type: string | null
      date: string | null
    }>
  }
  agreements: Array<{
    record_ref: string
    title: string
    kind: string
    counterparty: string | null
    amount: number | null
    period: string | null
    ends_on: string | null
    next_payment: string | null
  }>
  company_facts: Array<{
    predicate: string
    label: string
    value: string
    valid_from: string | null
  }>
  waiting: { questions: number; findings: number }
  how_to: string[]
}

const LATEST = 10
const AGREEMENTS = 12
const FACT_PREDICATES = [
  'legal_name',
  'org_number',
  'registered_office',
  'fiscal_year',
  'share_capital',
  'share_count',
  'board',
  'signatories_rule',
  'auditor',
  'f_skatt',
  'vat_registered',
  'vat_period',
  'vat_method',
  'employer_registered',
  'business_description',
]
const AUTHORITY = new Set(['registration.bolagsverket', 'filing.bolagsverket', 'decision.skatteverket'])
const CORPORATE = new Set(['minutes.board', 'minutes.agm', 'share_subscription_list', 'annual_report'])
const RECEIPTS = new Set(['receipt', 'supplier_invoice', 'credit_note', 'customer_invoice'])
const STATEMENTS = new Set(['bank_statement', 'tax_account_statement'])

const group = (type: string | null): keyof ArkivMap['documents']['by_group'] =>
  type?.startsWith('agreement.')
    ? 'agreements'
    : type && AUTHORITY.has(type)
      ? 'authority'
      : type && CORPORATE.has(type)
        ? 'corporate'
        : type && RECEIPTS.has(type)
          ? 'receipts_invoices'
          : type && STATEMENTS.has(type)
            ? 'statements'
            : 'other'

export async function buildArkivMap(supabase: SupabaseClient, companyId: string): Promise<ArkivMap> {
  const [company, docs, agreements, facts, questions, findings] = await Promise.all([
    supabase.from('companies').select('name, org_number').eq('id', companyId).maybeSingle(),
    supabase
      .from('document_attachments')
      .select('id, file_name, doc_type, created_at')
      .eq('company_id', companyId)
      .eq('admission_state', 'admitted')
      .order('created_at', { ascending: false })
      .limit(2000),
    supabase
      .from('agreements')
      .select('id, title, kind, counterparty_name, amount, period, ends_on')
      .eq('company_id', companyId)
      .eq('status', 'active')
      .order('ends_on', { ascending: true, nullsFirst: false })
      .limit(AGREEMENTS),
    supabase
      .from('company_facts')
      .select('predicate, value_text, valid_from')
      .eq('company_id', companyId)
      .eq('subject_kind', 'company')
      .eq('subject_id', companyId)
      .eq('status', 'confirmed')
      .is('sys_to', null)
      .neq('rank', 'deprecated')
      .limit(200),
    supabase.from('document_extractions').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('is_current', true).not('review_fields', 'eq', '{}'),
    supabase.from('arkiv_findings').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'open'),
  ])
  for (const r of [company, docs, agreements, facts, questions, findings]) if (r.error) throw new Error(`map read failed: ${r.error.message}`)

  const documents = (docs.data ?? []) as Array<{
    id: string
    file_name: string
    doc_type: string | null
    created_at: string
  }>
  const by_group: ArkivMap['documents']['by_group'] = {
    agreements: 0,
    authority: 0,
    corporate: 0,
    receipts_invoices: 0,
    statements: 0,
    other: 0,
  }
  for (const d of documents) by_group[group(d.doc_type)]++
  const latestIds = documents.slice(0, LATEST).map((d) => d.id)
  const payloads = new Map<string, Payload>()
  if (latestIds.length) {
    const { data, error } = await supabase.from('document_extractions').select('document_id, payload').in('document_id', latestIds).eq('is_current', true)
    if (error) throw new Error(`map read failed: ${error.message}`)
    for (const e of (data ?? []) as Array<{
      document_id: string
      payload: Payload
    }>)
      payloads.set(e.document_id, e.payload)
  }
  const agreementRows = (agreements.data ?? []) as Array<{
    id: string
    title: string
    kind: string
    counterparty_name: string | null
    amount: string | null
    period: string | null
    ends_on: string | null
  }>
  let nextByAgreement = new Map<string, string>()
  if (agreementRows.length) {
    const { data, error } = await supabase
      .from('agreement_obligations')
      .select('agreement_id, due_on')
      .in(
        'agreement_id',
        agreementRows.map((a) => a.id),
      )
      .eq('status', 'expected')
      .order('due_on', { ascending: true })
      .limit(500)
    if (error) throw new Error(`map read failed: ${error.message}`)
    nextByAgreement = new Map()
    for (const o of (data ?? []) as Array<{
      agreement_id: string
      due_on: string
    }>)
      if (!nextByAgreement.has(o.agreement_id)) nextByAgreement.set(o.agreement_id, o.due_on)
  }
  const factRows = (facts.data ?? []) as Array<{
    predicate: string
    value_text: string
    valid_from: string | null
  }>
  const c = company.data as { name: string; org_number: string | null } | null

  return {
    // The registration certificate settles the organisation number when the company row never got one.
    company: {
      name: c?.name ?? '',
      org_number: c?.org_number ?? factRows.find((r) => r.predicate === 'org_number')?.value_text ?? null,
      record_ref: `company:${companyId}`,
    },
    documents: {
      total: documents.length,
      by_group,
      latest: documents.slice(0, LATEST).map((d) => ({
        record_ref: `document:${d.id}`,
        title: documentTitle({
          docType: d.doc_type,
          fileName: d.file_name,
          payload: payloads.get(d.id) ?? null,
        }),
        type: d.doc_type,
        date: documentDate(d.doc_type, payloads.get(d.id) ?? null) ?? d.created_at.slice(0, 10),
      })),
    },
    agreements: agreementRows.map((a) => ({
      record_ref: `agreement:${a.id}`,
      title: a.title,
      kind: a.kind,
      counterparty: a.counterparty_name,
      amount: a.amount == null ? null : Number(a.amount),
      period: a.period,
      ends_on: a.ends_on,
      next_payment: nextByAgreement.get(a.id) ?? null,
    })),
    company_facts: FACT_PREDICATES.flatMap((predicate) => {
      const f = factRows.find((r) => r.predicate === predicate)
      return f
        ? [
            {
              predicate,
              label: predicateDef(predicate)?.label ?? predicate,
              value: f.value_text.length > 200 ? `${f.value_text.slice(0, 199)}…` : f.value_text,
              valid_from: f.valid_from,
            },
          ]
        : []
    }),
    waiting: { questions: questions.count ?? 0, findings: findings.count ?? 0 },
    how_to: [
      'Find: gnubok_search_records (document text, agreements, facts) returns record_refs.',
      'Open: gnubok_get_record on a record_ref; gnubok_get_source for the full text of a page; gnubok_get_record_links for what it is tied to.',
      'Ask: gnubok_ask_document answers one question from the document text with page and quote; nothing is pre-extracted for it.',
      'Time: gnubok_get_fact_history shows when a value held and when it was believed.',
      'Write: only gnubok_propose_fact, which a person approves.',
    ],
  }
}
