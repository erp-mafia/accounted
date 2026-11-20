/**
 * Posting port, step 2g: what the omföring of föregående års resultat hands
 * the engine, recorded call by call and compared with a committed fixture
 * (result-appropriation.engine-input.json) that was taken before the
 * producers went through the port: generateResultAppropriation (the close's
 * step 11, for an aktiebolag's profit and loss and an ideell förening) and
 * postHistoricalResultRepair (the catch-up script's posting). Every argument
 * of createJournalEntry is recorded, an absent one as '<undefined>', so an
 * extra argument or a changed input fails here. The ingående balans and the
 * period's lines are mocked: the producers' input is what is pinned, not the
 * plan (result-appropriation.test.ts and result-appropriation-repair.test.ts
 * test it).
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/core/bookkeeping/__tests__/result-appropriation.engine-input.test.ts
 *
 * Since the producers post through the posting port, the scenarios also run
 * with POSTING_EVENTS=shadow: the engine must get the same arguments plus
 * only the event link, and a refused event write must still post. The close's
 * scenarios hand the omföring the door's link basis as the close does; the
 * repair records system_derived on its own. Trailing undefined arguments
 * (the ledger adapter's commitMethod and rubricVersion positions) are dropped
 * before the comparison with the fixture, nothing else.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkBasisColumns } from '@/lib/links/link-basis'
import { createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: vi.fn(),
}))
vi.mock('@/lib/reports/opening-balances', () => ({ getOpeningBalances: vi.fn() }))
vi.mock('@/lib/bookkeeping/entry-lines', () => ({ fetchEntryLines: vi.fn() }))
vi.mock('../period-service', () => ({ findNextPeriod: vi.fn() }))

const { createJournalEntry } = await import('@/lib/bookkeeping/engine')
const { getOpeningBalances } = await import('@/lib/reports/opening-balances')
const { fetchEntryLines } = await import('@/lib/bookkeeping/entry-lines')
const { generateResultAppropriation } = await import('../result-appropriation-service')
const { postHistoricalResultRepair } = await import('../result-appropriation-repair')

const mockedCreate = vi.mocked(createJournalEntry)

const FIXTURE = path.join(__dirname, 'result-appropriation.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const PERIOD = '00000000-0000-4000-8000-00000000f002'
const OPENING_ENTRY = '00000000-0000-4000-8000-0000000e0001'

type Chain = Array<{ method: string; args: unknown[] }>

interface Scenario {
  name: string
  entityType: string
  /** The result account's ingående balans, credit-positive. */
  ib: { account: string; net: number }
  door: 'close' | 'repair'
  /** The close's door basis, handed down to the omföring (read only while the port is on). */
  linkBasis?: LinkBasisColumns
}

const OPERATION = '00000000-0000-4000-8000-0000000c0001'
const USER_CREATED: LinkBasisColumns = { link_basis: 'user_created', link_evidence: null }
const STAGED: LinkBasisColumns = { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OPERATION } }

const SCENARIOS: Scenario[] = [
  { name: 'aktiebolag: a profit carried from 2099 to 2098', entityType: 'aktiebolag', ib: { account: '2099', net: 48735 }, door: 'close', linkBasis: USER_CREATED },
  { name: 'aktiebolag: a loss carried from 2099 to 2098', entityType: 'aktiebolag', ib: { account: '2099', net: -12500.5 }, door: 'close', linkBasis: STAGED },
  { name: 'ideell förening: a surplus carried from 2069 to 2068', entityType: 'ideell_forening', ib: { account: '2069', net: 7300 }, door: 'close' },
  { name: 'repair: the 2099 an imported ingående balans still carries', entityType: 'aktiebolag', ib: { account: '2099', net: 25000 }, door: 'repair' },
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

const has = (chain: Chain, method: string, ...args: unknown[]) =>
  chain.some((c) => c.method === method && args.every((a, i) => c.args[i] === a))

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
  createJournalEntry: unknown[][]
  events: Array<Record<string, unknown>>
}

async function runScenarios(opts: { refuseEvent?: boolean } = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    mockedCreate.mockReset()
    mockedCreate.mockImplementation(async (_sb, _c, _u, input) => ({
      id: `je-${index}`,
      voucher_series: 'A',
      voucher_number: index + 2,
      entry_date: input.entry_date,
    }) as never)
    const { credit, debit } = s.ib.net >= 0 ? { credit: s.ib.net, debit: 0 } : { credit: 0, debit: -s.ib.net }
    vi.mocked(getOpeningBalances).mockResolvedValue({
      balances: new Map([[s.ib.account, { debit, credit }]]),
      obEntryId: OPENING_ENTRY,
    } as never)
    // The repair reads the result account's lines: only the ingående balans touches it.
    vi.mocked(fetchEntryLines).mockResolvedValue(
      (s.door === 'repair' ? [{ id: 'l-1', journal_entry_id: OPENING_ENTRY, debit_amount: debit, credit_amount: credit }] : []) as never,
    )
    const { supabase, payloads } = createTableMockSupabase({
      company_settings: { data: { entity_type: s.entityType } },
      companies: { data: { entity_type: s.entityType } },
      company_members: { data: { user_id: USER } },
      fiscal_periods: {
        data: {
          name: '2026',
          period_start: '2026-01-01',
          is_closed: false,
          locked_at: null,
          opening_balance_entry_id: OPENING_ENTRY,
        },
      },
      journal_entries: (chain: Chain) =>
        has(chain, 'eq', 'id', OPENING_ENTRY)
          ? { data: { id: OPENING_ENTRY, status: 'posted', source_type: 'opening_balance', voucher_series: 'A', voucher_number: 1 } }
          : { data: null },
      chart_of_accounts: { data: [{ account_number: '2098' }, { account_number: '2099' }] },
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    })
    if (s.door === 'close') {
      const linkBasis = s.linkBasis
      const entry = await generateResultAppropriation(supabase as never, COMPANY, USER, PERIOD, linkBasis ? () => ({ linkBasis }) : undefined)
      expect(entry, s.name).not.toBeNull()
    } else {
      const result = await postHistoricalResultRepair(supabase as never, COMPANY, USER, PERIOD)
      expect(result.assessment.status, JSON.stringify(result.assessment)).toBe('safe')
    }
    out.push({
      name: s.name,
      createJournalEntry: mockedCreate.mock.calls.map((c) => record(c as unknown[])),
      events: payloads('business_events', 'insert') as Array<Record<string, unknown>>,
    })
  }
  return out
}

describe('result appropriation engine input (posting port parity)', () => {
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
      expect(run.createJournalEntry, run.name).toHaveLength(1)
      const { call, link } = splitLink(run.createJournalEntry[0]!)
      expect(call, run.name).toEqual(trimTrailingUndefined(off[i]!.createJournalEntry[0]!))
      expect(link, run.name).toEqual({ id: expect.stringMatching(UUID), role: 'produced', onFailure: 'log' })
      expect(run.events.map((e) => e.id), run.name).toEqual([(link as { id: string }).id])
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off call', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map((r) => r.createJournalEntry)).toEqual(off.map((r) => r.createJournalEntry))
    expect(refused.map((r) => r.events.length)).toEqual(refused.map(() => 1))
  })

  it('records what happened in business terms', async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const event = (i: number) => runs[i]!.events[0]!
    expect(event(0)).toMatchObject({
      kind: 'year_end.result_appropriated',
      category: null,
      occurred_on: '2026-01-01',
      subject_type: 'fiscal_period',
      subject_id: PERIOD,
      party_type: null,
      currency: 'SEK',
      amount: 48735,
      amount_sek: 48735,
      tax_amounts: [],
      evidence: { link_basis: 'user_created' },
      pending_operation_id: null,
      jurisdiction: 'SE',
    })
    expect(event(0).mapping_version).toMatch(/^se\.result-appropriation@/)
    // A loss is a magnitude too; approved from a staged run_year_end, the event names the operation.
    expect(event(1)).toMatchObject({
      amount: 12500.5,
      evidence: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OPERATION } },
      pending_operation_id: OPERATION,
    })
    // A close whose door handed nothing down records no basis.
    expect(event(2)).toMatchObject({ amount: 7300, evidence: {} })
    // The historical repair: derived from the validated ingående balans, nobody chose the pair.
    expect(event(3)).toMatchObject({ amount: 25000, evidence: { link_basis: 'system_derived' }, pending_operation_id: null })
    expect(event(3).mapping_version).toMatch(/^se\.result-appropriation@/)
  })
})
