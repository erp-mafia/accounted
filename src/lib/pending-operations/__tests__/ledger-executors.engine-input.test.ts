/**
 * Posting port, step 2i: what the staged voucher executors hand the engine
 * and the storno service when a person approves an agent's staged operation
 * (commitPendingOperation), recorded call by call and compared with a
 * committed fixture (ledger-executors.engine-input.json) that was taken
 * before the executors went through the port:
 *
 *   create_voucher   createJournalEntry (a manual voucher, an IB, a kvitto
 *                    from the inbox; a lost inbox claim reverses the voucher
 *                    with reverseEntry)
 *   correct_entry    correctEntry
 *   reverse_entry    reverseEntry
 *   redate_entry     recordateEntry (the operation journal-entries.redate)
 *
 * Every argument is recorded, an absent one as '<undefined>'; trailing
 * undefined arguments are dropped before the comparison.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/pending-operations/__tests__/ledger-executors.engine-input.test.ts
 *
 * Since the executors go through the posting port, the scenarios also run
 * with POSTING_EVENTS=shadow and strict: the off calls plus only the event
 * links, a refused event write still books under shadow, and under strict
 * every executor stops before the engine. Every event names the approval:
 * agent_proposed_user_approved with the operation as evidence and as its
 * pending operation.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { callsWithoutEventLinks, eventLinksOf, roleForKind } from '@/tests/engine-input'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: vi.fn(),
  reverseEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
}))
vi.mock('@/lib/core/bookkeeping/storno-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/bookkeeping/storno-service')>()),
  correctEntry: vi.fn(),
  recordateEntry: vi.fn(),
}))
vi.mock('@/lib/core/bookkeeping/period-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/bookkeeping/period-service')>()),
  resolvePeriodStatusForDate: vi.fn().mockResolvedValue({ status: 'open', period_id: '00000000-0000-4000-8000-00000000f001', lock_date: null }),
}))
vi.mock('@/lib/core/documents/document-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/documents/document-service')>()),
  linkToJournalEntry: vi.fn(),
}))

const { createJournalEntry, reverseEntry, findFiscalPeriod } = await import('@/lib/bookkeeping/engine')
const { correctEntry, recordateEntry } = await import('@/lib/core/bookkeeping/storno-service')
const { linkToJournalEntry } = await import('@/lib/core/documents/document-service')
const { AccountsNotInChartError, CannotReverseNonPostedError, MeaninglessCorrectionError } = await import('@/lib/bookkeeping/errors')
const { commitPendingOperation } = await import('../commit')

const FIXTURE = path.join(__dirname, 'ledger-executors.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'
const INBOX_ITEM = '00000000-0000-4000-8000-00000000b001'
const DOCUMENT = '00000000-0000-4000-8000-00000000d001'
const ORIGINAL = '00000000-0000-4000-8000-00000000e100'

const ENGINE = {
  createJournalEntry: vi.mocked(createJournalEntry),
  reverseEntry: vi.mocked(reverseEntry),
  correctEntry: vi.mocked(correctEntry),
  recordateEntry: vi.mocked(recordateEntry),
}

function opId(index: number): string {
  return `00000000-0000-4000-8000-0000000c${String(index + 1).padStart(4, '0')}`
}

function entryId(index: number): string {
  return `00000000-0000-4000-8000-0000000e${String(index + 1).padStart(4, '0')}`
}

const LINES = [
  { account_number: '5410', debit_amount: 800, credit_amount: 0, line_description: 'Skärm' },
  { account_number: '2641', debit_amount: 200, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
]

interface Scenario {
  name: string
  type: PendingOperation['operation_type']
  params: Record<string, unknown>
  /** Per-table answers beside the claim (the executor's own reads and writes). */
  tables?: Record<string, TableMockResult | TableMockResult[]>
  /** The engine or storno service refuses. */
  refuse?: boolean
}

const POSTED_ORIGINAL = {
  data: {
    id: ORIGINAL,
    status: 'posted',
    entry_date: '2026-03-10',
    fiscal_period_id: PERIOD,
    fiscal_periods: { is_closed: false, locked_at: null },
  },
}

const SCENARIOS: Scenario[] = [
  {
    name: 'create_voucher: a manual voucher in a named period and series',
    type: 'create_voucher',
    params: {
      entry_date: '2026-03-12',
      description: 'Skärm till kontoret',
      fiscal_period_id: PERIOD,
      voucher_series: 'B',
      notes: 'Kvitto mejlat',
      lines: LINES,
    },
  },
  {
    name: 'create_voucher: the period found from the date',
    type: 'create_voucher',
    params: { entry_date: '2026-03-13', description: 'Bankavgift', lines: [LINES[0], { ...LINES[2], credit_amount: 800 }] },
  },
  {
    name: 'create_voucher: an ingående balans',
    type: 'create_voucher',
    params: {
      entry_date: '2026-01-01',
      description: 'Ingående balans 2026',
      fiscal_period_id: PERIOD,
      is_opening_balance: true,
      lines: [
        { account_number: '1930', debit_amount: 10000, credit_amount: 0 },
        { account_number: '2081', debit_amount: 0, credit_amount: 10000 },
      ],
    },
    tables: { fiscal_periods: { data: { period_start: '2026-01-01', name: '2026', opening_balance_entry_id: null } } },
  },
  {
    name: 'create_voucher: a kvitto from the inbox, claimed, its underlag attached',
    type: 'create_voucher',
    params: {
      entry_date: '2026-03-14',
      description: 'Kvitto Clas Ohlson',
      fiscal_period_id: PERIOD,
      inbox_item_id: INBOX_ITEM,
      document_id: DOCUMENT,
      lines: LINES,
    },
    tables: {
      invoice_inbox_items: [{ data: { created_journal_entry_id: null, created_supplier_invoice_id: null } }, { data: [{ id: INBOX_ITEM }] }],
    },
  },
  {
    name: 'create_voucher: a kvitto whose inbox claim is lost, so the voucher is reversed',
    type: 'create_voucher',
    params: {
      entry_date: '2026-03-15',
      description: 'Kvitto Clas Ohlson',
      fiscal_period_id: PERIOD,
      inbox_item_id: INBOX_ITEM,
      lines: LINES,
    },
    tables: {
      invoice_inbox_items: [{ data: { created_journal_entry_id: null, created_supplier_invoice_id: null } }, { data: [] }],
    },
  },
  {
    name: 'create_voucher: the engine refuses',
    type: 'create_voucher',
    refuse: true,
    params: { entry_date: '2026-03-16', description: 'Skärm', fiscal_period_id: PERIOD, lines: LINES },
  },
  {
    name: 'correct_entry: new lines and text, deep chain allowed',
    type: 'correct_entry',
    params: {
      entry_id: ORIGINAL,
      description: 'Rättelse: inventarie',
      allow_deep_chain: true,
      lines: [
        { account_number: '1220', debit_amount: 800, credit_amount: 0 },
        { account_number: '2641', debit_amount: 200, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
      ],
    },
    tables: { journal_entries: POSTED_ORIGINAL },
  },
  {
    name: 'correct_entry: the storno service refuses',
    type: 'correct_entry',
    refuse: true,
    params: { entry_id: ORIGINAL, lines: LINES },
    tables: { journal_entries: POSTED_ORIGINAL },
  },
  {
    name: 'reverse_entry: on a date in the year, deep chain allowed',
    type: 'reverse_entry',
    params: { entry_id: ORIGINAL, reversal_date: '2026-03-31', allow_deep_chain: true },
    tables: { journal_entries: POSTED_ORIGINAL },
  },
  {
    name: 'reverse_entry: the engine refuses',
    type: 'reverse_entry',
    refuse: true,
    params: { entry_id: ORIGINAL },
    tables: { journal_entries: POSTED_ORIGINAL },
  },
  {
    name: 'redate_entry: moved to the right year',
    type: 'redate_entry',
    params: { journal_entry_id: '00000000-0000-4000-8000-00000000e999', new_entry_date: '2025-03-10' },
  },
  {
    name: 'redate_entry: the storno service refuses',
    type: 'redate_entry',
    refuse: true,
    params: { journal_entry_id: '00000000-0000-4000-8000-00000000e999', new_entry_date: '2025-03-11', allow_deep_chain: true },
  },
]

function record(args: unknown[]): unknown[] {
  const recorded = args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))
  while (recorded.length > 0 && recorded[recorded.length - 1] === '<undefined>') recorded.pop()
  return [recorded.length, ...recorded]
}

interface Run {
  name: string
  calls: Record<string, unknown[][]>
  documentLinks: unknown[][]
  outcome: unknown
  events: Array<Record<string, unknown>>
}

interface RunOptions {
  /** The business_events insert refuses (a shadow failure). */
  refuseEvent?: boolean
}

function posted(id: string, extra: Record<string, unknown> = {}) {
  return { id, status: 'posted', voucher_series: 'A', voucher_number: 7, fiscal_period_id: PERIOD, entry_date: '2026-03-10', ...extra }
}

function arm(index: number, refuse: boolean): void {
  for (const fn of Object.values(ENGINE)) fn.mockReset()
  const id = entryId(index)
  ENGINE.createJournalEntry.mockImplementation(async () => {
    if (refuse) throw new AccountsNotInChartError(['5410'])
    return posted(id) as never
  })
  ENGINE.reverseEntry.mockImplementation(async () => {
    if (refuse) throw new CannotReverseNonPostedError('reversed')
    return posted(`storno-${id}`) as never
  })
  ENGINE.correctEntry.mockImplementation(async () => {
    if (refuse) throw new MeaninglessCorrectionError('identical_to_original')
    return { reversal: posted(`storno-${id}`), corrected: posted(`correction-${id}`) } as never
  })
  ENGINE.recordateEntry.mockImplementation(async () => {
    if (refuse) throw new MeaninglessCorrectionError('no_date_change')
    return { reversal: posted(`storno-${id}`), corrected: posted(`correction-${id}`, { entry_date: '2025-03-10' }) } as never
  })
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    arm(index, s.refuse === true)
    vi.mocked(linkToJournalEntry).mockReset()
    vi.mocked(findFiscalPeriod).mockReset()
    vi.mocked(findFiscalPeriod).mockResolvedValue(PERIOD)
    const mock = createTableMockSupabase({
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
      pending_operations: { data: { id: opId(index), updated_at: '2026-03-20T10:00:00Z' } },
      ...s.tables,
    })
    const op = {
      id: opId(index),
      user_id: USER,
      company_id: COMPANY,
      operation_type: s.type,
      status: 'pending',
      title: s.name,
      params: s.params,
      preview_data: {},
      result_data: null,
      actor_type: 'api_key',
      actor_id: null,
      actor_label: 'Bokföringsagent',
      risk_level: 'high',
      created_at: '2026-03-20T09:00:00Z',
      resolved_at: null,
      updated_at: '2026-03-20T09:00:00Z',
    } as unknown as PendingOperation
    const result = await commitPendingOperation(mock.supabase as never, USER, COMPANY, op, {
      commitMethod: 'user_accept',
      actor: { type: 'user' },
    })
    const calls: Record<string, unknown[][]> = {}
    for (const [name, fn] of Object.entries(ENGINE)) {
      if (fn.mock.calls.length > 0) calls[name] = fn.mock.calls.map((c) => record(c as unknown[]))
    }
    out.push({
      name: s.name,
      calls,
      documentLinks: vi.mocked(linkToJournalEntry).mock.calls.map((c) => record(c as unknown[])),
      outcome: { status: result.status, data: result.data ?? null, error: result.error ?? null, code: result.code ?? null },
      events: mock.findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('staged voucher executors engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    eventBus.clear()
  })

  it('hands the engine and the storno service exactly what they got before the port', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, calls, documentLinks, outcome }) => ({ name, calls, documentLinks, outcome }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
  })
  it('with POSTING_EVENTS=shadow calls the engine the same, plus only one event link per new verifikat', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      const before = off[i]!
      expect(run.outcome, run.name).toEqual(before.outcome)
      expect(run.documentLinks, run.name).toEqual(before.documentLinks)
      expect(callsWithoutEventLinks(run.calls), run.name).toEqual(before.calls)
      const links = Object.values(run.calls).flat().flatMap(eventLinksOf)
      expect(links.map((l) => l.id), run.name).toEqual(run.events.map((e) => e.id))
      for (const [j, link] of links.entries()) {
        expect(link, run.name).toEqual({ id: run.events[j]!.id, role: roleForKind(run.events[j]!.kind), onFailure: 'log' })
      }
      expect(run.events.length, run.name).toBeGreaterThan(0)
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still books, with exactly the off calls', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    const view = (runs: Run[]) => runs.map(({ name, calls, documentLinks, outcome }) => ({ name, calls, documentLinks, outcome }))
    expect(view(refused)).toEqual(view(off))
  })

  it('with POSTING_EVENTS=strict a refused event write stops every executor before the engine', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const run of refused) {
      expect(run.calls, run.name).toEqual({})
      expect(run.documentLinks, run.name).toEqual([])
      expect((run.outcome as { status: string }).status, run.name).toBe('failed')
    }
  })

  it('records what happened in business terms, the approval as evidence', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    for (const [i, run] of runs.entries()) {
      for (const event of run.events) {
        expect(event.pending_operation_id, run.name).toBe(opId(i))
        expect((event.evidence as { link_evidence?: unknown }).link_evidence, run.name).toEqual({ pending_operation_id: opId(i) })
        expect(event.actor_type, run.name).toBe('user')
      }
    }
    const events = (name: string) => runs.find((r) => r.name === name)!.events
    const staged = { link_basis: 'agent_proposed_user_approved' }
    expect(events('create_voucher: a manual voucher in a named period and series')).toEqual([
      expect.objectContaining({ kind: 'ledger.manual', occurred_on: '2026-03-12', subject_type: null, evidence: expect.objectContaining(staged) }),
    ])
    expect(events('create_voucher: an ingående balans')).toEqual([expect.objectContaining({ kind: 'ledger.opening_balance', occurred_on: '2026-01-01' })])
    expect(events('create_voucher: a kvitto from the inbox, claimed, its underlag attached')).toEqual([
      expect.objectContaining({ kind: 'ledger.manual', evidence: expect.objectContaining({ ...staged, inbox_item_id: INBOX_ITEM, document_id: DOCUMENT }) }),
    ])
    // The lost claim's storno: the door's own compensation, of the inbox item.
    expect(events('create_voucher: a kvitto whose inbox claim is lost, so the voucher is reversed')).toEqual([
      expect.objectContaining({ kind: 'ledger.manual', evidence: expect.objectContaining({ ...staged, inbox_item_id: INBOX_ITEM }) }),
      expect.objectContaining({ kind: 'ledger.storno', subject_type: 'inbox_item', subject_id: INBOX_ITEM, evidence: expect.objectContaining({ link_basis: 'system_derived' }) }),
    ])
    expect(events('correct_entry: new lines and text, deep chain allowed')).toEqual([
      expect.objectContaining({ kind: 'ledger.storno', subject_type: 'journal_entry', subject_id: ORIGINAL, evidence: expect.objectContaining(staged) }),
      expect.objectContaining({ kind: 'ledger.correction', subject_type: 'journal_entry', subject_id: ORIGINAL, evidence: expect.objectContaining(staged) }),
    ])
    expect(events('reverse_entry: on a date in the year, deep chain allowed')).toEqual([
      expect.objectContaining({ kind: 'ledger.storno', subject_type: 'journal_entry', subject_id: ORIGINAL, evidence: expect.objectContaining(staged) }),
    ])
    expect(events('redate_entry: moved to the right year').map((e) => [e.kind, e.subject_id])).toEqual([
      ['ledger.storno', '00000000-0000-4000-8000-00000000e999'],
      ['ledger.correction', '00000000-0000-4000-8000-00000000e999'],
    ])
  })
})
