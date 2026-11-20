/**
 * Posting port, step 2e: what the single bank-line booking door
 * (POST /api/transactions/[id]/book, "Bokför" on the person's own rows) hands
 * the engine, recorded call by call and compared with a committed fixture
 * (route.engine-input.json) that was taken before the door went through the
 * port. The verifikat carries the rule version of the suggestions on offer;
 * when the bank line cannot be pointed at it (a concurrent booking won, or
 * the update failed) it is reversed with a storno. Every argument is
 * recorded, an absent one as '<undefined>'; trailing undefined arguments are
 * dropped before the comparison (see
 * src/lib/bookkeeping/__tests__/supplier-payment-entries.engine-input.test.ts).
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run 'src/app/api/transactions/[id]/book/__tests__/route.engine-input.test.ts'
 *
 * Since the verifikat and the door's storno post through the posting port,
 * the scenarios also run with POSTING_EVENTS=shadow and strict: the engine
 * must get the same arguments plus only the event link, a refused event
 * write must still book and reverse under shadow, and under strict the door
 * stops before the engine is called.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createMockRouteParams, createTableMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { CreateJournalEntryInput } from '@/types'

const state = vi.hoisted(() => ({
  client: null as unknown,
  ruleVersion: undefined as string | undefined,
  repoint: null as string | null,
  series: null as string | null,
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => ({ user: { id: '00000000-0000-4000-8000-00000000a001' }, supabase: state.client, error: null })),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('00000000-0000-4000-8000-00000000c001'),
  getActiveCompanyId: vi.fn().mockResolvedValue('00000000-0000-4000-8000-00000000c001'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: vi.fn(),
  reverseEntry: vi.fn(),
}))
vi.mock('@/lib/suggestion-log/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suggestion-log/record')>()),
  snapshotSuggestions: vi.fn(async (_supabase: unknown, companyId: string) => ({
    companyId,
    byTransaction: new Map(),
    ...(state.ruleVersion ? { ruleVersion: state.ruleVersion } : {}),
  })),
  recordDecisions: vi.fn(async () => undefined),
}))
vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: vi.fn(async () => null),
}))
vi.mock('@/lib/transactions/is-booked', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/is-booked')>()),
  assertTransactionBookable: vi.fn(async () => ({ ok: true })),
}))
vi.mock('@/lib/cash-accounts/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cash-accounts/service')>()),
  guardBookedCounterLines: vi.fn(async () => ({ refusedLedger: null, repointCashAccountId: state.repoint })),
}))
vi.mock('@/lib/bookkeeping/cash-account-voucher-series', () => ({
  resolveCashAccountVoucherSeries: vi.fn(async () => state.series),
}))
vi.mock('@/lib/bookkeeping/settlement-account', () => ({
  resolveSettlementAccount: vi.fn(async () => '1930'),
}))
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  propagateUnderlagForBookedTransaction: vi.fn(async () => undefined),
}))

const { createJournalEntry, reverseEntry } = await import('@/lib/bookkeeping/engine')
const { POST } = await import('../route')

const mockedCreate = vi.mocked(createJournalEntry)
const mockedReverse = vi.mocked(reverseEntry)

const FIXTURE = path.join(__dirname, 'route.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'
const CASH_ACCOUNT = '00000000-0000-4000-8000-00000000ca01'
const SIBLING_ACCOUNT = '00000000-0000-4000-8000-00000000ca02'
const STALE_ENTRY = '00000000-0000-4000-8000-00000000e003'

function transactionId(index: number): string {
  return `00000000-0000-4000-8000-0000000a${String(index + 1).padStart(4, '0')}`
}

function transaction(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: transactionId(index),
    company_id: COMPANY,
    date: '2026-09-14',
    description: 'Kortköp',
    amount: -1250,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
    cash_account_id: CASH_ACCOUNT,
    journal_entry_id: null,
    document_id: null,
    external_id: null,
    import_source: 'manual',
    bank_connection_id: null,
    ...overrides,
  }
}

interface Scenario {
  name: string
  transaction: ReturnType<typeof transaction>
  body: Record<string, unknown>
  ruleVersion?: string
  series?: string
  repoint?: string
  link?: 'lost' | 'error'
}

const SCENARIOS: Scenario[] = [
  {
    name: "a withdrawal booked on the person's own rows",
    transaction: transaction(0),
    body: {
      fiscal_period_id: PERIOD,
      entry_date: '2026-09-14',
      description: 'Programvarulicens',
      lines: [
        { account_number: '5420', debit_amount: 1000, credit_amount: 0 },
        { account_number: '2641', debit_amount: 250, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1250 },
      ],
    },
  },
  {
    name: "a deposit on a bank account with its own series, under the suggestions' rule version",
    transaction: transaction(1, { date: '2026-09-15', amount: 10000, description: 'Kundbetalning' }),
    body: {
      fiscal_period_id: PERIOD,
      entry_date: '2026-09-15',
      description: 'Konsultuppdrag',
      lines: [
        { account_number: '1930', debit_amount: 10000, credit_amount: 0 },
        { account_number: '3041', debit_amount: 0, credit_amount: 8000 },
        { account_number: '2611', debit_amount: 0, credit_amount: 2000, line_description: 'Utgående moms 25 %' },
      ],
    },
    ruleVersion: 'bank-proposals.1+a38016f12abc',
    series: 'B',
  },
  {
    name: 'an explicit series from the dialog on a foreign row',
    transaction: transaction(2, { date: '2026-09-16', amount: -100, currency: 'EUR', amount_sek: -1150.25, exchange_rate: 11.5025 }),
    body: {
      fiscal_period_id: PERIOD,
      entry_date: '2026-09-16',
      description: 'Hotell Berlin',
      voucher_series: 'C',
      lines: [
        { account_number: '5800', debit_amount: 1150.25, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1150.25 },
      ],
    },
  },
  {
    name: 'a stranded row re-pointed to its live sibling ledger, replacing a stale pointer',
    transaction: transaction(3, { date: '2026-09-17', journal_entry_id: STALE_ENTRY }),
    body: {
      fiscal_period_id: PERIOD,
      entry_date: '2026-09-17',
      description: 'Kontorsmaterial',
      lines: [
        { account_number: '6110', debit_amount: 1250, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1250 },
      ],
    },
    repoint: SIBLING_ACCOUNT,
  },
  {
    name: 'a concurrent booking wins the bank line: the verifikat is reversed',
    transaction: transaction(4, { date: '2026-09-18' }),
    body: {
      fiscal_period_id: PERIOD,
      entry_date: '2026-09-18',
      description: 'Kontorsmaterial',
      lines: [
        { account_number: '6110', debit_amount: 1250, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1250 },
      ],
    },
    link: 'lost',
  },
  {
    name: 'the bank line update fails: the verifikat is reversed',
    transaction: transaction(5, { date: '2026-09-19' }),
    body: {
      fiscal_period_id: PERIOD,
      entry_date: '2026-09-19',
      description: 'Kontorsmaterial',
      lines: [
        { account_number: '6110', debit_amount: 1250, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1250 },
      ],
    },
    link: 'error',
  },
]

function record(args: unknown[]): unknown[] {
  return [args.length, ...args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))]
}

function trimTrailingUndefined(call: unknown[]): unknown[] {
  const args = call.slice(1)
  while (args.length > 0 && args[args.length - 1] === '<undefined>') args.pop()
  return [args.length, ...args]
}

interface Run {
  name: string
  calls: unknown[][]
  reversals: unknown[][]
  outcome: unknown
  events: Array<Record<string, unknown>>
}

interface RunOptions {
  /** The business_events insert refuses (a shadow failure). */
  refuseEvent?: boolean
}

function supabaseFor(s: Scenario, opts: RunOptions) {
  return createTableMockSupabase({
    business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    transactions: [
      { data: s.transaction },
      s.link === 'lost' ? { data: [] } : s.link === 'error' ? { error: { message: 'update refused', code: '42501' } } : { data: [{ ...s.transaction }] },
    ],
  })
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    mockedCreate.mockReset()
    mockedReverse.mockReset()
    mockedCreate.mockImplementation(async (_sb, _c, _u, input: CreateJournalEntryInput) => ({ id: `je-${index}`, ...input }) as never)
    mockedReverse.mockImplementation(async (_sb, _c, _u, entryId: string) => ({ id: `storno-${entryId}`, status: 'posted' }) as never)
    const mock = supabaseFor(s, opts)
    state.client = mock.supabase
    state.ruleVersion = s.ruleVersion
    state.series = s.series ?? null
    state.repoint = s.repoint ?? null
    const response = await POST(
      createMockRequest(`/api/transactions/${s.transaction.id}/book`, { method: 'POST', body: s.body }),
      createMockRouteParams({ id: s.transaction.id }),
    )
    const body = (await response.json()) as Record<string, unknown>
    out.push({
      name: s.name,
      calls: mockedCreate.mock.calls.map((c) => record(c as unknown[])),
      reversals: mockedReverse.mock.calls.map((c) => record(c as unknown[])),
      outcome: {
        status: response.status,
        journal_entry_id: body.journal_entry_id ?? null,
        error: (body.error as { code?: string } | undefined)?.code ?? null,
      },
      events: mock.findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('single bank-line booking engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    eventBus.clear()
  })

  it('hands the engine exactly what it handed it before the port', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, calls, reversals, outcome }) => ({
      name,
      calls: calls.map(trimTrailingUndefined),
      reversals,
      outcome,
    }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
  })

  it('with POSTING_EVENTS=shadow hands the engine the same arguments, plus only the event link', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      const before = off[i]!
      expect(run.outcome, run.name).toEqual(before.outcome)
      expect(run.calls, run.name).toHaveLength(before.calls.length)
      expect(run.reversals, run.name).toHaveLength(before.reversals.length)
      expect(run.events, run.name).toHaveLength(before.calls.length + before.reversals.length)
      const ids = run.events.map((e) => e.id)
      for (const [j, call] of run.calls.entries()) {
        // The door's own six-argument call (the rule version in the sixth), plus only the link.
        expect(before.calls[j]![0], run.name).toBe(6)
        expect(call[0], run.name).toBe(7)
        expect(call.slice(1, 7), run.name).toEqual(before.calls[j]!.slice(1, 7))
        expect(call[7], run.name).toEqual({ businessEvent: { id: ids[0], role: 'produced', onFailure: 'log' } })
      }
      for (const [j, reversal] of run.reversals.entries()) {
        expect(before.reversals[j]![0], run.name).toBe(4)
        expect(reversal[0], run.name).toBe(6)
        expect(reversal.slice(1, 5), run.name).toEqual(before.reversals[j]!.slice(1, 5))
        expect(reversal[5], run.name).toBe('<undefined>')
        expect(reversal[6], run.name).toEqual({ businessEvent: { id: ids[1], role: 'reversal', onFailure: 'log' } })
      }
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still books and reverses, with exactly the off calls', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    const view = (runs: Run[]) => runs.map(({ calls, reversals, outcome }) => ({ calls, reversals, outcome }))
    expect(view(refused)).toEqual(view(off))
  })

  it('with POSTING_EVENTS=strict a refused event write stops the booking before the engine is called', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const run of refused) {
      expect(run.calls, run.name).toEqual([])
      expect(run.reversals, run.name).toEqual([])
      expect((run.outcome as { status: number }).status, run.name).toBeGreaterThanOrEqual(400)
    }
  })

  it('records what happened in business terms', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const events = (name: string) => runs.find((r) => r.name.startsWith(name))!.events
    expect(events("a withdrawal booked on the person's own rows")[0]).toMatchObject({
      kind: 'bank.categorized',
      category: null,
      occurred_on: '2026-09-14',
      subject_type: 'transaction',
      subject_id: transactionId(0),
      party_type: null,
      party_id: null,
      currency: 'SEK',
      amount: 1250,
      amount_sek: 1250,
      tax_amounts: [],
      evidence: { direction: 'out', link_basis: 'user_created' },
      mapping_version: null,
      jurisdiction: 'SE',
    })
    expect(events('a deposit on a bank account')[0]).toMatchObject({ amount: 10000, evidence: { direction: 'in' } })
    expect(events('an explicit series from the dialog on a foreign row')[0]).toMatchObject({ currency: 'EUR', amount: 100, amount_sek: 1150.25 })
    for (const name of ['a concurrent booking wins', 'the bank line update fails']) {
      const [booked, storno] = events(name)
      expect(booked, name).toMatchObject({ kind: 'bank.categorized' })
      expect(storno, name).toMatchObject({
        kind: 'ledger.storno',
        subject_type: 'transaction',
        subject_id: booked!.subject_id,
        amount: null,
        evidence: { link_basis: 'system_derived' },
      })
    }
  })
})
