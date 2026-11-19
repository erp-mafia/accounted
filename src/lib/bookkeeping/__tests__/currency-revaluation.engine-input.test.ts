/**
 * Posting port, step 2g: what executeCurrencyRevaluation hands the engine,
 * recorded call by call and compared with a committed fixture
 * (currency-revaluation.engine-input.json) that was taken before the
 * producer went through the port. Every argument of createJournalEntry is
 * recorded, an absent one as '<undefined>', so an extra argument or a changed
 * input fails here. The ledgers and the Riksbanken rate are mocked with fixed
 * rows: the producer's input is what is pinned, not the preview (it has its
 * own tests in currency-revaluation.test.ts).
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/bookkeeping/__tests__/currency-revaluation.engine-input.test.ts
 *
 * Since the producer posts through the posting port, the scenarios also run
 * with POSTING_EVENTS=shadow: the engine must get the same arguments plus
 * only the event link, and a refused event write must still post. The
 * ledger adapter fills createJournalEntry's commitMethod and rubricVersion
 * positions, which this four-argument call receives as undefined, the value
 * its omitted optional parameters had: trailing undefined arguments are
 * dropped before the comparison with the fixture, nothing else.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runInOperationCommit } from '@/lib/pending-operations/commit-scope'
import { createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: vi.fn(),
}))
vi.mock('@/lib/currency/riksbanken', () => ({ fetchExchangeRate: vi.fn() }))

const { createJournalEntry } = await import('@/lib/bookkeeping/engine')
const { fetchExchangeRate } = await import('@/lib/currency/riksbanken')
const { executeCurrencyRevaluation } = await import('../currency-revaluation')

const mockedCreate = vi.mocked(createJournalEntry)

const FIXTURE = path.join(__dirname, 'currency-revaluation.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const FISCAL_PERIOD = '00000000-0000-4000-8000-00000000f001'

interface Scenario {
  name: string
  userId?: string
  invoices: Array<Record<string, unknown>>
  supplierInvoices: Array<Record<string, unknown>>
  rates: Record<string, number>
}

const invoice = (id: string, currency: string, total: number, rate: number) => ({
  id,
  invoice_number: `F-${id.slice(-1)}`,
  invoice_date: '2025-11-20',
  status: 'sent',
  document_type: 'invoice',
  currency,
  exchange_rate: rate,
  total,
  paid_amount: 0,
  paid_at: null,
  journal_entry_id: '00000000-0000-4000-8000-0000000e0001',
})

const supplierInvoice = (id: string, currency: string, total: number, rate: number) => ({
  id,
  supplier_invoice_number: `L-${id.slice(-1)}`,
  invoice_date: '2025-12-05',
  status: 'registered',
  currency,
  exchange_rate: rate,
  total,
  remaining_amount: total,
  paid_at: null,
  registration_journal_entry_id: '00000000-0000-4000-8000-0000000e0002',
})

const SCENARIOS: Scenario[] = [
  {
    name: 'a EUR receivable valued up and a USD payable valued up: a gain and a loss in one verifikat',
    invoices: [invoice('00000000-0000-4000-8000-0000000b0001', 'EUR', 1000, 11)],
    supplierInvoices: [supplierInvoice('00000000-0000-4000-8000-0000000b0002', 'USD', 2000, 10)],
    rates: { EUR: 11.5, USD: 10.5 },
  },
  {
    name: 'a EUR receivable valued down: a loss only',
    invoices: [invoice('00000000-0000-4000-8000-0000000b0003', 'EUR', 2500, 11.8)],
    supplierInvoices: [],
    rates: { EUR: 11.5 },
  },
  {
    name: 'a USD payable valued down, called without a user (the posting falls back to the company id): a gain only',
    userId: undefined,
    invoices: [],
    supplierInvoices: [supplierInvoice('00000000-0000-4000-8000-0000000b0004', 'USD', 400, 10.75)],
    rates: { USD: 10.5 },
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

interface Run {
  name: string
  createJournalEntry: unknown[][]
  events: Array<Record<string, unknown>>
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

async function runScenarios(opts: { refuseEvent?: boolean } = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    mockedCreate.mockReset()
    mockedCreate.mockImplementation(async (_sb, _c, _u, input) => ({
      id: `je-${index}`,
      voucher_series: 'A',
      voucher_number: index + 1,
      entry_date: input.entry_date,
    }) as never)
    vi.mocked(fetchExchangeRate).mockImplementation(async (currency) =>
      s.rates[currency] === undefined ? null : { currency, rate: s.rates[currency]!, date: '2025-12-31' },
    )
    const { supabase, payloads } = createTableMockSupabase({
      journal_entries: { count: 0 },
      company_settings: { data: { accounting_method: 'accrual', defer_invoice_booking: false } },
      invoices: { data: s.invoices },
      supplier_invoices: { data: s.supplierInvoices },
      invoice_payments: { data: [] },
      supplier_invoice_payments: { data: [] },
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    })
    const result = await executeCurrencyRevaluation(
      supabase as never,
      COMPANY,
      '2025-12-31',
      FISCAL_PERIOD,
      'userId' in s ? s.userId : USER,
    )
    expect(result, s.name).not.toBeNull()
    out.push({
      name: s.name,
      createJournalEntry: mockedCreate.mock.calls.map((c) => record(c as unknown[])),
      events: payloads('business_events', 'insert') as Array<Record<string, unknown>>,
    })
  }
  return out
}

describe('executeCurrencyRevaluation engine input (posting port parity)', () => {
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
    // The write was tried once per posting, and refused.
    expect(refused.map((r) => r.events.length)).toEqual(refused.map(() => 1))
  })

  it('records what happened in business terms', async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const event = (i: number) => runs[i]!.events[0]!
    // A gain of 500 on the receivable and a loss of 1 000 on the payable: a net loss of 500.
    expect(event(0)).toMatchObject({
      kind: 'ledger.currency_revaluation',
      category: 'finance.banking',
      occurred_on: '2025-12-31',
      subject_type: 'fiscal_period',
      subject_id: FISCAL_PERIOD,
      party_type: null,
      party_id: null,
      currency: 'SEK',
      amount: 500,
      amount_sek: 500,
      tax_amounts: [],
      evidence: { link_basis: 'user_created' },
      pending_operation_id: null,
      jurisdiction: 'SE',
    })
    expect(event(0).mapping_version).toMatch(/^se\.currency-revaluation@/)
    expect(event(1)).toMatchObject({ amount: 750, amount_sek: 750 })
    expect(event(2)).toMatchObject({ amount: 100, amount_sek: 100 })

    // Approved from a staged run_currency_revaluation: the event names the operation.
    const operation = '00000000-0000-4000-8000-0000000c0001'
    const staged = await runInOperationCommit(operation, () => runScenarios())
    expect(staged[0]!.events[0]).toMatchObject({
      evidence: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: operation } },
      pending_operation_id: operation,
    })
  })
})
