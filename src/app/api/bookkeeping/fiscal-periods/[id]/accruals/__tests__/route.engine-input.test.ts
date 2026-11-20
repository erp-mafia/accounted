/**
 * Posting port, step 2g: what POST accruals (the year-end wizard's
 * periodiseringar) hands the engine, recorded call by call and compared with
 * a committed fixture (route.engine-input.json) that was taken before the
 * route went through the port. Every argument of createJournalEntry is
 * recorded, an absent one as '<undefined>', so an extra argument or a changed
 * input fails here. The calculators are the real ones (pure), except the
 * semesterlöneskuld's, which reads the payroll and is mocked with a fixed
 * proposal; the auth wrapper hands the handler a signed-in owner's context.
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run "src/app/api/bookkeeping/fiscal-periods/[id]/accruals/__tests__/route.engine-input.test.ts" *
 * Since the route posts through the posting port, the scenarios also run
 * with POSTING_EVENTS=shadow: the engine must get the same arguments plus
 * only the event link, one event per verifikat, and a refused event write
 * must still post. Trailing undefined arguments (the ledger adapter's
 * commitMethod and rubricVersion positions) are dropped before the
 * comparison with the fixture, nothing else.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runInOperationCommit } from '@/lib/pending-operations/commit-scope'
import { createTableMockSupabase } from '@/tests/helpers'

const route = vi.hoisted(() => ({ ctx: null as Record<string, unknown> | null }))

vi.mock('@/lib/api/with-route-context', () => ({
  withRouteContext:
    (_operation: string, handler: (request: Request, ctx: unknown, params: unknown) => Promise<Response>) =>
    (request: Request, params: unknown) =>
      handler(request, route.ctx, params),
}))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: vi.fn(),
}))
vi.mock('@/lib/bokslut/accruals/accrual-detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/accruals/accrual-detector')>()),
  proposeVacationLiabilityChange: vi.fn(),
}))

const { createJournalEntry } = await import('@/lib/bookkeeping/engine')
const { proposeVacationLiabilityChange } = await import('@/lib/bokslut/accruals/accrual-detector')
const { POST } = await import('../route')

const mockedCreate = vi.mocked(createJournalEntry)

const FIXTURE = path.join(__dirname, 'route.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'

type Chain = Array<{ method: string; args: unknown[] }>

interface Scenario {
  name: string
  items: Array<Record<string, unknown>>
  /** The ilike pattern of a periodisering already posted in the period. */
  alreadyPosted?: string
}

const SCENARIOS: Scenario[] = [
  {
    name: 'revisionsarvode, a förutbetald kostnad on a project, an upplupen ränta and a förutbetald intäkt',
    items: [
      { kind: 'audit_fee', amount: 15000 },
      {
        kind: 'manual_prepaid_expense',
        amount: 6000,
        expense_account: '5010',
        prepaid_account: '1710',
        description: 'Hyra januari 2026',
        dimensions: { '6': 'P-100' },
      },
      { kind: 'accrued_interest', amount: 1250.5, expense_account: '8410', accrued_account: '2960', description: 'Ränta december' },
      { kind: 'deferred_revenue', amount: 2000, revenue_account: '3001', deferred_account: '2970', description: 'Förskott kurs' },
    ],
  },
  {
    name: 'the semesterlöneskuld adjusted, a bokslut fee, an upplupen kostnad and one already posted, skipped',
    items: [
      { kind: 'vacation_liability_change' },
      { kind: 'audit_fee', amount: 8000, liability_account: '2991' },
      { kind: 'manual_accrued_expense', amount: 3000, expense_account: '6212', accrued_account: '2990', description: 'Telefoni december' },
      { kind: 'accrued_utility', amount: 900, expense_account: '5310', accrued_account: '2990', description: 'El december' },
    ],
    alreadyPosted: 'Periodisering: Upplupen förbrukning: El december%',
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
  for (const s of SCENARIOS) {
    mockedCreate.mockReset()
    let n = 0
    mockedCreate.mockImplementation(async (_sb, _c, _u, input) => {
      n++
      return { id: `je-${n}`, voucher_series: 'A', voucher_number: n, entry_date: input.entry_date } as never
    })
    vi.mocked(proposeVacationLiabilityChange).mockResolvedValue({
      kind: 'vacation_liability_change',
      label: 'Förändring av semesterlöneskuld',
      description: 'Debet 7290 och 7519, kredit 2920 och 2940.',
      amount: 4200,
      lines: [
        { account_number: '7290', debit_amount: 3200, credit_amount: 0, line_description: 'Förändring av semesterlöneskuld' },
        { account_number: '2920', debit_amount: 0, credit_amount: 3200, line_description: 'Upplupna semesterlöner' },
        { account_number: '7519', debit_amount: 1000, credit_amount: 0, line_description: 'Sociala avgifter på semesterlöneskuld' },
        { account_number: '2940', debit_amount: 0, credit_amount: 1000, line_description: 'Upplupna sociala avgifter' },
      ],
      reverses_on: null,
    } as never)
    const { supabase, payloads } = createTableMockSupabase({
      fiscal_periods: {
        data: { id: PERIOD, name: '2025', period_end: '2025-12-31', is_closed: false, locked_at: null, closing_entry_id: null },
      },
      journal_entries: (chain: Chain) =>
        chain.some((c) => c.method === 'ilike' && c.args[1] === s.alreadyPosted) ? { data: [{ id: 'je-existing' }] } : { data: [] },
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    })
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
    route.ctx = { user: { id: USER }, userId: USER, supabase, companyId: COMPANY, log, requestId: 'req-1' }
    const response = await POST(
      new Request('http://localhost/api', { method: 'POST', body: JSON.stringify({ items: s.items }) }),
      { params: Promise.resolve({ id: PERIOD }) },
    )
    expect(response.status, `${s.name}: ${await response.clone().text()}`).toBe(200)
    out.push({
      name: s.name,
      createJournalEntry: mockedCreate.mock.calls.map((c) => record(c as unknown[])),
      events: payloads('business_events', 'insert') as Array<Record<string, unknown>>,
    })
  }
  return out
}

describe('POST accruals (year-end periodiseringar) engine input (posting port parity)', () => {
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
      expect(run.createJournalEntry, run.name).toHaveLength(off[i]!.createJournalEntry.length)
      const links = run.createJournalEntry.map((c, j) => {
        const { call, link } = splitLink(c)
        expect(call, `${run.name} #${j}`).toEqual(trimTrailingUndefined(off[i]!.createJournalEntry[j]!))
        expect(link, `${run.name} #${j}`).toEqual({ id: expect.stringMatching(UUID), role: 'produced', onFailure: 'log' })
        return (link as { id: string }).id
      })
      expect(run.events.map((e) => e.id), run.name).toEqual(links)
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off call', async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map((r) => r.createJournalEntry)).toEqual(off.map((r) => r.createJournalEntry))
    expect(refused.map((r) => r.events.length)).toEqual(off.map((r) => r.createJournalEntry.length))
  })

  it('records what happened in business terms', async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const [auditFee, prepaid, interest, deferred] = runs[0]!.events
    expect(auditFee).toMatchObject({
      kind: 'ledger.accrual',
      category: null,
      occurred_on: '2025-12-31',
      subject_type: 'fiscal_period',
      subject_id: PERIOD,
      party_type: null,
      currency: 'SEK',
      amount: 15000,
      amount_sek: 15000,
      tax_amounts: [],
      evidence: { link_basis: 'user_created' },
      pending_operation_id: null,
      jurisdiction: 'SE',
    })
    expect(auditFee!.mapping_version).toMatch(/^se\.year-end-accruals@/)
    expect([prepaid, interest, deferred].map((e) => [e!.kind, e!.amount])).toEqual([
      ['ledger.accrual', 6000],
      ['ledger.accrual', 1251],
      ['ledger.accrual', 2000],
    ])
    // The semesterlöneskuld adjusted: the kind the semesterårsavslut records, a personnel cost.
    expect(runs[1]!.events.map((e) => [e.kind, e.category, e.amount])).toEqual([
      ['payroll.vacation_liability_adjusted', 'expense.personnel', 4200],
      ['ledger.accrual', null, 8000],
      ['ledger.accrual', null, 3000],
    ])
    const operation = '00000000-0000-4000-8000-0000000c0001'
    const staged = await runInOperationCommit(operation, () => runScenarios())
    expect(staged[0]!.events[0]).toMatchObject({
      evidence: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: operation } },
      pending_operation_id: operation,
    })
  })
})
