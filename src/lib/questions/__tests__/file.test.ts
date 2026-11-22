import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { evidenceFingerprint, fileQuestion, type FileQuestionInput } from '../file'
import { QUESTION_LIMITS } from '../types'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const USER = 'a0000000-0000-4000-8000-000000000001'
const TX = '10000000-0000-4000-8000-000000000001'
const TX_2 = '10000000-0000-4000-8000-000000000002'
const QUESTION_ID = 'e0000000-0000-4000-8000-000000000001'

const row = (overrides: Record<string, unknown> = {}) => ({
  id: QUESTION_ID,
  status: 'open',
  close_reason: null,
  question: 'Leverantören drog 4 990 kr den 3 november, mot 2 195 kr tidigare. Vad har ändrats?',
  why: null,
  options: [
    { id: 'more', label: 'Fler licenser' },
    { id: 'annual', label: 'Årsbetalning' },
  ],
  evidence: [
    { kind: 'transaction', id: TX },
    { kind: 'transaction', id: TX_2 },
  ],
  actor_label: 'Claude',
  client: 'claude',
  answer_option: null,
  answer_text: null,
  answered_at: null,
  answered_via: null,
  fact_id: null,
  created_at: '2026-11-19T08:00:00.000Z',
  ...overrides,
})

/** company_questions answered by what the chain asks: the duplicate read, the two counts, the insert. */
function questionsTable(state: {
  existing?: { id: string; status: string } | null
  open?: number
  filed?: number
  insertError?: { code: string; message: string }
  afterRace?: { id: string; status: string }
} = {}): TableMockResolver {
  let duplicateReads = 0
  return (calls) => {
    const methods = calls.map((c) => c.method)
    if (methods.includes('insert')) return state.insertError ? { error: state.insertError } : { data: row() }
    if (methods.includes('maybeSingle')) {
      duplicateReads += 1
      return { data: duplicateReads > 1 && state.afterRace ? state.afterRace : (state.existing ?? null) }
    }
    const countsOpen = calls.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'open')
    return { count: countsOpen ? (state.open ?? 0) : (state.filed ?? 0) }
  }
}

const transactions = {
  data: [
    { id: TX, amount: -4990, amount_sek: -4990, instructed_amount: null },
    { id: TX_2, amount: -2195, amount_sek: -2195, instructed_amount: null },
  ],
}

const input = (overrides: Partial<FileQuestionInput> = {}): FileQuestionInput => ({
  companyId: COMPANY,
  question: 'Leverantören drog 4 990 kr den 3 november, mot 2 195 kr tidigare. Vad har ändrats?',
  options: [
    { id: 'more', label: 'Fler licenser' },
    { id: 'annual', label: 'Årsbetalning' },
  ],
  evidence: [
    { kind: 'transaction', id: TX },
    { kind: 'transaction', id: TX_2 },
  ],
  userId: USER,
  actor: { type: 'mcp_oauth', id: 'key-1', label: 'Claude', client: 'claude' },
  ...overrides,
})

describe('fileQuestion', () => {
  beforeEach(() => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', COMPANY)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('files a question that passes every check, with who filed it', async () => {
    const mock = createTableMockSupabase({ company_questions: questionsTable(), transactions })
    const filed = await fileQuestion(mock.supabase as never, input({ why: '  Det avgör hur raden bokförs.  ' }))

    expect(filed).toMatchObject({ question_id: QUESTION_ID, status: 'open', asked_by: 'Claude', client: 'claude' })
    expect(mock.payloads('company_questions', 'insert')).toEqual([
      {
        company_id: COMPANY,
        status: 'open',
        question: 'Leverantören drog 4 990 kr den 3 november, mot 2 195 kr tidigare. Vad har ändrats?',
        why: 'Det avgör hur raden bokförs.',
        options: [
          { id: 'more', label: 'Fler licenser' },
          { id: 'annual', label: 'Årsbetalning' },
        ],
        evidence: [
          { kind: 'transaction', id: TX },
          { kind: 'transaction', id: TX_2 },
        ],
        fingerprint: evidenceFingerprint([
          { kind: 'transaction', id: TX_2 },
          { kind: 'transaction', id: TX },
        ]),
        created_by_user_id: USER,
        actor_type: 'mcp_oauth',
        actor_id: 'key-1',
        actor_label: 'Claude',
        client: 'claude',
      },
    ])
  })

  it('files without an actor, and keeps a long label within its column', async () => {
    const mock = createTableMockSupabase({ company_questions: questionsTable(), transactions })
    await fileQuestion(mock.supabase as never, input({ actor: null, userId: null }))
    expect(mock.payloads('company_questions', 'insert')[0]).toMatchObject({
      created_by_user_id: null,
      actor_type: null,
      actor_id: null,
      actor_label: null,
      client: null,
    })

    const long = createTableMockSupabase({ company_questions: questionsTable(), transactions })
    await fileQuestion(long.supabase as never, input({ actor: { type: 'api_key', id: 'key-1', label: 'n'.repeat(300), client: '' } }))
    const [payload] = long.payloads('company_questions', 'insert') as Array<{ actor_label: string; client: string | null }>
    expect(payload.actor_label).toHaveLength(200)
    expect(payload.client).toBeNull()
  })

  it('refuses while the list is not switched on for the company, before reading anything', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', 'another-company')
    const mock = createTableMockSupabase()
    await expect(fileQuestion(mock.supabase as never, input())).rejects.toMatchObject({ code: 'COMPANY_QUESTIONS_OFF' })
    expect(mock.tables()).toEqual([])
  })

  describe('the text', () => {
    it.each([
      ['a missing question', { question: '   ' }, 'question is required'],
      ['a question over the limit', { question: 'a'.repeat(QUESTION_LIMITS.maxText + 1) }, 'question is 501 characters; at most 500'],
      ['a why over the limit', { why: 'a'.repeat(QUESTION_LIMITS.maxText + 1) }, 'why is 501 characters; at most 500'],
      ['a question that is not text', { question: 42 }, 'question must be a string'],
    ])('refuses %s', async (_name, overrides, message) => {
      const mock = createTableMockSupabase()
      await expect(fileQuestion(mock.supabase as never, input(overrides))).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message })
      expect(mock.tables()).toEqual([])
    })
  })

  describe('the options', () => {
    it('takes none', async () => {
      const mock = createTableMockSupabase({ company_questions: questionsTable(), transactions })
      await fileQuestion(mock.supabase as never, input({ options: undefined }))
      expect(mock.payloads('company_questions', 'insert')[0]).toMatchObject({ options: [] })
    })

    it.each([
      ['more than three', [1, 2, 3, 4].map((n) => ({ id: `o${n}`, label: `Val ${n}` })), '4 options; at most 3'],
      ['a label over twenty characters', [{ id: 'a', label: 'a'.repeat(21) }], 'options.0.label must be 1 to 20 characters'],
      ['an empty label', [{ id: 'a', label: ' ' }], 'options.0.label must be 1 to 20 characters'],
      ['a missing id', [{ label: 'Ja' }], 'options.0.id must be 1 to 40 characters'],
      ['the same id twice', [{ id: 'a', label: 'Ja' }, { id: 'a', label: 'Nej' }], 'option id "a" is used twice'],
      ['something that is not a list', 'yes or no', 'options must be an array'],
    ])('refuses %s', async (_name, options, message) => {
      const mock = createTableMockSupabase()
      await expect(fileQuestion(mock.supabase as never, input({ options }))).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message })
      expect(mock.tables()).toEqual([])
    })
  })

  describe('the evidence', () => {
    it.each([
      ['none', [], 'evidence is required: at least one record the question rests on'],
      ['a missing list', undefined, 'evidence is required: at least one record the question rests on'],
      ['more than eight', Array.from({ length: 9 }, (_, i) => ({ kind: 'transaction', id: `10000000-0000-4000-8000-00000000000${i}` })), '9 evidence references; at most 8'],
      ['an unknown kind', [{ kind: 'receipt', id: TX }], 'evidence.0.kind must be one of transaction, journal_entry, document, invoice, supplier_invoice, fact, account'],
      ['a missing id', [{ kind: 'transaction' }], 'evidence.0.id is required'],
    ])('refuses %s', async (_name, evidence, message) => {
      const mock = createTableMockSupabase()
      await expect(fileQuestion(mock.supabase as never, input({ evidence }))).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message })
      expect(mock.tables()).toEqual([])
    })

    it('refuses the whole question when a reference names no record of the company, and names it', async () => {
      const mock = createTableMockSupabase({
        company_questions: questionsTable(),
        transactions: { data: [transactions.data[0]] },
      })
      const refusal = await fileQuestion(mock.supabase as never, input()).catch((e) => e)
      expect(refusal).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: `Evidence not found: evidence.1: no transaction ${TX_2} in this company`,
        issues: [{ field: 'evidence.1', message: `Underlaget transaction ${TX_2} finns inte i företaget.` }],
      })
      expect(mock.findCalls('company_questions', 'insert')).toEqual([])
    })

    it('reads the same reference once, whatever its case', async () => {
      const mock = createTableMockSupabase({ company_questions: questionsTable(), transactions })
      await fileQuestion(
        mock.supabase as never,
        input({
          evidence: [
            { kind: 'transaction', id: TX.toUpperCase() },
            { kind: 'transaction', id: TX },
            { kind: 'transaction', id: TX_2 },
          ],
        }),
      )
      expect(mock.payloads('company_questions', 'insert')[0]).toMatchObject({
        evidence: [
          { kind: 'transaction', id: TX },
          { kind: 'transaction', id: TX_2 },
        ],
      })
    })
  })

  describe('the amounts', () => {
    it('refuses an amount that stands on none of the records, and lists it', async () => {
      const mock = createTableMockSupabase({ company_questions: questionsTable(), transactions })
      const refusal = await fileQuestion(
        mock.supabase as never,
        input({ question: 'Leverantören drog 4 990 kr, mot 2 195 kr tidigare.', why: 'Skillnaden är 2 795 kr och årskostnaden 59 880 kr.' }),
      ).catch((e) => e)
      expect(refusal).toMatchObject({ code: 'VALIDATION_ERROR' })
      expect(refusal.message).toContain('the amount "2 795 kr" is on none of the evidence records')
      expect(refusal.message).toContain('the amount "59 880 kr" is on none of the evidence records')
      expect(refusal.message).not.toContain('"4 990 kr"')
      expect(mock.findCalls('company_questions', 'insert')).toEqual([])
    })

    it('takes a question without amounts', async () => {
      const mock = createTableMockSupabase({ company_questions: questionsTable(), transactions })
      await expect(fileQuestion(mock.supabase as never, input({ question: 'Finns det ett skriftligt avtal?' }))).resolves.toMatchObject({
        question_id: QUESTION_ID,
      })
    })
  })

  describe('the limits', () => {
    it('refuses when five questions are open', async () => {
      const mock = createTableMockSupabase({ company_questions: questionsTable({ open: QUESTION_LIMITS.maxOpen }), transactions })
      const refusal = await fileQuestion(mock.supabase as never, input()).catch((e) => e)
      expect(refusal).toMatchObject({ code: 'COMPANY_QUESTION_LIMIT_REACHED' })
      expect(refusal.message).toContain('5 questions are open')
      expect(mock.findCalls('company_questions', 'insert')).toEqual([])
    })

    it('refuses when three were filed in the last 24 hours', async () => {
      const mock = createTableMockSupabase({ company_questions: questionsTable({ open: 2, filed: QUESTION_LIMITS.maxFiledPerDay }), transactions })
      const before = Date.now()
      const refusal = await fileQuestion(mock.supabase as never, input()).catch((e) => e)
      expect(refusal).toMatchObject({ code: 'COMPANY_QUESTION_LIMIT_REACHED' })
      expect(refusal.message).toContain('3 questions were filed')
      const since = new Date(mock.findCall('company_questions', 'gte')![1] as string).getTime()
      expect(before - since).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000)
      expect(before - since).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000)
      expect(mock.findCalls('company_questions', 'insert')).toEqual([])
    })

    it('files below both', async () => {
      const mock = createTableMockSupabase({
        company_questions: questionsTable({ open: QUESTION_LIMITS.maxOpen - 1, filed: QUESTION_LIMITS.maxFiledPerDay - 1 }),
        transactions,
      })
      await expect(fileQuestion(mock.supabase as never, input())).resolves.toMatchObject({ question_id: QUESTION_ID })
    })
  })

  describe('never twice', () => {
    it('refuses a question on the same records, whatever became of the earlier one, before reading the records', async () => {
      const mock = createTableMockSupabase({ company_questions: questionsTable({ existing: { id: QUESTION_ID, status: 'closed' } }) })
      const refusal = await fileQuestion(mock.supabase as never, input()).catch((e) => e)
      expect(refusal).toMatchObject({ code: 'COMPANY_QUESTION_ALREADY_ASKED' })
      expect(refusal.message).toBe(`Already asked: question ${QUESTION_ID} (closed) rests on the same records. A question is put once.`)
      expect(mock.tables()).toEqual(['company_questions'])
      expect(mock.findCalls('company_questions', 'eq')).toContainEqual(['fingerprint', evidenceFingerprint(input().evidence as never)])
    })

    it('answers the same when another filer wins the race', async () => {
      const mock = createTableMockSupabase({
        company_questions: questionsTable({
          insertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
          afterRace: { id: QUESTION_ID, status: 'open' },
        }),
        transactions,
      })
      await expect(fileQuestion(mock.supabase as never, input())).rejects.toMatchObject({ code: 'COMPANY_QUESTION_ALREADY_ASKED' })
    })

    it('gives the same fingerprint in any order, and another for other records', () => {
      const a = { kind: 'transaction' as const, id: TX }
      const b = { kind: 'journal_entry' as const, id: TX_2 }
      expect(evidenceFingerprint([a, b])).toBe(evidenceFingerprint([b, a]))
      expect(evidenceFingerprint([a, b])).toMatch(/^[0-9a-f]{64}$/)
      expect(evidenceFingerprint([a])).not.toBe(evidenceFingerprint([a, b]))
      expect(evidenceFingerprint([{ kind: 'invoice', id: TX }])).not.toBe(evidenceFingerprint([a]))
    })
  })

  it('passes a failed write on with its database code', async () => {
    const mock = createTableMockSupabase({
      company_questions: questionsTable({ insertError: { code: '57014', message: 'canceling statement due to statement timeout' } }),
      transactions,
    })
    await expect(fileQuestion(mock.supabase as never, input())).rejects.toMatchObject({ code: '57014' })
  })
})
