import { describe, it, expect, vi, beforeEach } from 'vitest'

const generateStructured = vi.fn()
vi.mock('@/lib/ai', () => ({
  getAiService: () => ({ generateStructured }),
  getAiStatus: vi.fn(() => ({ configured: true })),
}))

import { classifyDocument, recordHumanClassification, buildClassifySystem, contentHash } from '../classify'
import { getAiStatus } from '@/lib/ai'

type Row = Record<string, unknown>
interface Scripted {
  document?: Row | null
  current?: Row | null
  pages?: Row[]
}
type Write = { table: string; op: 'insert' | 'update'; payload: Row; filters: Row }

/** A Supabase double: reads answer from the script, writes are recorded. */
function makeSupabase(script: Scripted) {
  const writes: Write[] = []
  const from = (table: string) => {
    const state: { op: string; payload?: Row; filters: Row } = { op: 'select', filters: {} }
    const api: Record<string, unknown> = {}
    const chain = () => api
    api.select = chain
    api.eq = (k: string, v: unknown) => { state.filters[k] = v; return api }
    api.is = chain
    api.not = chain
    api.neq = chain
    api.gt = chain
    // The duplicate check is the one chain that ends on limit(): it answers with the scripted twins.
    api.limit = () => (table === 'document_classifications' ? Promise.resolve({ data: script.duplicates ?? [], error: null }) : api)
    api.order = () => Promise.resolve({ data: table === 'document_pages' ? script.pages ?? [] : [], error: null })
    api.maybeSingle = () => {
      if (table === 'document_attachments') return Promise.resolve({ data: script.document ?? null, error: null })
      if (table === 'document_classifications') return Promise.resolve({ data: script.current ?? null, error: null })
      if (table === 'companies') return Promise.resolve({ data: { name: 'Exempelbolaget AB', org_number: '559000-0000' }, error: null })
      return Promise.resolve({ data: null, error: null })
    }
    api.update = (payload: Row) => { state.op = 'update'; state.payload = payload; return api }
    api.insert = (payload: Row) => { writes.push({ table, op: 'insert', payload, filters: {} }); return Promise.resolve({ error: null }) }
    // An update chain ends on its last .eq(): resolve when awaited.
    api.then = (resolve: (v: unknown) => void) => {
      if (state.op === 'update') writes.push({ table, op: 'update', payload: state.payload!, filters: state.filters })
      resolve({ error: null })
    }
    return api
  }
  return { supabase: { from } as never, writes }
}

const company = { name: 'Exempelbolaget AB', orgNumber: '559000-0000' }
const doc = { id: 'doc-1', company_id: 'co-1', file_name: 'hyresavtal.pdf', page_count: 4, admission_state: 'held' }
const answer = (over: Row = {}) => ({
  value: { doc_type: 'agreement.rental', confidence: 0.93, language: 'sv', is_multi_document: false, relevance: 'relevant', relevance_reason: 'Avtalet gäller bolagets lokal.', addressed_to: 'Exempelbolaget AB', summary: 'Hyresavtal för lokal.', suggested_type: null, ...over },
  model: 'haiku',
  usage: { inputTokens: 1, outputTokens: 1 },
})

describe('classifyDocument', () => {
  beforeEach(() => { vi.clearAllMocks(); (getAiStatus as ReturnType<typeof vi.fn>).mockReturnValue({ configured: true }) })

  it('classifies from the first and last page, retires the old row, admits a relevant document', async () => {
    generateStructured.mockResolvedValue(answer())
    const { supabase, writes } = makeSupabase({ document: doc, current: { id: 'c0', decided_by: 'model' }, pages: [{ page_no: 1, text: 'Hyresavtal' }, { page_no: 2, text: 'mitt' }, { page_no: 4, text: 'Underskrifter' }] })
    const out = await classifyDocument(supabase, 'doc-1', company)
    expect(out).toMatchObject({ status: 'classified', admission: 'admitted' })
    const call = generateStructured.mock.calls[0][0]
    expect(call.tier).toBe('cheap')
    expect(call.prompt).toContain('FIRST PAGE:\nHyresavtal')
    expect(call.prompt).toContain('LAST PAGE:\nUnderskrifter')
    expect(call.prompt).not.toContain('mitt')
    expect(writes.map((w) => `${w.table}:${w.op}`)).toEqual(['document_classifications:update', 'document_classifications:insert', 'document_attachments:update'])
    expect(writes[0].payload).toEqual({ is_current: false })
    expect(writes[1].payload).toMatchObject({ doc_type: 'agreement.rental', decided_by: 'model', is_current: true, model: 'haiku' })
    expect(writes[2].payload).toMatchObject({ doc_type: 'agreement.rental', admission_state: 'admitted' })
    expect(writes[2].payload).toHaveProperty('admitted_at')
  })

  it('stores authenticity signals and a content hash: a scan without text layer, a bundle, a twin already in the archive', async () => {
    generateStructured.mockResolvedValue(answer({ is_multi_document: true }))
    const long = 'Hyresavtal för lokal på Vasagatan 12 i Stockholm, undertecknat av båda parter.'
    const { supabase, writes } = makeSupabase({
      document: doc,
      pages: [{ page_no: 1, text: long, reader: 'claude_vision', has_text_layer: false }, { page_no: 2, text: 'Underskrifter', reader: 'claude_vision', has_text_layer: false }],
      duplicates: [{ document_id: 'doc-0' }],
    })
    await classifyDocument(supabase, 'doc-1', company)
    const inserted = writes.find((w) => w.table === 'document_classifications' && w.op === 'insert')!.payload
    expect(inserted.signals).toEqual(['no_text_layer', 'multi_document', 'duplicate_content'])
    expect(inserted.content_sha256).toEqual(contentHash([long, 'Underskrifter']))
    expect(contentHash(['short'])).toBeNull()
    expect(contentHash([`  ${long.toUpperCase()}  `])).toBe(contentHash([long]))

    const typed = makeSupabase({ document: doc, pages: [{ page_no: 1, text: long, reader: 'pdf_text', has_text_layer: true }] })
    generateStructured.mockResolvedValue(answer())
    await classifyDocument(typed.supabase, 'doc-1', company)
    expect(typed.writes.find((w) => w.table === 'document_classifications' && w.op === 'insert')!.payload.signals).toEqual([])
  })

  it('holds a document the model cannot tie to the company', async () => {
    generateStructured.mockResolvedValue(answer({ doc_type: 'receipt', relevance: 'ask', relevance_reason: 'Ingen koppling till bolaget syns.' }))
    const { supabase, writes } = makeSupabase({ document: { ...doc, admission_state: 'held' }, pages: [{ page_no: 1, text: 'Kvitto' }] })
    const out = await classifyDocument(supabase, 'doc-1', company)
    expect(out).toMatchObject({ status: 'classified', admission: 'held' })
    expect(writes.at(-1)!.payload).toMatchObject({ admission_state: 'held' })
    expect(writes.at(-1)!.payload).not.toHaveProperty('admitted_at')
  })

  it('never puts a document a person already admitted back on hold', async () => {
    generateStructured.mockResolvedValue(answer({ relevance: 'ask' }))
    const { supabase, writes } = makeSupabase({ document: { ...doc, admission_state: 'admitted' }, pages: [{ page_no: 1, text: 'x' }] })
    const out = await classifyDocument(supabase, 'doc-1', company)
    expect(out).toMatchObject({ status: 'classified', admission: 'admitted' })
    expect(writes.at(-1)!.payload).toMatchObject({ admission_state: 'admitted' })
  })

  it('skips when a person already decided, when there are no pages, and when no model is configured', async () => {
    const human = makeSupabase({ document: doc, current: { id: 'c1', decided_by: 'human' }, pages: [{ page_no: 1, text: 'x' }] })
    expect(await classifyDocument(human.supabase, 'doc-1', company)).toEqual({ status: 'skipped', reason: 'human_decided' })
    const empty = makeSupabase({ document: doc, pages: [] })
    expect(await classifyDocument(empty.supabase, 'doc-1', company)).toEqual({ status: 'skipped', reason: 'no_pages' })
    ;(getAiStatus as ReturnType<typeof vi.fn>).mockReturnValue({ configured: false })
    expect(await classifyDocument(makeSupabase({ document: doc }).supabase, 'doc-1', company)).toEqual({ status: 'skipped', reason: 'ai_unconfigured' })
    expect(generateStructured).not.toHaveBeenCalled()
  })

  it('reports a schema mismatch instead of storing it', async () => {
    generateStructured.mockResolvedValue({ value: { doc_type: 'spaceship', confidence: 2 }, model: 'haiku', usage: {} })
    const { supabase, writes } = makeSupabase({ document: doc, pages: [{ page_no: 1, text: 'x' }] })
    const out = await classifyDocument(supabase, 'doc-1', company)
    expect(out.status).toBe('error')
    expect(writes).toEqual([])
  })

  it('puts the company identity and every taxonomy entry in the system prompt', () => {
    const system = buildClassifySystem({ name: 'Arcim Technology AB', orgNumber: '559538-6219', formerNames: ['Startplattan 990650 AB'] })
    expect(system).toContain('Arcim Technology AB (organisationsnummer 559538-6219)')
    expect(system).toContain('formerly named Startplattan 990650 AB')
    expect(system).toContain('- agreement.loan:')
    expect(system).toContain('- decision.skatteverket:')
  })
})

describe('recordHumanClassification', () => {
  it('stores a human decision as the current classification and admits the document', async () => {
    const { supabase, writes } = makeSupabase({ document: { ...doc, admission_state: 'held' }, current: { summary: 'Kvitto från restaurang.', language: 'sv', addressed_to: null, is_multi_document: false } })
    const out = await recordHumanClassification(supabase, 'doc-1', 'user-1', { docType: 'receipt', relevance: 'relevant', reason: 'Lunch med kund' })
    expect(out).toMatchObject({ status: 'classified', admission: 'admitted' })
    expect(writes[1].payload).toMatchObject({ decided_by: 'human', decided_by_user_id: 'user-1', confidence: 1, doc_type: 'receipt', summary: 'Kvitto från restaurang.', relevance_reason: 'Lunch med kund' })
    expect(writes[2].payload).toMatchObject({ admission_state: 'admitted', admission_reason: 'Lunch med kund' })
  })
})
