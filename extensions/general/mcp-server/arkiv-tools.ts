import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { toSameOriginStorageUrl } from '@/lib/core/documents/storage-proxy'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { factHistory, listLiveFacts, type FactRow } from '@/lib/arkiv/facts/store'
import { PREDICATES, predicateDef, type FactSubjectKind } from '@/lib/arkiv/facts/predicates'
import { searchDocumentPages } from '@/lib/documents/read/search'
import { ArkivProposeFactParamsSchema } from '@/lib/pending-operations/schemas/arkiv-propose-fact'
import type { McpTool, McpToolAnnotations, ActorContext } from './server'

/**
 * Arkiv phase 5: the six tools an agent reads the record with, and the one
 * it curates with. Every id is stable and qualified; a record_ref is
 * `<kind>:<uuid>` for document, agreement, party, journal_entry and fact.
 * Reads never leave the company; the only write stages a proposal a person
 * approves. Outside the rollout every tool answers "not enabled".
 */
export type RecordKind = 'document' | 'agreement' | 'party' | 'journal_entry' | 'fact'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseRecordRef(ref: unknown): { kind: RecordKind; id: string } {
  if (typeof ref !== 'string') throw new Error('record_ref must be a string like document:<uuid>')
  const [kind, id] = ref.split(':')
  if (!['document', 'agreement', 'party', 'journal_entry', 'fact'].includes(kind) || !UUID.test(id ?? '')) {
    throw new Error('record_ref must be <document|agreement|party|journal_entry|fact>:<uuid>')
  }
  return { kind: kind as RecordKind, id }
}

const recordRef = (kind: RecordKind, id: string) => `${kind}:${id}`

function assertEnabled(companyId: string): void {
  if (!isArkivEnabled(companyId)) throw new Error('Arkiv is not enabled for this company yet')
}

interface Deps {
  readOnly: McpToolAnnotations
  stagedWrite: McpToolAnnotations
  stagedSchema: Record<string, unknown>
  stage: (
    supabase: SupabaseClient,
    companyId: string,
    userId: string,
    operationType: string,
    title: string,
    params: Record<string, unknown>,
    previewData: Record<string, unknown>,
    actor?: ActorContext,
  ) => Promise<Record<string, unknown>>
}

const FACT_SHAPE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fact_id: { type: 'string' },
    subject_ref: { type: 'string' },
    predicate: { type: 'string' },
    label: { type: 'string' },
    value: {},
    valid_from: { type: ['string', 'null'] },
    valid_to: { type: ['string', 'null'] },
    believed_from: { type: 'string' },
    believed_to: { type: ['string', 'null'] },
    rank: { type: 'string', enum: ['preferred', 'normal', 'deprecated'] },
    status: { type: 'string', enum: ['proposed', 'confirmed'] },
    source_kind: { type: 'string' },
    source_document_id: { type: ['string', 'null'] },
    sources: { type: 'array', items: { type: 'object' } },
    supersedes_fact_id: { type: ['string', 'null'] },
  },
  required: ['fact_id', 'subject_ref', 'predicate', 'value', 'believed_from', 'rank', 'status', 'source_kind', 'sources'],
} as const

function factView(f: FactRow) {
  return {
    fact_id: f.id,
    subject_ref: recordRef(f.subject_kind === 'company' ? 'fact' : f.subject_kind, f.subject_id).replace(/^fact:/, 'company:'),
    predicate: f.predicate,
    label: predicateDef(f.predicate)?.label ?? f.predicate,
    value: f.value,
    valid_from: f.valid_from,
    valid_to: f.valid_to,
    believed_from: f.sys_from,
    believed_to: f.sys_to,
    rank: f.rank,
    status: f.status,
    source_kind: f.source_kind,
    source_document_id: f.source_document_id,
    sources: f.sources,
    supersedes_fact_id: f.supersedes_id,
  }
}

interface DocumentRow {
  id: string
  file_name: string
  created_at: string
  doc_type: string | null
  admission_state: string
  page_count: number | null
  journal_entry_id: string | null
  extracted_data: Record<string, unknown> | null
}

async function documentRecord(supabase: SupabaseClient, companyId: string, documentId: string) {
  const [doc, extraction, links, agreement] = await Promise.all([
    supabase
      .from('document_attachments')
      .select('id, file_name, created_at, doc_type, admission_state, page_count, journal_entry_id, extracted_data')
      .eq('id', documentId)
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('document_extractions')
      .select('id, schema_type, schema_version, pass, payload, review_fields, created_at')
      .eq('document_id', documentId)
      .eq('is_current', true)
      .maybeSingle(),
    supabase.from('document_links').select('id, target_kind, target_id, basis, method, confidence').eq('document_id', documentId).is('retired_at', null),
    supabase.from('agreements').select('id, kind, title').eq('source_document_id', documentId).maybeSingle(),
  ])
  for (const r of [doc, extraction, links, agreement]) if (r.error) throw dbError(r.error)
  if (!doc.data) return null
  const d = doc.data as DocumentRow
  const ext = extraction.data as {
    id: string
    schema_type: string
    schema_version: number
    pass: string
    payload: Record<
      string,
      {
        value: unknown
        normalized: unknown
        page: number | null
        quote: string | null
        confidence: number
        method: string
        readings?: Array<{ value: unknown; page: number | null; quote: string | null }>
      }
    >
    review_fields: string[]
    created_at: string
  } | null
  return {
    document_id: d.id,
    file_name: d.file_name,
    created_at: d.created_at,
    doc_type: d.doc_type,
    admission_state: d.admission_state,
    page_count: d.page_count,
    journal_entry_id: d.journal_entry_id,
    record: ext
      ? {
          extraction_id: ext.id,
          schema_type: ext.schema_type,
          schema_version: ext.schema_version,
          settled_by: ext.pass,
          fields: Object.entries(ext.payload).map(([name, f]) => ({
            field: name,
            value: f.normalized ?? f.value ?? null,
            page: f.page,
            quote: f.quote,
            confidence: f.confidence,
            under_review: ext.review_fields.includes(name),
            readings: f.confidence < 1 && f.readings?.length ? f.readings.map((r) => ({ value: r.value, page: r.page, quote: r.quote })) : undefined,
          })),
          review_fields: ext.review_fields,
        }
      : null,
    links: ((links.data ?? []) as Array<{ id: string; target_kind: RecordKind; target_id: string; basis: string; method: string; confidence: number }>).map((l) => ({
      link_id: l.id,
      record_ref: recordRef(l.target_kind, l.target_id),
      basis: l.basis,
      method: l.method,
      confidence: Number(l.confidence),
    })),
    agreement_ref: agreement.data ? recordRef('agreement', (agreement.data as { id: string }).id) : null,
    // The Underlag reader's structured read of a receipt or invoice (line items, VAT breakdown, totals), when it ran.
    underlag_extraction: d.extracted_data ?? null,
  }
}

async function agreementRecord(supabase: SupabaseClient, companyId: string, agreementId: string, asOf: string | null) {
  const { data, error } = await supabase
    .from('agreements')
    .select(
      'id, kind, title, status, counterparty_party_id, counterparty_name, starts_on, ends_on, notice_months, renewal_terms, amount, currency, period, principal, interest_rate, source_document_id, sources',
    )
    .eq('id', agreementId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw dbError(error)
  if (!data) return null
  const a = data as Record<string, unknown> & { id: string; counterparty_party_id: string | null; source_document_id: string }
  const [obligations, deadlines, facts] = await Promise.all([
    supabase
      .from('agreement_obligations')
      .select('id, kind, due_on, amount, currency, amount_is_estimate, status, transaction_id')
      .eq('agreement_id', agreementId)
      .order('due_on', { ascending: true })
      .limit(60),
    supabase
      .from('deadlines')
      .select('id, title, due_date, status, source_key')
      .eq('company_id', companyId)
      .like('source_key', `agreement:${agreementId}:%`)
      .eq('is_completed', false)
      .is('dismissed_at', null),
    listLiveFacts(supabase, companyId, { kind: 'agreement', id: agreementId }, asOf),
  ])
  if (obligations.error) throw dbError(obligations.error)
  if (deadlines.error) throw dbError(deadlines.error)
  return {
    agreement_id: a.id,
    kind: a.kind,
    title: a.title,
    status: a.status,
    counterparty: { party_ref: a.counterparty_party_id ? recordRef('party', a.counterparty_party_id) : null, name: a.counterparty_name },
    starts_on: a.starts_on,
    ends_on: a.ends_on,
    notice_months: a.notice_months,
    renewal_terms: a.renewal_terms,
    amount: a.amount == null ? null : Number(a.amount),
    currency: a.currency,
    period: a.period,
    principal: a.principal == null ? null : Number(a.principal),
    interest_rate: a.interest_rate == null ? null : Number(a.interest_rate),
    source_document_ref: recordRef('document', a.source_document_id),
    sources: a.sources,
    obligations: ((obligations.data ?? []) as Array<Record<string, unknown>>).map((o) => ({
      obligation_id: o.id,
      kind: o.kind,
      due_on: o.due_on,
      amount: Number(o.amount),
      currency: o.currency,
      estimate: o.amount_is_estimate,
      status: o.status,
      transaction_id: o.transaction_id,
    })),
    deadlines: ((deadlines.data ?? []) as Array<Record<string, unknown>>).map((d) => ({ deadline_id: d.id, title: d.title, due_date: d.due_date, status: d.status })),
    facts: facts.map(factView),
  }
}

async function partyRecord(supabase: SupabaseClient, companyId: string, partyId: string) {
  const { data, error } = await supabase
    .from('parties')
    .select('id, display_name, legal_name, org_number, vat_number, kind, status')
    .eq('id', partyId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw dbError(error)
  if (!data) return null
  const p = data as Record<string, unknown> & { id: string }
  const { data: links, error: linkError } = await supabase.from('document_links').select('document_id, basis, method').eq('party_id', partyId).is('retired_at', null).limit(100)
  if (linkError) throw dbError(linkError)
  const { data: agreements, error: agrError } = await supabase.from('agreements').select('id, title, kind, status').eq('counterparty_party_id', partyId).limit(50)
  if (agrError) throw dbError(agrError)
  return {
    party_id: p.id,
    display_name: p.display_name,
    legal_name: p.legal_name,
    org_number: p.org_number,
    vat_number: p.vat_number,
    kind: p.kind,
    status: p.status,
    documents: ((links ?? []) as Array<{ document_id: string; basis: string; method: string }>).map((l) => ({
      record_ref: recordRef('document', l.document_id),
      basis: l.basis,
      method: l.method,
    })),
    agreements: ((agreements ?? []) as Array<{ id: string; title: string; kind: string; status: string }>).map((a) => ({
      record_ref: recordRef('agreement', a.id),
      title: a.title,
      kind: a.kind,
      status: a.status,
    })),
  }
}

async function journalEntryRecord(supabase: SupabaseClient, companyId: string, journalEntryId: string) {
  const { data: entry, error } = await supabase
    .from('journal_entries')
    .select('id, voucher_series, voucher_number, entry_date, description')
    .eq('id', journalEntryId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw dbError(error)
  if (!entry) return null
  const { data: docs, error: docError } = await supabase.from('document_attachments').select('id').eq('journal_entry_id', journalEntryId).eq('company_id', companyId).limit(50)
  if (docError) throw dbError(docError)
  const documents = []
  for (const d of (docs ?? []) as Array<{ id: string }>) {
    const record = await documentRecord(supabase, companyId, d.id)
    if (record) documents.push(record)
  }
  const e = entry as Record<string, unknown> & { id: string }
  return { journal_entry_id: e.id, voucher: `${e.voucher_series ?? ''}${e.voucher_number ?? ''}`, entry_date: e.entry_date, description: e.description, documents }
}

export function createArkivTools(deps: Deps): McpTool[] {
  return [
    {
      name: 'gnubok_search_records',
      keywords: ['arkiv', 'dokument', 'avtal', 'fakta', 'sök dokument', 'hyresavtal', 'lån', 'registreringsbevis'],
      title: 'Search Records',
      description:
        'Search the company archive: document text, agreements and facts. Returns record_refs to pass to gnubok_get_record. Use for any question about a contract, registration, decision or what a document says.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', minLength: 2, maxLength: 200, description: 'Words to search for, Swedish or as printed in the document.' },
          kinds: { type: 'array', items: { type: 'string', enum: ['document', 'agreement', 'fact'] }, description: 'Limit to these record kinds. Default: all three.' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Per kind. Default 10.' },
        },
        required: ['query'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                record_ref: { type: 'string' },
                kind: { type: 'string', enum: ['document', 'agreement', 'fact'] },
                title: { type: 'string' },
                snippet: { type: ['string', 'null'] },
                document_id: { type: ['string', 'null'] },
                page: { type: ['integer', 'null'] },
              },
              required: ['record_ref', 'kind', 'title', 'snippet', 'document_id', 'page'],
            },
          },
          count: { type: 'integer' },
        },
        required: ['items', 'count'],
      },
      annotations: deps.readOnly,
      async execute(args, companyId, _userId, supabase) {
        assertEnabled(companyId)
        const query = String(args.query ?? '').trim()
        if (query.length < 2) throw new Error('query must be at least two characters')
        const kinds = new Set<string>(Array.isArray(args.kinds) && args.kinds.length ? (args.kinds as string[]) : ['document', 'agreement', 'fact'])
        const limit = Math.min(50, Math.max(1, Number(args.limit ?? 10)))
        const items: Array<{
          record_ref: string
          kind: 'document' | 'agreement' | 'fact'
          title: string
          snippet: string | null
          document_id: string | null
          page: number | null
        }> = []
        const like = `%${query.replace(/[%_]/g, ' ')}%`
        if (kinds.has('document')) {
          const hits = await searchDocumentPages(supabase, companyId, query, limit)
          for (const hit of hits) {
            items.push({
              record_ref: recordRef('document', hit.document_id),
              kind: 'document',
              title: hit.file_name,
              snippet: hit.headline,
              document_id: hit.document_id,
              page: hit.page_no,
            })
          }
        }
        if (kinds.has('agreement')) {
          const { data, error } = await supabase
            .from('agreements')
            .select('id, title, counterparty_name, kind, ends_on')
            .eq('company_id', companyId)
            .or(`title.ilike.${like},counterparty_name.ilike.${like}`)
            .limit(limit)
          if (error) throw dbError(error)
          for (const a of (data ?? []) as Array<{ id: string; title: string; counterparty_name: string | null; kind: string; ends_on: string | null }>) {
            items.push({
              record_ref: recordRef('agreement', a.id),
              kind: 'agreement',
              title: a.title,
              snippet: [a.kind, a.counterparty_name, a.ends_on ? `till ${a.ends_on}` : null].filter(Boolean).join(' · '),
              document_id: null,
              page: null,
            })
          }
        }
        if (kinds.has('fact')) {
          // "momsperiod" is the Swedish label of vat_period: a query that names a predicate the way people do finds its facts.
          const labelled = Object.values(PREDICATES)
            .filter((p) => p.label.toLowerCase().includes(query.toLowerCase()))
            .map((p) => p.predicate)
          const factFilter = labelled.length
            ? `value_text.ilike.${like},predicate.ilike.${like},predicate.in.(${labelled.join(',')})`
            : `value_text.ilike.${like},predicate.ilike.${like}`
          const { data, error } = await supabase
            .from('company_facts')
            .select('id, predicate, value_text, subject_kind, subject_id, source_document_id')
            .eq('company_id', companyId)
            .is('sys_to', null)
            .neq('rank', 'deprecated')
            .or(factFilter)
            .limit(limit)
          if (error) throw dbError(error)
          for (const f of (data ?? []) as Array<{
            id: string
            predicate: string
            value_text: string
            subject_kind: FactSubjectKind
            subject_id: string
            source_document_id: string | null
          }>) {
            items.push({
              record_ref: recordRef('fact', f.id),
              kind: 'fact',
              title: `${predicateDef(f.predicate)?.label ?? f.predicate}: ${f.value_text}`,
              snippet: `${f.subject_kind}:${f.subject_id}`,
              document_id: f.source_document_id,
              page: null,
            })
          }
        }
        return { items, count: items.length }
      },
    },
    {
      name: 'gnubok_get_record',
      keywords: ['arkiv', 'dokument', 'avtal', 'verifikat underlag', 'läs avtal'],
      title: 'Get Record',
      description:
        'The structured record behind a record_ref: a document with its extracted fields (each with page and quote), an agreement with its payments, dates and facts, a party, or a journal_entry with every attached document as a record. as_of picks the facts valid on a date.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          record_ref: { type: 'string', description: 'document:<uuid>, agreement:<uuid>, party:<uuid>, journal_entry:<uuid> or fact:<uuid>.' },
          as_of: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Facts valid on this date. Default: today.' },
        },
        required: ['record_ref'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          record_ref: { type: 'string' },
          kind: { type: 'string', enum: ['document', 'agreement', 'party', 'journal_entry', 'fact'] },
          document: { type: ['object', 'null'] },
          agreement: { type: ['object', 'null'] },
          party: { type: ['object', 'null'] },
          journal_entry: { type: ['object', 'null'] },
          fact: { type: ['object', 'null'] },
        },
        required: ['record_ref', 'kind'],
      },
      annotations: deps.readOnly,
      async execute(args, companyId, _userId, supabase) {
        assertEnabled(companyId)
        const ref = parseRecordRef(args.record_ref)
        const asOf = typeof args.as_of === 'string' ? args.as_of : null
        const base = { record_ref: recordRef(ref.kind, ref.id), kind: ref.kind }
        switch (ref.kind) {
          case 'document': {
            const document = await documentRecord(supabase, companyId, ref.id)
            if (!document) throw new Error('Record not found')
            return { ...base, document }
          }
          case 'agreement': {
            const agreement = await agreementRecord(supabase, companyId, ref.id, asOf)
            if (!agreement) throw new Error('Record not found')
            return { ...base, agreement }
          }
          case 'party': {
            const party = await partyRecord(supabase, companyId, ref.id)
            if (!party) throw new Error('Record not found')
            return { ...base, party }
          }
          case 'journal_entry': {
            const journalEntry = await journalEntryRecord(supabase, companyId, ref.id)
            if (!journalEntry) throw new Error('Record not found')
            return { ...base, journal_entry: journalEntry }
          }
          case 'fact': {
            const { data, error } = await supabase.from('company_facts').select('*').eq('id', ref.id).eq('company_id', companyId).maybeSingle()
            if (error) throw dbError(error)
            if (!data) throw new Error('Record not found')
            return { ...base, fact: factView(data as FactRow) }
          }
        }
      },
    },
    {
      name: 'gnubok_get_record_links',
      keywords: ['arkiv', 'kopplingar', 'motpart', 'avtal'],
      title: 'Get Record Links',
      description:
        'What a record is tied to: parties, agreements, assets and documents, each link with its basis (proven or guessed). depth 2 follows one step further. Use gnubok_get_record on the refs you get back.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          record_ref: { type: 'string', description: 'document:<uuid>, agreement:<uuid> or party:<uuid>.' },
          depth: { type: 'integer', minimum: 1, maximum: 2, description: 'Default 1.' },
        },
        required: ['record_ref'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          record_ref: { type: 'string' },
          links: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                from_ref: { type: 'string' },
                record_ref: { type: 'string' },
                relation: { type: 'string' },
                basis: { type: 'string', enum: ['proven', 'guessed'] },
                method: { type: 'string' },
                title: { type: ['string', 'null'] },
              },
              required: ['from_ref', 'record_ref', 'relation', 'basis', 'method', 'title'],
            },
          },
        },
        required: ['record_ref', 'links'],
      },
      annotations: deps.readOnly,
      catalogVisibility: 'search',
      async execute(args, companyId, _userId, supabase) {
        assertEnabled(companyId)
        const ref = parseRecordRef(args.record_ref)
        const depth = Number(args.depth ?? 1) >= 2 ? 2 : 1
        const links = await linksOf(supabase, companyId, ref)
        if (depth === 2) {
          const seen = new Set([recordRef(ref.kind, ref.id)])
          for (const l of [...links]) {
            if (seen.has(l.record_ref)) continue
            seen.add(l.record_ref)
            links.push(...(await linksOf(supabase, companyId, parseRecordRef(l.record_ref))).filter((x) => !seen.has(x.record_ref)))
          }
        }
        return { record_ref: recordRef(ref.kind, ref.id), links }
      },
    },
    {
      name: 'gnubok_get_fact_history',
      keywords: ['arkiv', 'fakta', 'historik', 'ändrades när'],
      title: 'Get Fact History',
      description:
        'Every reading a subject ever had for a predicate, with validity and belief windows, what superseded what, and the page each value came from. Use when a value changed or two sources disagree.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subject_ref: { type: 'string', description: 'company:<company uuid>, agreement:<uuid> or party:<uuid>.' },
          predicate: { type: 'string', description: 'One predicate, e.g. amount or vat_registered. Default: all.' },
        },
        required: ['subject_ref'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { subject_ref: { type: 'string' }, facts: { type: 'array', items: FACT_SHAPE } },
        required: ['subject_ref', 'facts'],
      },
      annotations: deps.readOnly,
      catalogVisibility: 'search',
      async execute(args, companyId, _userId, supabase) {
        assertEnabled(companyId)
        const subject = parseSubjectRef(args.subject_ref, companyId)
        const predicate = typeof args.predicate === 'string' && args.predicate ? args.predicate : null
        if (predicate && !PREDICATES[predicate]) throw new Error(`unknown predicate ${predicate}`)
        const facts = await factHistory(supabase, companyId, subject, predicate)
        return { subject_ref: String(args.subject_ref), facts: facts.map(factView) }
      },
    },
    {
      name: 'gnubok_get_source',
      keywords: ['arkiv', 'sida', 'källa', 'citat', 'läs sidan'],
      title: 'Get Source',
      description:
        'The text of one page of a document as Arkiv read it, plus a 5-minute signed URL to the file. Use to verify a quote or read around a cited value before answering.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          document_id: { type: 'string', description: 'UUID of the document.' },
          page: { type: 'integer', minimum: 1, description: 'Page number. Default 1.' },
        },
        required: ['document_id'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          document_id: { type: 'string' },
          file_name: { type: 'string' },
          page_no: { type: 'integer' },
          page_count: { type: ['integer', 'null'] },
          text: { type: 'string' },
          signed_url: { type: 'string' },
          expires_at: { type: 'string' },
        },
        required: ['document_id', 'file_name', 'page_no', 'page_count', 'text', 'signed_url', 'expires_at'],
      },
      annotations: deps.readOnly,
      catalogVisibility: 'search',
      async execute(args, companyId, _userId, supabase) {
        assertEnabled(companyId)
        const documentId = String(args.document_id ?? '')
        if (!UUID.test(documentId)) throw new Error('document_id must be a UUID')
        const pageNo = Math.max(1, Number(args.page ?? 1))
        const { data: doc, error } = await supabase
          .from('document_attachments')
          .select('id, file_name, storage_path, page_count')
          .eq('id', documentId)
          .eq('company_id', companyId)
          .maybeSingle()
        if (error) throw dbError(error)
        if (!doc) throw new Error('Document not found')
        const d = doc as { id: string; file_name: string; storage_path: string; page_count: number | null }
        const { data: page, error: pageError } = await supabase.from('document_pages').select('text').eq('document_id', documentId).eq('page_no', pageNo).maybeSingle()
        if (pageError) throw dbError(pageError)
        const ttlSeconds = 300
        const { data: signed, error: signError } = await supabase.storage.from('documents').createSignedUrl(d.storage_path, ttlSeconds)
        if (signError || !signed) throw new Error(`Failed to create signed URL: ${signError?.message ?? 'unknown error'}`)
        return {
          document_id: d.id,
          file_name: d.file_name,
          page_no: pageNo,
          page_count: d.page_count,
          text: (page as { text: string } | null)?.text ?? '',
          signed_url: toSameOriginStorageUrl(signed.signedUrl),
          expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
        }
      },
    },
    {
      name: 'gnubok_propose_fact',
      keywords: ['arkiv', 'fakta', 'föreslå', 'rätta faktum'],
      title: 'Propose Fact',
      description:
        'Stage a company fact for a person to approve: subject, predicate from the controlled vocabulary, value, validity and the page it rests on. Stages for approval; the approved fact supersedes the old value and is reverted in one call.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subject_ref: { type: 'string', description: 'company:<company uuid>, agreement:<uuid> or party:<uuid>.' },
          predicate: { type: 'string', description: 'A predicate such as amount, ends_on, notice_months, vat_period or auditor.' },
          value: { type: ['string', 'number'], description: 'The value: dates as YYYY-MM-DD, amounts as numbers.' },
          valid_from: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          valid_to: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          rationale: { type: 'string', minLength: 1, maxLength: 1000, description: 'Why, in one or two sentences, for the reviewer.' },
          evidence: {
            type: ['object', 'null'],
            additionalProperties: false,
            properties: { document_id: { type: 'string' }, page: { type: ['integer', 'null'] }, quote: { type: ['string', 'null'] } },
            required: ['document_id'],
          },
        },
        required: ['subject_ref', 'predicate', 'value', 'rationale'],
      },
      outputSchema: deps.stagedSchema,
      annotations: deps.stagedWrite,
      // A rare write: reached through gnubok_search_tools and the briefing, off the default catalog.
      catalogVisibility: 'search',
      async execute(args, companyId, userId, supabase, actor) {
        assertEnabled(companyId)
        const subject = parseSubjectRef(args.subject_ref, companyId)
        const def = predicateDef(String(args.predicate ?? ''))
        if (!def) throw new Error(`unknown predicate; use one of ${Object.keys(PREDICATES).join(', ')}`)
        if (def.subject !== subject.kind) throw new Error(`predicate ${def.predicate} belongs to a ${def.subject}, not a ${subject.kind}`)
        const params = ArkivProposeFactParamsSchema.parse({
          subject_kind: subject.kind,
          subject_id: subject.id,
          predicate: def.predicate,
          value: args.value,
          valid_from: args.valid_from ?? null,
          valid_to: args.valid_to ?? null,
          rationale: args.rationale,
          evidence: args.evidence ?? null,
        })
        const current = await listLiveFacts(supabase, companyId, subject)
        const prior = current.find((f) => f.predicate === def.predicate)
        return deps.stage(
          supabase,
          companyId,
          userId,
          'arkiv_propose_fact',
          `Faktum: ${def.label} = ${String(params.value)}`,
          params,
          {
            predicate: def.label,
            value: params.value,
            prior_value: prior?.value ?? null,
            valid_from: params.valid_from ?? null,
            valid_to: params.valid_to ?? null,
            rationale: params.rationale,
            evidence: params.evidence ?? null,
          },
          actor,
        )
      },
    },
  ]
}

function parseSubjectRef(ref: unknown, companyId: string): { kind: FactSubjectKind; id: string } {
  if (typeof ref !== 'string') throw new Error('subject_ref must be company:<uuid>, agreement:<uuid> or party:<uuid>')
  const [kind, id] = ref.split(':')
  if (kind === 'company') {
    if (id !== companyId) throw new Error('subject_ref company must be the active company')
    return { kind: 'company', id: companyId }
  }
  if ((kind === 'agreement' || kind === 'party') && UUID.test(id ?? '')) return { kind, id }
  throw new Error('subject_ref must be company:<uuid>, agreement:<uuid> or party:<uuid>')
}

interface LinkView {
  from_ref: string
  record_ref: string
  relation: string
  basis: 'proven' | 'guessed'
  method: string
  title: string | null
}

async function linksOf(supabase: SupabaseClient, companyId: string, ref: { kind: RecordKind; id: string }): Promise<LinkView[]> {
  const from = recordRef(ref.kind, ref.id)
  const out: LinkView[] = []
  if (ref.kind === 'document') {
    const { data, error } = await supabase
      .from('document_links')
      .select('target_kind, target_id, basis, method')
      .eq('document_id', ref.id)
      .eq('company_id', companyId)
      .is('retired_at', null)
    if (error) throw dbError(error)
    for (const l of (data ?? []) as Array<{ target_kind: RecordKind; target_id: string; basis: 'proven' | 'guessed'; method: string }>) {
      out.push({
        from_ref: from,
        record_ref: recordRef(l.target_kind, l.target_id),
        relation: l.target_kind === 'party' ? 'counterparty' : l.target_kind === 'agreement' ? 'establishes' : 'concerns',
        basis: l.basis,
        method: l.method,
        title: null,
      })
    }
    const { data: doc, error: docError } = await supabase.from('document_attachments').select('journal_entry_id').eq('id', ref.id).eq('company_id', companyId).maybeSingle()
    if (docError) throw dbError(docError)
    const je = (doc as { journal_entry_id: string | null } | null)?.journal_entry_id
    if (je) out.push({ from_ref: from, record_ref: recordRef('journal_entry', je), relation: 'supports', basis: 'proven', method: 'attachment', title: null })
  } else if (ref.kind === 'agreement' || ref.kind === 'party') {
    const { data, error } =
      ref.kind === 'agreement'
        ? await supabase.from('document_links').select('document_id, basis, method').eq('agreement_id', ref.id).eq('company_id', companyId).is('retired_at', null).limit(100)
        : await supabase.from('document_links').select('document_id, basis, method').eq('party_id', ref.id).eq('company_id', companyId).is('retired_at', null).limit(100)
    if (error) throw dbError(error)
    for (const l of (data ?? []) as Array<{ document_id: string; basis: 'proven' | 'guessed'; method: string }>) {
      out.push({ from_ref: from, record_ref: recordRef('document', l.document_id), relation: 'documented_by', basis: l.basis, method: l.method, title: null })
    }
    if (ref.kind === 'agreement') {
      const { data: a, error: aError } = await supabase.from('agreements').select('counterparty_party_id, title').eq('id', ref.id).eq('company_id', companyId).maybeSingle()
      if (aError) throw dbError(aError)
      const party = (a as { counterparty_party_id: string | null; title: string } | null)?.counterparty_party_id
      if (party) out.push({ from_ref: from, record_ref: recordRef('party', party), relation: 'counterparty', basis: 'proven', method: 'derived', title: null })
    } else {
      const { data: agreements, error: agrError } = await supabase.from('agreements').select('id, title').eq('counterparty_party_id', ref.id).eq('company_id', companyId).limit(50)
      if (agrError) throw dbError(agrError)
      for (const a of (agreements ?? []) as Array<{ id: string; title: string }>)
        out.push({ from_ref: from, record_ref: recordRef('agreement', a.id), relation: 'party_to', basis: 'proven', method: 'derived', title: a.title })
    }
  } else if (ref.kind === 'journal_entry') {
    const { data, error } = await supabase.from('document_attachments').select('id, file_name').eq('journal_entry_id', ref.id).eq('company_id', companyId).limit(50)
    if (error) throw dbError(error)
    for (const d of (data ?? []) as Array<{ id: string; file_name: string }>)
      out.push({ from_ref: from, record_ref: recordRef('document', d.id), relation: 'supported_by', basis: 'proven', method: 'attachment', title: d.file_name })
  }
  return out
}
