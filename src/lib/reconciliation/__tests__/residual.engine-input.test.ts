/**
 * Posting port, step 2i: what the reconciliation worksheet's residual booking
 * (bookResidualAndLink: a bank fee, interest or öresavrundning the selection
 * misses by) hands the engine, recorded call by call and compared with a
 * committed fixture (residual.engine-input.json) that was taken before the
 * booking went through the port. Every door (the dashboard and v1 routes,
 * the MCP tool and the staged executor) books through this one function.
 *
 * Every argument is recorded, an absent one as '<undefined>'; trailing
 * undefined arguments are dropped before the comparison.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/reconciliation/__tests__/residual.engine-input.test.ts
 *
 * Since the residual posts through the posting port, the scenarios also run
 * with POSTING_EVENTS=shadow and strict: the off call plus only the event
 * link, a refused event write still books under shadow, and under strict the
 * booking stops before the engine and the selection's links are undone, as
 * for any refused booking.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { eventLinksOf, withoutEventLinks } from '@/tests/engine-input'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
}))
vi.mock('../actions', () => ({ matchPairs: vi.fn(), unmatchLink: vi.fn() }))

const { createJournalEntry, findFiscalPeriod } = await import('@/lib/bookkeeping/engine')
const { matchPairs, unmatchLink } = await import('../actions')
const { BookkeepingDatabaseError } = await import('@/lib/bookkeeping/errors')
const { bookResidualAndLink } = await import('../residual')

const FIXTURE = path.join(__dirname, 'residual.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'
const CASH = '00000000-0000-4000-8000-0000000ca001'
const KEY = `bank:${CASH}`
const MAIN = '00000000-0000-4000-8000-0000000e0100'
const mockedCreate = vi.mocked(createJournalEntry)

function txId(index: number, n = 1): string {
  return `00000000-0000-4000-8000-0000000a${String(index * 10 + n).padStart(4, '0')}`
}

interface Scenario {
  name: string
  kind: 'bank_fee' | 'rounding' | 'interest_income' | 'interest_expense'
  rows: Array<{ amount: number; date: string; description: string }>
  /** The main verifikat's bank-account net. */
  entryNet: number
  entryDate?: string
  description?: string
  currency?: string
  refuse?: boolean
}

const SCENARIOS: Scenario[] = [
  {
    name: 'a bank fee on a supplier payment',
    kind: 'bank_fee',
    rows: [{ amount: -1010, date: '2026-08-05', description: 'Leverantör AB' }],
    entryNet: -1000,
  },
  {
    name: 'interest received on two deposits, own date and text',
    kind: 'interest_income',
    rows: [
      { amount: 600, date: '2026-08-06', description: 'Insättning' },
      { amount: 412.5, date: '2026-08-07', description: 'Insättning' },
    ],
    entryNet: 1000,
    entryDate: '2026-08-31',
    description: 'Ränta augusti',
  },
  {
    // Was "on a euro account": that subtracted kronor from euro and pinned
    // the mix. A foreign account is refused now (accounted#58, residual.test.ts).
    name: 'öresavrundning on a card payment',
    kind: 'rounding',
    rows: [{ amount: -99.99, date: '2026-08-08', description: 'Kort' }],
    entryNet: -100,
  },
  {
    name: 'interest expense the engine refuses (a locked period): the links are undone',
    kind: 'interest_expense',
    rows: [{ amount: -2040, date: '2026-08-09', description: 'Lån' }],
    entryNet: -2000,
    refuse: true,
  },
]

function record(args: unknown[]): unknown[] {
  const recorded = args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))
  while (recorded.length > 0 && recorded[recorded.length - 1] === '<undefined>') recorded.pop()
  return [recorded.length, ...recorded]
}

interface Run {
  name: string
  postings: unknown[][]
  junction: unknown[]
  unmatched: number
  outcome: unknown
  events: Array<Record<string, unknown>>
}

interface RunOptions {
  /** The business_events insert refuses (a shadow failure). */
  refuseEvent?: boolean
  /** The actor the door runs as (a v1 key, a person). */
  actor?: 'user' | 'api_key'
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    mockedCreate.mockReset()
    mockedCreate.mockImplementation(async () => {
      if (s.refuse) throw new BookkeepingDatabaseError('commit_entry', 'Cannot write to locked/closed fiscal period')
      return { id: `residual-${index}`, status: 'posted' } as never
    })
    vi.mocked(findFiscalPeriod).mockResolvedValue(PERIOD)
    const ids = s.rows.map((_, n) => txId(index, n + 1))
    vi.mocked(matchPairs).mockReset()
    vi.mocked(matchPairs).mockResolvedValue({
      dry_run: false,
      considered: ids.length,
      applied: ids.map((external_id) => ({ external_id, journal_entry_id: MAIN })),
      skipped: [],
    } as never)
    vi.mocked(unmatchLink).mockReset()
    const ledger = '1930'
    const mock = createTableMockSupabase({
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
      cash_accounts: { data: { id: CASH, ledger_account: ledger, currency: s.currency ?? 'SEK' } },
      transactions: {
        data: s.rows.map((r, n) => ({ id: ids[n], ...r, journal_entry_id: null, is_ignored: false, cash_account_id: CASH })),
      },
      journal_entries: {
        data: {
          id: MAIN,
          status: 'posted',
          description: 'Faktura 1234',
          lines: [
            { account_number: '2440', debit_amount: Math.max(-s.entryNet, 0), credit_amount: Math.max(s.entryNet, 0) },
            { account_number: ledger, debit_amount: Math.max(s.entryNet, 0), credit_amount: Math.max(-s.entryNet, 0) },
          ],
        },
      },
      transaction_voucher_links: { data: null },
    })
    let outcome: unknown
    try {
      const result = await runWithActor({ type: opts.actor ?? 'user' }, () =>
        bookResidualAndLink(mock.supabase as never, COMPANY, USER, KEY, {
          external_ids: ids,
          journal_entry_id: MAIN,
          kind: s.kind,
          ...(s.entryDate ? { entry_date: s.entryDate } : {}),
          ...(s.description ? { description: s.description } : {}),
        }),
      )
      outcome = result
    } catch (err) {
      outcome = { error: (err as Error).name }
    }
    out.push({
      name: s.name,
      postings: mockedCreate.mock.calls.map((c) => record(c as unknown[])),
      junction: mock.payloads('transaction_voucher_links', 'insert'),
      unmatched: vi.mocked(unmatchLink).mock.calls.length,
      outcome,
      events: mock.findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('reconciliation residual engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    eventBus.clear()
  })

  it('hands the engine exactly what it got before the port', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, postings, junction, unmatched, outcome }) => ({ name, postings, junction, unmatched, outcome }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
  })
  it('with POSTING_EVENTS=shadow books with the same call, plus only the event link', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      const before = off[i]!
      expect({ junction: run.junction, unmatched: run.unmatched, outcome: run.outcome }, run.name).toEqual({
        junction: before.junction,
        unmatched: before.unmatched,
        outcome: before.outcome,
      })
      expect(run.postings.map(withoutEventLinks), run.name).toEqual(before.postings)
      expect(run.postings.flatMap(eventLinksOf), run.name).toEqual(run.events.map((e) => ({ id: e.id, role: 'produced', onFailure: 'log' })))
      expect(run.events, run.name).toHaveLength(1)
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still books, with exactly the off call', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    const view = (runs: Run[]) => runs.map(({ name, postings, junction, unmatched, outcome }) => ({ name, postings, junction, unmatched, outcome }))
    expect(view(refused)).toEqual(view(off))
  })

  it('with POSTING_EVENTS=strict a refused event write stops the booking before the engine and undoes the links', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const [i, run] of refused.entries()) {
      expect(run.postings, run.name).toEqual([])
      expect(run.junction, run.name).toEqual([])
      expect(run.unmatched, run.name).toBe(SCENARIOS[i]!.rows.length)
      expect(run.outcome, run.name).toEqual({ error: 'BookkeepingDatabaseError' })
    }
  })

  it('records the residual as ledger.manual of its bank line, filed under its kind', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const common = { kind: 'ledger.manual', subject_type: 'transaction', currency: 'SEK', party_type: null, jurisdiction: 'SE' }
    expect(runs[0]!.events[0]).toMatchObject({
      ...common,
      category: 'expense.bank_fees',
      occurred_on: '2026-08-05',
      subject_id: txId(0),
      amount: 10,
      amount_sek: 10,
      evidence: { direction: 'out', link_basis: 'user_created' },
    })
    expect(runs[1]!.events[0]).toMatchObject({
      ...common,
      category: 'finance.banking',
      occurred_on: '2026-08-31',
      subject_id: txId(1),
      amount: 12.5,
      evidence: { direction: 'in' },
    })
    expect(runs[2]!.events[0]).toMatchObject({ ...common, category: null, amount: 0.01 })
    for (const run of runs) expect(String(run.events[0]!.mapping_version)).toMatch(/^se\.reconciliation-residual@/)
    // On a key, the caller's own booking is client_asserted.
    const onKey = await runScenarios({ actor: 'api_key' })
    expect(onKey[0]!.events[0]).toMatchObject({ evidence: { link_basis: 'client_asserted' }, actor_type: 'api_key' })
  })
})
