import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
vi.mock('@/lib/arkiv/ask', () => ({ askDocument: vi.fn() }))
import { tools } from '../server'
import { parseRecordRef } from '../arkiv-tools'

const mock = createQueuedMockSupabase()
const { enqueue, reset } = mock
const supabase = mock.supabase as unknown as SupabaseClient
const rpc = mock.supabase.rpc

const NAMES = ['gnubok_search_records', 'gnubok_get_record', 'gnubok_get_record_links', 'gnubok_get_fact_history', 'gnubok_get_source', 'gnubok_propose_fact']
const tool = (name: string) => tools.find((t) => t.name === name)!
const CO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const AGR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const JE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

beforeEach(() => {
  reset()
  rpc.mockClear()
  process.env.ARKIV_COMPANY_IDS = CO
})

afterEach(() => {
  delete process.env.ARKIV_COMPANY_IDS
})

describe('Arkiv tools', () => {
  it('registers six tools, five read-only and one staging, with qualified ids and strict schemas', () => {
    for (const name of NAMES) {
      const t = tool(name)
      expect(t, name).toBeDefined()
      expect((t.inputSchema as { additionalProperties: boolean }).additionalProperties).toBe(false)
      expect(t.description.length).toBeLessThanOrEqual(280)
    }
    expect(tool('gnubok_propose_fact').annotations.readOnlyHint).toBe(false)
    expect(tool('gnubok_propose_fact').description).toMatch(/stage/i)
    expect(tool('gnubok_get_source').catalogVisibility).toBe('search')
  })

  it('parses record refs strictly', () => {
    expect(parseRecordRef(`document:${DOC}`)).toEqual({ kind: 'document', id: DOC })
    expect(() => parseRecordRef('invoice:' + DOC)).toThrow(/record_ref/)
    expect(() => parseRecordRef('document:nope')).toThrow(/record_ref/)
  })

  it('refuses every tool outside the rollout', async () => {
    process.env.ARKIV_COMPANY_IDS = 'someone-else'
    await expect(tool('gnubok_search_records').execute({ query: 'hyra' }, CO, 'user-1', supabase)).rejects.toThrow(/not enabled/)
  })

  it('search_records combines page hits, agreements and facts into record refs', async () => {
    enqueue({ data: [{ document_id: DOC, page_no: 2, file_name: 'hyresavtal.pdf', headline: 'Hyran uppgår till' }] })
    enqueue({ data: [{ id: AGR, title: 'Hyresavtal Vasagatan 12', counterparty_name: 'Kvarnen AB', kind: 'rental', ends_on: '2028-12-31' }] })
    enqueue({ data: [{ id: 'f1', predicate: 'amount', value_text: '12500', subject_kind: 'agreement', subject_id: AGR, source_document_id: DOC }] })
    const out = (await tool('gnubok_search_records').execute({ query: 'hyra' }, CO, 'user-1', supabase)) as { items: Array<{ record_ref: string; kind: string; page: number | null }>; count: number }
    expect(out.count).toBe(3)
    expect(out.items.map((i) => [i.kind, i.record_ref, i.page])).toEqual([
      ['document', `document:${DOC}`, 2],
      ['agreement', `agreement:${AGR}`, null],
      ['fact', 'fact:f1', null],
    ])
    expect(rpc).toHaveBeenCalledWith('search_document_pages', { p_company_id: CO, p_query: 'hyra', p_limit: 10 })
  })

  it('get_record returns a document with its fields, links and agreement', async () => {
    enqueue({ data: { id: DOC, file_name: 'hyresavtal.pdf', created_at: '2026-09-15', doc_type: 'agreement.rental', admission_state: 'admitted', page_count: 4, journal_entry_id: null } })
    enqueue({ data: { id: 'ext-1', schema_type: 'agreement.rental', schema_version: 1, pass: 'consensus', payload: { monthly_rent: { value: 12500, normalized: 12500, page: 2, quote: 'Hyran', confidence: 1, method: 'consensus' } }, review_fields: [], created_at: '2026-09-15' } })
    enqueue({ data: [{ id: 'l1', target_kind: 'party', target_id: 'p1', basis: 'proven', method: 'org_number', confidence: 1 }] })
    enqueue({ data: { id: AGR, kind: 'rental', title: 'Hyresavtal' } })
    const out = (await tool('gnubok_get_record').execute({ record_ref: `document:${DOC}` }, CO, 'user-1', supabase)) as { kind: string; document: { record: { fields: Array<{ field: string; page: number }> }; links: Array<{ record_ref: string }>; agreement_ref: string } }
    expect(out.kind).toBe('document')
    expect(out.document.record.fields).toEqual([{ field: 'monthly_rent', value: 12500, page: 2, quote: 'Hyran', confidence: 1, under_review: false }])
    expect(out.document.links).toEqual([{ link_id: 'l1', record_ref: 'party:p1', basis: 'proven', method: 'org_number', confidence: 1 }])
    expect(out.document.agreement_ref).toBe(`agreement:${AGR}`)
  })

  it('get_record on a journal entry returns every attachment as a record', async () => {
    enqueue({ data: { id: JE, voucher_series: 'A', voucher_number: 12, entry_date: '2026-09-01', description: 'Hyra september' } })
    enqueue({ data: [{ id: DOC }] })
    enqueue({ data: { id: DOC, file_name: 'faktura.pdf', created_at: '2026-09-01', doc_type: 'supplier_invoice', admission_state: 'admitted', page_count: 1, journal_entry_id: JE } })
    enqueue({ data: { id: 'ext-2', schema_type: 'generic', schema_version: 1, pass: 'consensus', payload: { total_amount: { value: 12500, normalized: 12500, page: 1, quote: 'Att betala 12 500', confidence: 1, method: 'consensus' } }, review_fields: [], created_at: '2026-09-01' } })
    enqueue({ data: [] })
    enqueue({ data: null })
    const out = (await tool('gnubok_get_record').execute({ record_ref: `journal_entry:${JE}` }, CO, 'user-1', supabase)) as { journal_entry: { voucher: string; documents: Array<{ document_id: string; record: { fields: Array<{ field: string }> } }> } }
    expect(out.journal_entry.voucher).toBe('A12')
    expect(out.journal_entry.documents).toHaveLength(1)
    expect(out.journal_entry.documents[0].record.fields[0]).toMatchObject({ field: 'total_amount', value: 12500, page: 1 })
  })

  it('get_record reports a missing record', async () => {
    enqueue({ data: null })
    await expect(tool('gnubok_get_record').execute({ record_ref: `party:${AGR}` }, CO, 'user-1', supabase)).rejects.toThrow('Record not found')
  })

  it('get_fact_history needs a subject of the active company and a known predicate', async () => {
    await expect(tool('gnubok_get_fact_history').execute({ subject_ref: `company:${DOC}` }, CO, 'user-1', supabase)).rejects.toThrow(/active company/)
    await expect(tool('gnubok_get_fact_history').execute({ subject_ref: `company:${CO}`, predicate: 'shoe_size' }, CO, 'user-1', supabase)).rejects.toThrow(/unknown predicate/)
    enqueue({ data: [{ id: 'f1', subject_kind: 'company', subject_id: CO, predicate: 'vat_period', value: 'kvartal', valid_from: null, valid_to: null, sys_from: '2026-09-15', sys_to: null, rank: 'normal', status: 'confirmed', source_kind: 'extraction', source_document_id: DOC, sources: [], supersedes_id: null }] })
    const out = (await tool('gnubok_get_fact_history').execute({ subject_ref: `company:${CO}`, predicate: 'vat_period' }, CO, 'user-1', supabase)) as { facts: Array<{ fact_id: string; label: string; subject_ref: string }> }
    expect(out.facts).toEqual([expect.objectContaining({ fact_id: 'f1', label: 'Momsperiod', subject_ref: `company:${CO}` })])
  })

  it('get_source returns the page text and a signed url', async () => {
    enqueue({ data: { id: DOC, file_name: 'hyresavtal.pdf', storage_path: 'documents/x.pdf', page_count: 4 } })
    enqueue({ data: { text: 'Hyran uppgår till 12 500 kr' } })
    const out = (await tool('gnubok_get_source').execute({ document_id: DOC, page: 2 }, CO, 'user-1', supabase)) as { page_no: number; text: string; signed_url: string }
    expect(out).toMatchObject({ page_no: 2, text: 'Hyran uppgår till 12 500 kr' })
    expect(out.signed_url).toContain('signed')
  })

  it('propose_fact validates the predicate against its subject and stages the proposal with the prior value', async () => {
    await expect(tool('gnubok_propose_fact').execute({ subject_ref: `company:${CO}`, predicate: 'amount', value: 1, rationale: 'x' }, CO, 'user-1', supabase)).rejects.toThrow(/belongs to a agreement/)
    enqueue({ data: [{ id: 'f1', predicate: 'vat_period', value: 'helt beskattningsår', subject_kind: 'company', subject_id: CO, sys_from: '2026-09-15', sys_to: null, rank: 'normal', status: 'confirmed', source_kind: 'extraction', sources: [] }] })
    const stage = vi.fn(async () => ({ staged: true, risk_level: 'low', actor: { type: 'user' }, message: 'ok', preview: {} }))
    const factory = (await import('../arkiv-tools')).createArkivTools({ readOnly: tool('gnubok_get_source').annotations, stagedWrite: tool('gnubok_propose_fact').annotations, stagedSchema: {}, stage })
    const propose = factory.find((t) => t.name === 'gnubok_propose_fact')!
    const out = await propose.execute({ subject_ref: `company:${CO}`, predicate: 'vat_period', value: 'kvartal', rationale: 'Beslutet från Skatteverket säger kvartal.', evidence: { document_id: DOC, page: 1, quote: 'redovisningsperiod kvartal' } }, CO, 'user-1', supabase, { type: 'user' })
    expect(out).toMatchObject({ staged: true })
    expect(stage).toHaveBeenCalledWith(supabase, CO, 'user-1', 'arkiv_propose_fact', 'Faktum: Momsperiod = kvartal', expect.objectContaining({ subject_kind: 'company', subject_id: CO, predicate: 'vat_period', value: 'kvartal' }), expect.objectContaining({ predicate: 'Momsperiod', value: 'kvartal', prior_value: 'helt beskattningsår' }), { type: 'user' })
  })
})

describe('gnubok_ask_document', () => {
  it('asks the reader one question about one document and returns the cited answer', async () => {
    const { askDocument } = await import('@/lib/arkiv/ask')
    ;(askDocument as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'answered',
      answer: 'Tre månader',
      page: 2,
      quote: 'tre (3) månaders uppsägningstid',
      quote_verified: true,
      confidence: 0.9,
      pages_read: [1, 2],
      page_count: 2,
      not_found: false,
    })
    enqueue({ data: { name: 'Arcim Technology AB' } })
    const out = await tool('gnubok_ask_document').execute({ record_ref: `document:${DOC}`, question: 'Vad är uppsägningstiden?' }, CO, 'user-1', supabase)
    expect(out).toEqual({
      record_ref: `document:${DOC}`,
      question: 'Vad är uppsägningstiden?',
      answer: 'Tre månader',
      not_found: false,
      page: 2,
      quote: 'tre (3) månaders uppsägningstid',
      quote_verified: true,
      confidence: 0.9,
      pages_read: [1, 2],
      page_count: 2,
    })
    expect(askDocument).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        companyId: CO,
        documentId: DOC,
        question: 'Vad är uppsägningstiden?',
        company: { name: 'Arcim Technology AB' },
        askedBy: { agentName: 'mcp.ask', agentVersion: '1' },
      }),
    )
    expect((askDocument as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]).not.toHaveProperty('pages')
    enqueue({ data: { name: 'Arcim Technology AB' } })
    await tool('gnubok_ask_document').execute(
      {
        record_ref: `document:${DOC}`,
        question: 'Vad är uppsägningstiden?',
        pages: [23, 24, 24, 0],
      },
      CO,
      'user-1',
      supabase,
    )
    expect(askDocument).toHaveBeenLastCalledWith(supabase, expect.objectContaining({ pages: [23, 24] }))
  })

  it('refuses anything but a document ref and turns a missing document into a plain error', async () => {
    const { askDocument } = await import('@/lib/arkiv/ask')
    await expect(tool('gnubok_ask_document').execute({ record_ref: `agreement:${DOC}`, question: 'x?' }, CO, 'user-1', supabase)).rejects.toThrow(/document:<uuid>/)
    ;(askDocument as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'skipped',
      reason: 'not_found',
    })
    enqueue({ data: { name: 'Arcim' } })
    await expect(tool('gnubok_ask_document').execute({ record_ref: `document:${DOC}`, question: 'Vad?' }, CO, 'user-1', supabase)).rejects.toThrow(/No such document/)
  })
})

describe('gnubok_resolve_missing', () => {
  const FINDING = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

  it('closes an open item as dismissed with the note, remembered for the lint', async () => {
    enqueue({ data: { id: FINDING, detail: { rule: 'loan', expected_type: 'agreement.loan' } } })
    enqueue({})
    const out = await tool('gnubok_resolve_missing').execute({ finding_id: FINDING, resolution: 'not_applicable' }, CO, 'user-1', supabase)
    expect(out).toEqual({ finding_id: FINDING, status: 'dismissed', note: 'not_applicable' })
    expect(JSON.stringify(mock.findCalls('arkiv_findings', 'update'))).toContain('"resolution_note":"not_applicable"')
  })

  it('resolves an uploaded item with the document it was closed by, and refuses what it cannot find', async () => {
    enqueue({ data: { id: FINDING, detail: { rule: 'loan' } } })
    enqueue({})
    const out = await tool('gnubok_resolve_missing').execute({ finding_id: FINDING, resolution: 'uploaded', document_ref: `document:${DOC}` }, CO, 'user-1', supabase)
    expect(out).toEqual({ finding_id: FINDING, status: 'resolved', note: 'uploaded' })
    expect(JSON.stringify(mock.findCalls('arkiv_findings', 'update'))).toContain(`"resolved_document_id":"${DOC}"`)
    enqueue({ data: null })
    await expect(tool('gnubok_resolve_missing').execute({ finding_id: FINDING, resolution: 'not_exists' }, CO, 'user-1', supabase)).rejects.toThrow(/No open missing-document item/)
    await expect(tool('gnubok_resolve_missing').execute({ finding_id: 'nope', resolution: 'not_exists' }, CO, 'user-1', supabase)).rejects.toThrow(/uuid/)
  })
})
