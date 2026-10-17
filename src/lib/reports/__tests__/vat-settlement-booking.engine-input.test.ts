/**
 * Posting port, step 2b: what bookVatSettlement hands the engine, recorded
 * call by call and compared with a committed fixture
 * (vat-settlement-booking.engine-input.json) that was taken before the
 * producer went through the port. Every argument of createJournalEntry is
 * recorded, an absent one as '<undefined>', so an extra argument or a changed
 * input fails here. The proposal builder is mocked with fixed proposals: the
 * producer's input is what is pinned, not the builder (it has its own tests).
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/reports/__tests__/vat-settlement-booking.engine-input.test.ts
 *
 * Since the producer posts through the posting port, the scenarios also run
 * with POSTING_EVENTS=shadow: the engine must get the same arguments plus
 * only the event link, and a refused event write must still post. The
 * ledger adapter fills createJournalEntry's commitMethod and rubricVersion
 * positions (the pilot's six-argument call), which this producer's
 * four-argument call receives as undefined, the value its omitted optional
 * parameters had: trailing undefined arguments are dropped before the
 * comparison with the fixture, nothing else.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { VatSettlementProposal } from '@/lib/reports/vat-settlement'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: vi.fn(async () => ({ locked: false })) }))
vi.mock('@/lib/reports/vat-settlement', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reports/vat-settlement')>()),
  buildVatSettlementProposal: vi.fn(),
}))

const { createJournalEntry, findFiscalPeriod } = await import('@/lib/bookkeeping/engine')
const { buildVatSettlementProposal } = await import('@/lib/reports/vat-settlement')
const { bookVatSettlement } = await import('../vat-settlement-booking')

const mockedCreate = vi.mocked(createJournalEntry)

const FIXTURE = path.join(__dirname, 'vat-settlement-booking.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const FISCAL_PERIOD = '00000000-0000-4000-8000-00000000f001'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never

interface Scenario {
  name: string
  input: Parameters<typeof bookVatSettlement>[1]
  proposal: VatSettlementProposal
}

function proposal(overrides: Partial<VatSettlementProposal>): VatSettlementProposal {
  return {
    period: { type: 'quarterly', year: 2026, period: 1, start: '2026-01-01', end: '2026-03-31' },
    period_label: 'Kvartal 1 2026',
    entry_date: '2026-03-31',
    entry_date_reason: null,
    description: 'Momsredovisning Kvartal 1 2026',
    lines: [],
    filed_net: 0,
    rounding_amount: 0,
    is_empty: false,
    existing_entries: [],
    ...overrides,
  }
}

const SCENARIOS: Scenario[] = [
  {
    name: 'quarter with moms att betala',
    input: { period_type: 'quarterly', year: 2026, period: 1 },
    proposal: proposal({
      lines: [
        { account_number: '2611', debit_amount: 2500, credit_amount: 0 },
        { account_number: '2641', debit_amount: 0, credit_amount: 500 },
        { account_number: '2650', debit_amount: 0, credit_amount: 2000, line_description: 'Moms att betala' },
      ],
      filed_net: 2000,
    }),
  },
  {
    name: 'quarter with moms att återfå and öresutjämning',
    input: { period_type: 'quarterly', year: 2026, period: 2 },
    proposal: proposal({
      period: { type: 'quarterly', year: 2026, period: 2, start: '2026-04-01', end: '2026-06-30' },
      period_label: 'Kvartal 2 2026',
      entry_date: '2026-06-30',
      description: 'Momsredovisning Kvartal 2 2026',
      lines: [
        { account_number: '2611', debit_amount: 250.1, credit_amount: 0 },
        { account_number: '2641', debit_amount: 0, credit_amount: 5000 },
        { account_number: '1650', debit_amount: 4750, credit_amount: 0, line_description: 'Moms att återfå' },
        { account_number: '3740', debit_amount: 0, credit_amount: 0.1, line_description: 'Öres- och kronutjämning' },
      ],
      filed_net: -4750,
      rounding_amount: 0.1,
    }),
  },
  {
    name: 'helårsmoms with reverse charge, moved past a closed year, a draft already there',
    input: { period_type: 'yearly', year: 2025, period: 1, fiscal_period_id: FISCAL_PERIOD },
    proposal: proposal({
      period: { type: 'yearly', year: 2025, period: 1, start: '2025-01-01', end: '2025-12-31' },
      period_label: 'År 2025',
      entry_date: '2026-01-01',
      entry_date_reason: 'period_closed',
      description: 'Momsredovisning År 2025',
      lines: [
        { account_number: '2611', debit_amount: 10000, credit_amount: 0 },
        { account_number: '2614', debit_amount: 1250, credit_amount: 0 },
        { account_number: '2641', debit_amount: 0, credit_amount: 3000 },
        { account_number: '2645', debit_amount: 0, credit_amount: 1250 },
        { account_number: '2650', debit_amount: 0, credit_amount: 7000, line_description: 'Moms att betala' },
      ],
      filed_net: 7000,
      existing_entries: [
        {
          id: '00000000-0000-4000-8000-0000000d0001',
          status: 'draft',
          entry_date: '2026-01-01',
          source_type: 'vat_settlement',
          voucher_series: null,
          voucher_number: null,
        },
      ],
    }),
  },
]

function record(args: unknown[]): unknown[] {
  return [args.length, ...args.map((a, i) => (i === 0 ? SUPABASE : a === undefined ? '<undefined>' : a))]
}

/** A recorded call without its trailing undefined arguments (see the header). */
function trimTrailingUndefined(call: unknown[]): unknown[] {
  const args = call.slice(1)
  while (args.length > 0 && args[args.length - 1] === '<undefined>') args.pop()
  return [args.length, ...args]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface Run {
  name: string
  createJournalEntry: unknown[][]
  events: Array<Record<string, unknown>>
}

async function runScenarios(opts: { refuseEvent?: boolean } = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    mockedCreate.mockReset()
    vi.mocked(findFiscalPeriod).mockResolvedValue(FISCAL_PERIOD)
    vi.mocked(buildVatSettlementProposal).mockResolvedValue(s.proposal)
    mockedCreate.mockImplementation(async (_sb, _c, _u, input) => ({
      id: `je-${index}`,
      voucher_series: 'A',
      voucher_number: index + 1,
      entry_date: input.entry_date,
    }) as never)
    const { supabase, payloads } = createTableMockSupabase({
      fiscal_periods: { data: { id: FISCAL_PERIOD, name: '2025', period_start: '2025-01-01', period_end: '2025-12-31', is_closed: true } },
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    })
    const outcome = await bookVatSettlement({ supabase: supabase as never, companyId: COMPANY, userId: USER, log }, s.input)
    expect(outcome.ok, `${s.name}: ${JSON.stringify(outcome)}`).toBe(true)
    out.push({
      name: s.name,
      createJournalEntry: mockedCreate.mock.calls.map((c) => record(c as unknown[])),
      events: payloads('business_events', 'insert') as Array<Record<string, unknown>>,
    })
  }
  return out
}

describe('bookVatSettlement engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the engine exactly what it handed it before the port', async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, createJournalEntry: calls }) => ({
      name,
      createJournalEntry: calls.map(trimTrailingUndefined),
    }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
  })

  it('with POSTING_EVENTS=shadow hands the engine the same arguments, plus only the event link', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const shadow = await runScenarios()
    for (const [i, run] of shadow.entries()) {
      const before = off[i]!.createJournalEntry[0]!
      const call = run.createJournalEntry[0]!
      expect(run.createJournalEntry, run.name).toHaveLength(1)
      expect(call[0], run.name).toBe(7)
      expect(call.slice(1, 5), run.name).toEqual(before.slice(1, 5))
      // The adapter's commitMethod and rubricVersion positions, undefined as before.
      expect(call.slice(5, 7), run.name).toEqual(['<undefined>', '<undefined>'])
      expect(call[7], run.name).toEqual({ businessEvent: { id: expect.stringMatching(UUID), role: 'produced', onFailure: 'log' } })
      expect(run.events, run.name).toHaveLength(1)
      expect((call[7] as { businessEvent: { id: string } }).businessEvent.id).toBe(run.events[0]!.id)
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off call', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map((r) => r.createJournalEntry)).toEqual(off.map((r) => r.createJournalEntry))
    // The write was tried once per posting, and refused.
    expect(refused.map((r) => r.events.length)).toEqual(refused.map(() => 1))
  })

  it('records what happened in business terms', async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const event = (name: string) => runs.find((r) => r.name === name)!.events[0]!
    expect(event('quarter with moms att betala')).toMatchObject({
      kind: 'vat.settled',
      category: 'se.tax.settlement',
      occurred_on: '2026-03-31',
      subject_type: null,
      party_type: null,
      currency: 'SEK',
      amount: 2000,
      amount_sek: 2000,
      tax_amounts: [],
      evidence: { direction: 'out', link_basis: 'user_created' },
      pending_operation_id: null,
      jurisdiction: 'SE',
    })
    expect(event('quarter with moms att betala').mapping_version).toMatch(/^se\.vat-settlement@/)
    expect(event('quarter with moms att återfå and öresutjämning')).toMatchObject({
      occurred_on: '2026-06-30',
      amount: 4750,
      evidence: { direction: 'in' },
    })
    // The act is the period's settlement: dated the period's end, not the day the verifikat moved to.
    expect(event('helårsmoms with reverse charge, moved past a closed year, a draft already there')).toMatchObject({
      occurred_on: '2025-12-31',
      amount: 7000,
      evidence: { direction: 'out' },
    })
  })
})
