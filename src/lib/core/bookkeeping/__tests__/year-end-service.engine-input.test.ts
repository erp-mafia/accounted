/**
 * Posting port, step 2g: what the year-end close hands the engine, recorded
 * call by call and compared with a committed fixture
 * (year-end-service.engine-input.json) that was taken before the producer
 * went through the port: executeYearEndClosing's bokslutsverifikation and
 * ingående balans (generateOpeningBalances, with its project split and the
 * per-account retry when the database refuses the split before anything is
 * posted), the stornos it makes when the result accounts do not zero or the
 * IB/UB continuity fails, and generateOpeningBalances on its own (the staged
 * set_opening_balances door). Every argument of createJournalEntry and
 * reverseEntry is recorded, an absent one as '<undefined>', so an extra
 * argument or a changed input fails here, and so does a changed order of the
 * calls.
 *
 * The trial balance, the continuity check and the period service are
 * mocked, and so are the two producers the close calls that are pinned
 * elsewhere: the balansdagen revaluation (currency-revaluation.engine-input)
 * and the omföring (result-appropriation.engine-input). What is pinned here
 * is year-end-service's own input.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/core/bookkeeping/__tests__/year-end-service.engine-input.test.ts
 *
 * Since the producer posts through the posting port, the scenarios also run
 * with POSTING_EVENTS=shadow, with the link basis a door hands down: the
 * engine must get the same arguments plus only the event link (inside the
 * IB's own options object, beside replayDimensions), one event per verifikat
 * and per storno, the IB's per-account retry linked to the event its first
 * attempt recorded, and a refused event write must still post. Trailing
 * undefined arguments (the ledger adapter's commitMethod and rubricVersion
 * positions) are dropped before the comparison with the fixture, nothing
 * else.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import { eventBus } from '@/lib/events/bus'
import { createTableMockSupabase } from '@/tests/helpers'
import type { CreateJournalEntryInput, TrialBalanceRow } from '@/types'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: vi.fn(),
  reverseEntry: vi.fn(),
}))
vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: vi.fn() }))
vi.mock('@/lib/reports/continuity-check', () => ({ validateBalanceContinuity: vi.fn() }))
vi.mock('@/lib/bookkeeping/currency-revaluation', () => ({
  previewCurrencyRevaluation: vi.fn(async () => ({ items: [], lines: [], closingRates: {}, totalGain: 0, totalLoss: 0, netEffect: 0 })),
  executeCurrencyRevaluation: vi.fn(async () => null),
  syncCurrencyRevaluationReversals: vi.fn(async () => ({ posted: [], stornoed: [] })),
}))
vi.mock('../result-appropriation-service', () => ({
  generateResultAppropriation: vi.fn(async () => null),
  previewResultAppropriation: vi.fn(async () => null),
}))
vi.mock('../period-service', () => ({
  lockPeriod: vi.fn(),
  closePeriod: vi.fn(),
  countUnbookedInPeriod: vi.fn(async () => ({ untriaged: 0, businessUnbooked: 0 })),
  createNextPeriod: vi.fn(),
  findNextPeriod: vi.fn(),
  fiscalYearInTheWay: vi.fn().mockResolvedValue(null),
}))
vi.mock('../voucher-gaps', () => ({ listVoucherGaps: vi.fn(async () => ({ gaps: [], sequenceSeries: [] })) }))
vi.mock('../prior-result-carry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../prior-result-carry')>()),
  priorResultCarry: vi.fn(async () => null),
}))
vi.mock('../opening-balance-split', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../opening-balance-split')>()),
  fetchObjectClosingBalances: vi.fn(),
}))
vi.mock('@/lib/import/opening-balance/existing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/import/opening-balance/existing')>()),
  findExistingOpeningBalance: vi.fn(async () => null),
  assertNoOpeningBalance: vi.fn(async () => undefined),
  linkOpeningBalance: vi.fn(async () => null),
}))

const { createJournalEntry, reverseEntry } = await import('@/lib/bookkeeping/engine')
const { generateTrialBalance } = await import('@/lib/reports/trial-balance')
const { validateBalanceContinuity } = await import('@/lib/reports/continuity-check')
const { findNextPeriod } = await import('../period-service')
const { fetchObjectClosingBalances } = await import('../opening-balance-split')
const { executeYearEndClosing, generateOpeningBalances } = await import('../year-end-service')

const mockedCreate = vi.mocked(createJournalEntry)
const mockedReverse = vi.mocked(reverseEntry)

const FIXTURE = path.join(__dirname, 'year-end-service.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const CLOSING = '00000000-0000-4000-8000-00000000f001'
const NEXT = '00000000-0000-4000-8000-00000000f002'
const OPERATION = '00000000-0000-4000-8000-0000000c0001'
const USER_CREATED = { link_basis: 'user_created' as const, link_evidence: null }
const STAGED = { link_basis: 'agent_proposed_user_approved' as const, link_evidence: { pending_operation_id: OPERATION } }

type Chain = Array<{ method: string; args: unknown[] }>

const row = (account: string, name: string, debit: number, credit: number): TrialBalanceRow => ({
  account_number: account,
  account_name: name,
  account_class: Number(account[0]),
  opening_debit: 0,
  opening_credit: 0,
  period_debit: debit,
  period_credit: credit,
  closing_debit: debit,
  closing_credit: credit,
})

/** The year's books before the close: a profit of 81 000. */
const BALANCE_ROWS = [
  row('1470', 'Pågående arbeten', 5000, 0),
  row('1510', 'Kundfordringar', 11000, 0),
  row('1930', 'Företagskonto', 112500, 0),
  row('2081', 'Aktiekapital', 0, 25000),
  row('2440', 'Leverantörsskulder', 0, 5000),
  row('2611', 'Utgående moms 25 %', 0, 25000),
  row('2641', 'Ingående moms', 7500, 0),
]
const RESULT_ROWS = [row('3001', 'Försäljning tjänster 25 %', 0, 111000), row('5010', 'Lokalhyra', 30000, 0)]

/** After the close: every result account zeroed and the result on the form's closing account. */
function closedRows(closingAccount: string, closingName: string): TrialBalanceRow[] {
  return [
    ...BALANCE_ROWS,
    row(closingAccount, closingName, 0, 81000),
    ...RESULT_ROWS.map((r) => ({ ...r, closing_debit: r.period_debit + r.period_credit, closing_credit: r.period_debit + r.period_credit })),
  ]
}

interface Scenario {
  name: string
  entityType: 'aktiebolag' | 'enskild_firma'
  door: 'close' | 'opening_balances'
  /** The project split of 1470 the database reads back for the IB. */
  split?: boolean
  /** The engine refuses the split IB before anything is posted. */
  refuseSplit?: boolean
  /** The result accounts are not zero after the close. */
  resultNotZeroed?: boolean
  /** The IB/UB continuity check finds a discrepancy. */
  continuityFails?: boolean
  /** The scenario ends in an error (thrown after the stornos). */
  fails?: boolean
  /** What the door hands down (read only while the port is on). */
  linkBasis?: typeof USER_CREATED | typeof STAGED
}

const SCENARIOS: Scenario[] = [
  {
    name: 'aktiebolag: the bokslutsverifikation into 2099 and the ingående balans with its project split',
    entityType: 'aktiebolag',
    door: 'close',
    split: true,
    linkBasis: USER_CREATED,
  },
  { name: 'enskild firma: the bokslutsverifikation into 2010 and the ingående balans', entityType: 'enskild_firma', door: 'close', linkBasis: STAGED },
  {
    name: 'the split ingående balans refused before posting: booked again, one line per account',
    entityType: 'aktiebolag',
    door: 'close',
    split: true,
    refuseSplit: true,
    linkBasis: USER_CREATED,
  },
  {
    name: 'the result accounts do not zero after the close: the bokslutsverifikation stornoed',
    entityType: 'aktiebolag',
    door: 'close',
    resultNotZeroed: true,
    fails: true,
  },
  {
    name: 'the IB/UB continuity fails: the ingående balans and the bokslutsverifikation stornoed',
    entityType: 'aktiebolag',
    door: 'close',
    continuityFails: true,
    fails: true,
    linkBasis: STAGED,
  },
  {
    name: 'the ingående balans on its own, as the staged set_opening_balances door books it',
    entityType: 'aktiebolag',
    door: 'opening_balances',
    split: true,
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

const eqOf = (chain: Chain, column: string) => chain.find((c) => c.method === 'eq' && c.args[0] === column)?.args[1]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A shadow call without its event link, trimmed as the off call is, and the link it carried. */
function splitLink(call: unknown[]): { call: unknown[]; link: unknown } {
  const args = call.slice(1)
  const last = args[args.length - 1]
  if (last && typeof last === 'object' && 'businessEvent' in last) {
    const { businessEvent, ...rest } = last as Record<string, unknown>
    args[args.length - 1] = Object.keys(rest).length > 0 ? rest : '<undefined>'
    return { call: trimTrailingUndefined([args.length, ...args]), link: businessEvent }
  }
  return { call: trimTrailingUndefined(call), link: undefined }
}

interface Run {
  name: string
  /** Every engine call in order: ['createJournalEntry', ...args] or ['reverseEntry', ...args]. */
  calls: unknown[][]
  events: Array<Record<string, unknown>>
}

async function runScenarios(opts: { refuseEvent?: boolean } = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const s of SCENARIOS) {
    mockedCreate.mockReset()
    mockedReverse.mockReset()
    const calls: unknown[][] = []
    const closing = s.entityType === 'aktiebolag' ? (['2099', 'Årets resultat'] as const) : (['2010', 'Eget kapital'] as const)
    let closed = s.door === 'opening_balances'
    let n = 0
    mockedCreate.mockImplementation(async (...args: unknown[]) => {
      calls.push(['createJournalEntry', ...record(args)])
      const input = args[3] as CreateJournalEntryInput
      if (s.refuseSplit && input.source_type === 'opening_balance' && input.lines.some((l) => l.dimensions !== undefined)) {
        throw new BookkeepingDatabaseError('create_entry_lines', 'dimension bag refused', '23514')
      }
      if (input.source_type === 'year_end') closed = true
      n++
      return { id: `je-${n}`, voucher_series: 'A', voucher_number: n, entry_date: input.entry_date } as never
    })
    mockedReverse.mockImplementation(async (...args: unknown[]) => {
      calls.push(['reverseEntry', ...record(args)])
      n++
      return { id: `je-${n}`, voucher_series: 'A', voucher_number: n } as never
    })
    vi.mocked(generateTrialBalance).mockImplementation(async () => {
      const rows = closed && !s.resultNotZeroed ? closedRows(closing[0], closing[1]) : [...BALANCE_ROWS, ...RESULT_ROWS]
      return { rows, isBalanced: true, totalDebit: 0, totalCredit: 0 } as never
    })
    vi.mocked(validateBalanceContinuity).mockResolvedValue(
      (s.continuityFails
        ? { valid: false, discrepancies: [{ account_number: '1930', previous_ub_net: 112500, current_ib_net: 112400, difference: 100 }] }
        : { valid: true, discrepancies: [] }) as never,
    )
    vi.mocked(findNextPeriod).mockResolvedValue({ id: NEXT, name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' } as never)
    vi.mocked(fetchObjectClosingBalances).mockResolvedValue(
      new Map(s.split ? [['1470', [{ dimensions: { '6': 'P-100' }, amount: 3000 }]]] : []),
    )
    const periods: Record<string, Record<string, unknown>> = {
      [CLOSING]: {
        id: CLOSING,
        company_id: COMPANY,
        name: '2025',
        period_start: '2025-01-01',
        period_end: '2025-12-31',
        is_closed: false,
        locked_at: null,
        closing_entry_id: null,
        opening_balance_entry_id: null,
        import_hold: false,
        continuity_verified: null,
      },
      [NEXT]: { id: NEXT, company_id: COMPANY, name: '2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false },
    }
    const { supabase, payloads } = createTableMockSupabase({
      fiscal_periods: (chain: Chain) => ({ data: periods[eqOf(chain, 'id') as string] ?? null }),
      journal_entries: { data: [], count: 0 },
      company_settings: { data: { entity_type: s.entityType, accounting_method: 'accrual' } },
      invoices: { data: [] },
      supplier_invoices: { data: [] },
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    })
    const linkBasis = s.linkBasis
    const door = linkBasis ? () => ({ linkBasis }) : undefined
    const posting =
      s.door === 'close'
        ? executeYearEndClosing(supabase as never, COMPANY, USER, CLOSING, door)
        : generateOpeningBalances(supabase as never, COMPANY, USER, CLOSING, NEXT, door)
    if (s.fails) await expect(posting, s.name).rejects.toThrow()
    else await posting
    out.push({ name: s.name, calls, events: payloads('business_events', 'insert') as Array<Record<string, unknown>> })
  }
  return out
}

describe('year-end close engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    eventBus.clear()
  })

  it('hands the engine exactly what it handed it before the port', async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, calls }) => ({
      name,
      calls: calls.map(([fn, ...call]) => [fn, ...trimTrailingUndefined(call)]),
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
      expect(run.calls.map(([fn]) => fn), run.name).toEqual(off[i]!.calls.map(([fn]) => fn))
      const links = run.calls.map(([fn, ...call], j) => {
        const { call: bare, link } = splitLink(call)
        const [, ...offCall] = off[i]!.calls[j]!
        expect(bare, `${run.name} #${j}`).toEqual(trimTrailingUndefined(offCall))
        expect(link, `${run.name} #${j}`).toEqual({
          id: expect.stringMatching(UUID),
          role: fn === 'reverseEntry' ? 'reversal' : 'produced',
          onFailure: 'log',
        })
        return (link as { id: string }).id
      })
      // Every attempt records its event before the engine is called.
      expect(run.events.map((e) => e.id), run.name).toEqual(links)
    }
    // The refused split IB and its per-account retry: ONE event, recorded by both attempts.
    const retry = shadow.find((r) => r.name.startsWith('the split ingående balans refused'))!
    const ibLinks = retry.calls.slice(1).map(([, ...call]) => (splitLink(call).link as { id: string }).id)
    expect(ibLinks).toHaveLength(2)
    expect(ibLinks[1]).toBe(ibLinks[0])
    // The IB's link rides in its own options, beside replayDimensions.
    const ib = shadow[0]!.calls[1]!
    expect(ib[ib.length - 1]).toEqual({ replayDimensions: true, businessEvent: expect.objectContaining({ role: 'produced' }) })
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off call', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map((r) => r.calls)).toEqual(off.map((r) => r.calls))
    expect(refused.map((r) => r.events.length)).toEqual(off.map((r) => r.calls.length))
  })

  it('records what happened in business terms', async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const [closing, opening] = runs[0]!.events
    expect(closing).toMatchObject({
      kind: 'year_end.closing',
      category: null,
      occurred_on: '2025-12-31',
      subject_type: 'fiscal_period',
      subject_id: CLOSING,
      party_type: null,
      currency: 'SEK',
      amount: 81000,
      amount_sek: 81000,
      tax_amounts: [],
      evidence: { link_basis: 'user_created' },
      pending_operation_id: null,
      jurisdiction: 'SE',
    })
    expect(closing!.mapping_version).toMatch(/^se\.year-end-closing@/)
    // The ingående balans opens the next year: no amount, it carries balances.
    expect(opening).toMatchObject({
      kind: 'ledger.opening_balance',
      occurred_on: '2026-01-01',
      subject_type: 'fiscal_period',
      subject_id: NEXT,
      currency: null,
      amount: null,
      evidence: { link_basis: 'user_created' },
    })
    expect(opening!.mapping_version).toMatch(/^se\.opening-balance@/)
    // Approved from a staged run_year_end: every event names the operation.
    for (const event of runs[1]!.events) {
      expect(event).toMatchObject({
        evidence: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OPERATION } },
        pending_operation_id: OPERATION,
      })
    }
    // The stornos of a failed close: system_derived, still naming the approval, dated the day.
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date())
    const continuity = runs.find((r) => r.name.startsWith('the IB/UB continuity fails'))!
    expect(continuity.events.map((e) => [e.kind, e.subject_id])).toEqual([
      ['year_end.closing', CLOSING],
      ['ledger.opening_balance', NEXT],
      ['ledger.storno', NEXT],
      ['ledger.storno', CLOSING],
    ])
    for (const storno of continuity.events.slice(2)) {
      expect(storno).toMatchObject({
        occurred_on: today,
        amount: null,
        mapping_version: null,
        evidence: { link_basis: 'system_derived', link_evidence: { pending_operation_id: OPERATION } },
        pending_operation_id: OPERATION,
      })
    }
    // A close whose door handed nothing down records no basis, and its storno is system_derived.
    const notZeroed = runs.find((r) => r.name.startsWith('the result accounts do not zero'))!
    expect(notZeroed.events.map((e) => e.evidence)).toEqual([{}, { link_basis: 'system_derived' }])
  })
})

describe('year-end close: the balansdag revaluation turned back on the next year\'s first day (accounted#58)', () => {
  const REVALUATION = '00000000-0000-4000-8000-0000000e0f01'

  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    vi.stubEnv('POSTING_EVENTS', '')
    eventBus.clear()
  })

  /** One aktiebolag close whose step 2 posted a revaluation; every engine call in order. */
  async function closeWithRevaluation() {
    const { executeCurrencyRevaluation } = await import('@/lib/bookkeeping/currency-revaluation')
    vi.mocked(executeCurrencyRevaluation).mockResolvedValueOnce({
      entry: { id: REVALUATION },
      preview: { items: [], lines: [], closingRates: {}, totalGain: 500, totalLoss: 0, netEffect: 500 },
    } as never)
    const calls: Array<[string, string]> = []
    let closed = false
    mockedCreate.mockImplementation(async (...args: unknown[]) => {
      const input = args[3] as CreateJournalEntryInput
      calls.push(['createJournalEntry', input.source_type])
      if (input.source_type === 'year_end') closed = true
      return { id: `je-${input.source_type}`, voucher_series: 'A', voucher_number: 1, entry_date: input.entry_date } as never
    })
    mockedReverse.mockImplementation(async (...args: unknown[]) => {
      calls.push(['reverseEntry', args[3] as string])
      return { id: 'storno', voucher_series: 'A', voucher_number: 2 } as never
    })
    vi.mocked(generateTrialBalance).mockImplementation(async () => {
      const rows = closed ? closedRows('2099', 'Årets resultat') : [...BALANCE_ROWS, ...RESULT_ROWS]
      return { rows, isBalanced: true, totalDebit: 0, totalCredit: 0 } as never
    })
    vi.mocked(validateBalanceContinuity).mockResolvedValue({ valid: true, discrepancies: [] } as never)
    vi.mocked(findNextPeriod).mockResolvedValue({ id: NEXT, name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' } as never)
    vi.mocked(fetchObjectClosingBalances).mockResolvedValue(new Map())
    const periods: Record<string, Record<string, unknown>> = {
      [CLOSING]: {
        id: CLOSING, company_id: COMPANY, name: '2025', period_start: '2025-01-01', period_end: '2025-12-31',
        is_closed: false, locked_at: null, closing_entry_id: null, opening_balance_entry_id: null, import_hold: false,
      },
      [NEXT]: { id: NEXT, company_id: COMPANY, name: '2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false },
    }
    const { supabase } = createTableMockSupabase({
      fiscal_periods: (chain: Chain) => ({ data: periods[eqOf(chain, 'id') as string] ?? null }),
      journal_entries: { data: [], count: 0 },
      company_settings: { data: { entity_type: 'aktiebolag', accounting_method: 'accrual' } },
      invoices: { data: [] },
      supplier_invoices: { data: [] },
    })
    return { supabase, calls, run: () => executeYearEndClosing(supabase as never, COMPANY, USER, CLOSING, () => ({ linkBasis: USER_CREATED })) }
  }

  it('turns the revaluation back into the next year before the closing entry', async () => {
    const { syncCurrencyRevaluationReversals } = await import('@/lib/bookkeeping/currency-revaluation')
    const sync = vi.mocked(syncCurrencyRevaluationReversals)
    const { supabase, calls, run } = await closeWithRevaluation()
    sync.mockImplementationOnce(async () => {
      calls.push(['syncCurrencyRevaluationReversals', CLOSING])
      return { posted: [], stornoed: [] }
    })

    await run()

    expect(sync).toHaveBeenCalledWith(supabase, COMPANY, USER, CLOSING, expect.any(Function), { linkBasis: USER_CREATED })
    // The next year it books into is the one the close opens.
    await expect(sync.mock.calls[0]![4]()).resolves.toMatchObject({ id: NEXT, period_start: '2026-01-01' })
    expect(calls.map(([fn, what]) => `${fn}:${what}`)).toEqual([
      `syncCurrencyRevaluationReversals:${CLOSING}`,
      'createJournalEntry:year_end',
      'createJournalEntry:opening_balance',
    ])
  })

  it('a refused återföring stornoes the revaluation and stops before the closing entry', async () => {
    const { syncCurrencyRevaluationReversals } = await import('@/lib/bookkeeping/currency-revaluation')
    vi.mocked(syncCurrencyRevaluationReversals).mockRejectedValueOnce(new Error('Bookkeeping is locked through 2026-02-28'))
    const { calls, run } = await closeWithRevaluation()

    await expect(run()).rejects.toThrow('locked through')

    expect(calls).toEqual([['reverseEntry', REVALUATION]])
  })
})
