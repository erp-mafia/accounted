/**
 * Posting port, step 1: what createTransactionJournalEntry hands the engine,
 * recorded call by call and compared with a committed fixture
 * (transaction-entries.engine-input.json) that was taken from main before the
 * pilot went through the port. Every argument is recorded, an absent one as
 * '<undefined>', so an extra argument or a changed input fails here.
 *
 * Regenerate only on purpose, from main:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/bookkeeping/__tests__/transaction-entries.engine-input.test.ts
 *
 * Since the pilot posts through the posting port, the scenarios run with the
 * business event context the doors now pass, and once more with
 * POSTING_EVENTS=shadow: the engine must get the same six arguments, plus
 * only the event link as the seventh.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase, makeTransaction } from '@/tests/helpers'
import type { CreateJournalEntryInput, MappingResult, Transaction, TransactionCategory } from '@/types'

// The two engine calls the producer makes are recorded; the pure checks the
// posting port runs on the lines stay real.
vi.mock('../engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine')>()),
  findFiscalPeriod: vi.fn(),
  createJournalEntry: vi.fn(),
}))

const { createJournalEntry, findFiscalPeriod } = await import('../engine')
const { createTransactionJournalEntry } = await import('../transaction-entries')
const mockedCreate = vi.mocked(createJournalEntry)
const mockedFindPeriod = vi.mocked(findFiscalPeriod)

const FIXTURE = path.join(__dirname, 'transaction-entries.engine-input.json')
const SUPABASE = '<supabase>'

function mapping(overrides: Partial<MappingResult>): MappingResult {
  return {
    rule: null,
    debit_account: '5420',
    credit_account: '1930',
    risk_level: 'LOW',
    confidence: 1,
    requires_review: false,
    default_private: false,
    vat_lines: [],
    description: 'Mapping',
    ...overrides,
  }
}

interface Scenario {
  name: string
  transaction: Transaction
  mappingResult: MappingResult
  notes?: string
  options?: { rubricVersion?: string }
  /** findFiscalPeriod's answer; null drives the pre-FY clamp. */
  period?: string | null
  /** Queued answers for the reads after findFiscalPeriod, in order. */
  reads?: Array<{ data?: unknown; error?: unknown }>
  /** The category the door passes in the business event context. */
  category?: TransactionCategory
}

const SCENARIOS: Scenario[] = [
  {
    name: 'SEK purchase with ingående moms',
    transaction: makeTransaction({ id: 'tx-purchase', amount: -1250, description: 'Programvarulicens', date: '2026-03-14' }),
    category: 'expense_software',
    mappingResult: mapping({
      debit_account: '5420',
      vat_lines: [{ account_number: '2641', debit_amount: 250, credit_amount: 0, description: 'Ingående moms 25%' }],
    }),
  },
  {
    name: 'SEK sale with utgående moms',
    transaction: makeTransaction({ id: 'tx-sale', amount: 10000, description: 'Konsultuppdrag', date: '2026-03-20' }),
    category: 'income_services',
    mappingResult: mapping({
      debit_account: '1930',
      credit_account: '3001',
      vat_lines: [{ account_number: '2611', debit_amount: 0, credit_amount: 2000, description: 'Utgående moms 25%' }],
    }),
  },
  {
    name: 'private withdrawal',
    transaction: makeTransaction({ id: 'tx-private', amount: -500, description: 'Privat', date: '2026-04-02' }),
    category: 'private',
    mappingResult: mapping({ debit_account: '2893', default_private: true }),
  },
  {
    name: 'multi-line pattern with a dimensions bag',
    transaction: makeTransaction({ id: 'tx-pattern', amount: -1000, description: 'Mönster', date: '2026-04-05' }),
    mappingResult: mapping({
      debit_account: '5410',
      all_lines_complete: true,
      dimensions: { '6': 'P001' },
      vat_lines: [
        { account_number: '5410', debit_amount: 800, credit_amount: 0, description: 'Förbrukning', business_line: true },
        { account_number: '2641', debit_amount: 200, credit_amount: 0, description: 'Ingående moms 25%' },
      ],
    }),
  },
  {
    name: 'foreign currency purchase',
    transaction: makeTransaction({
      id: 'tx-eur',
      amount: -100,
      currency: 'EUR',
      amount_sek: -1150.25,
      exchange_rate: 11.5025,
      description: 'Hotel Berlin',
      date: '2026-05-12',
    }),
    mappingResult: mapping({ debit_account: '5890' }),
  },
  {
    name: 'audit note and rubric version',
    transaction: makeTransaction({ id: 'tx-note', amount: -640, description: 'Restaurang Lunch', date: '2026-06-03' }),
    mappingResult: mapping({ debit_account: '6071' }),
    notes: 'Deltagare: kund A och B. Syfte: projektmöte',
    options: { rubricVersion: 'bank-proposals.1+abc123def456' },
  },
  {
    name: 'pre-FY clamp onto the first day of the first fiscal year',
    transaction: makeTransaction({ id: 'tx-prefy', amount: -45, description: 'Bankavgift', date: '2025-12-20' }),
    category: 'expense_bank_fees',
    mappingResult: mapping({ debit_account: '6570' }),
    period: null,
    reads: [{ data: [{ id: 'period-first', period_start: '2026-01-01', is_closed: false, locked_at: null }] }],
  },
  {
    name: 'bank account with its own verifikationsserie',
    transaction: makeTransaction({ id: 'tx-series', amount: -300, description: 'Kort', date: '2026-07-01', cash_account_id: 'cash-1' }),
    mappingResult: mapping({ debit_account: '5410', credit_account: '1931' }),
    reads: [{ data: { voucher_series: 'B' } }],
  },
]

function record(args: unknown[]): unknown[] {
  return [args.length, ...args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A stable UUID per scenario, for the runs whose events must pass the port's checks. */
function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

interface Run {
  name: string
  calls: unknown[][]
  events: unknown[]
}

async function runScenarios(opts: { uuidIds?: boolean } = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    mockedCreate.mockClear()
    mockedFindPeriod.mockResolvedValueOnce(s.period === undefined ? 'period-1' : s.period)
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    // The reads, then the business_events insert (consumed only in shadow).
    enqueueMany([...(s.reads ?? []), { data: null, error: null }])
    const transaction = opts.uuidIds ? { ...s.transaction, id: uuidFor(index) } : s.transaction
    mockedCreate.mockImplementation(async (_sb, _c, _u, input: CreateJournalEntryInput) => ({ id: `je-${transaction.id}`, ...input }) as never)
    // The context the categorize door passes (lib/transactions/categorize-core.ts).
    await createTransactionJournalEntry(supabase as never, 'company-1', 'user-1', transaction, s.mappingResult, s.notes, {
      ...s.options,
      businessEvent: {
        category: s.category ?? null,
        source: 'category',
        linkBasis: { link_basis: 'user_created', link_evidence: null },
      },
    })
    out.push({
      name: s.name,
      calls: mockedCreate.mock.calls.map((c) => record(c as unknown[])),
      events: findCalls('business_events', 'insert').map((args) => args[0]),
    })
  }
  return out
}

describe('createTransactionJournalEntry engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the engine exactly what main handed it', async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const recorded = await runScenarios()
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded.map(({ name, calls }) => ({ name, calls })), null, 2)}\n`)
    }
    expect(recorded.map(({ name, calls }) => ({ name, calls }))).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    // Off writes nothing but the verifikat.
    expect(recorded.flatMap((r) => r.events)).toEqual([])
  })

  it('with POSTING_EVENTS=shadow hands the engine the same six arguments, plus only the event link', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios({ uuidIds: true })
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios({ uuidIds: true })

    for (const [i, run] of shadow.entries()) {
      const before = off[i]!.calls
      expect(run.calls, run.name).toHaveLength(1)
      expect(before[0]![0]).toBe(6)
      expect(run.calls[0]![0], run.name).toBe(7)
      expect(run.calls[0]!.slice(1, 7), run.name).toEqual(before[0]!.slice(1, 7))
      expect(run.calls[0]![7], run.name).toEqual({
        businessEvent: { id: expect.stringMatching(UUID), role: 'produced', onFailure: 'log' },
      })
      expect(run.events, run.name).toHaveLength(1)
      const event = run.events[0] as { id: string }
      expect((run.calls[0]![7] as { businessEvent: { id: string } }).businessEvent.id).toBe(event.id)
    }
  })

  it('records what happened in business terms for each scenario', async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios({ uuidIds: true })
    const event = (name: string) => runs.find((r) => r.name === name)!.events[0] as Record<string, unknown>

    expect(event('SEK purchase with ingående moms')).toMatchObject({
      kind: 'bank.categorized',
      category: 'expense.software',
      occurred_on: '2026-03-14',
      subject_type: 'transaction',
      subject_id: uuidFor(0),
      currency: 'SEK',
      amount: 1250,
      amount_sek: 1250,
      tax_amounts: [{ tax: 'vat', treatment: null, amount_sek: 250 }],
      evidence: { direction: 'out', link_basis: 'user_created' },
      party_type: null,
      party_id: null,
      receipt_id: null,
      pending_operation_id: null,
      jurisdiction: 'SE',
    })
    expect(event('SEK purchase with ingående moms').mapping_version).toMatch(/^se\.category-mapping@/)
    expect(event('SEK sale with utgående moms')).toMatchObject({
      category: 'income.services',
      tax_amounts: [{ tax: 'vat', amount_sek: 2000 }],
      evidence: { direction: 'in' },
    })
    expect(event('private withdrawal')).toMatchObject({ category: 'owner.transfer', tax_amounts: [] })
    expect(event('multi-line pattern with a dimensions bag')).toMatchObject({ category: null, tax_amounts: [] })
    expect(event('foreign currency purchase')).toMatchObject({ currency: 'EUR', amount: 100, amount_sek: 1150.25 })
    expect(event('audit note and rubric version').mapping_version).toBe('se.category-mapping@bank-proposals.1+abc123def456')
    // The business act's own date, not the clamped verifikat date.
    expect(event('pre-FY clamp onto the first day of the first fiscal year')).toMatchObject({
      occurred_on: '2025-12-20',
      category: 'expense.bank_fees',
    })
  })
})
