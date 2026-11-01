/**
 * Posting port, step 2e: what the v1 supplier bank match door
 * (POST /api/v1/companies/{companyId}/transactions/{id}/match-supplier-invoice)
 * hands the engine, recorded call by call and compared with a committed
 * fixture (route.engine-input.json) that was taken before the door went
 * through the port. A row that was categorized first is refused
 * (MATCH_SI_TX_ALREADY_BOOKED, accounted#58) unless the caller sends
 * storno_existing, which reverses that verifikat with a storno before the
 * payment is booked; a reconciliation link is always refused. The payment verifikat
 * comes from the caller's own rows or the generator the plan names; a payment
 * that loses the settlement race is cancelled through the engine's cleanup
 * door. Every argument is recorded, an absent one as '<undefined>'; trailing
 * undefined arguments are dropped before the comparison (see
 * src/lib/bookkeeping/__tests__/supplier-payment-entries.engine-input.test.ts).
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run 'src/app/api/v1/companies/[companyId]/transactions/[id]/match-supplier-invoice/__tests__/route.engine-input.test.ts'
 *
 * Since the storno and the payment verifikat post through the posting port,
 * the scenarios also run with POSTING_EVENTS=shadow and strict: the engine
 * must get the same arguments plus only the event link, a refused event
 * write must still reverse and book under shadow, and under strict the door
 * stops before the engine is called.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { CreateJournalEntryInput } from '@/types'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  findFiscalPeriod: vi.fn(),
  createJournalEntry: vi.fn(),
  reverseEntry: vi.fn(),
  cancelOrphanedEntry: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/settlement-account', () => ({
  resolveSettlementAccount: vi.fn(async () => '1930'),
}))
vi.mock('@/lib/bookkeeping/account-validation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/account-validation')>()),
  findUnresolvableAccounts: vi.fn(async () => []),
}))
vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({
  anchorSupplierInvoiceDocument: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/invoices/match-log', () => ({
  logMatchEvent: vi.fn(async () => undefined),
}))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/invoices/paid-events', () => ({
  emitSupplierInvoicePaidIfSettled: vi.fn().mockResolvedValue(undefined),
}))

const { validateApiKey, createServiceClientNoCookies } = await import('@/lib/auth/api-keys')
const { createJournalEntry, findFiscalPeriod, reverseEntry, cancelOrphanedEntry } = await import('@/lib/bookkeeping/engine')
const { POST } = await import('../route')

const mockedCreate = vi.mocked(createJournalEntry)
const mockedFindPeriod = vi.mocked(findFiscalPeriod)
const mockedReverse = vi.mocked(reverseEntry)
const mockedCancel = vi.mocked(cancelOrphanedEntry)

const FIXTURE = path.join(__dirname, 'route.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const SUPPLIER = '00000000-0000-4000-8000-00000000b001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'
const CASH_ACCOUNT = '00000000-0000-4000-8000-00000000ca01'
const REGISTRATION = '00000000-0000-4000-8000-00000000e001'
const CATEGORIZED = '00000000-0000-4000-8000-00000000e002'

function invoiceId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

function transactionId(index: number): string {
  return `00000000-0000-4000-8000-0000000a${String(index + 1).padStart(4, '0')}`
}

const DOMESTIC_ITEMS = [
  { id: 'item-0', sort_order: 0, description: 'Skärmar', quantity: 1, unit_price: 1000, line_total: 1000, account_number: '5410', vat_rate: 0.25, vat_amount: 250, dimensions: {} },
  { id: 'item-1', sort_order: 1, description: 'Pärmar', quantity: 1, unit_price: 200, line_total: 200, account_number: '6110', vat_rate: 0.25, vat_amount: 50, dimensions: {} },
]

function invoice(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: invoiceId(index),
    company_id: COMPANY,
    supplier_id: SUPPLIER,
    arrival_number: 140 + index,
    supplier_invoice_number: `F-${7000 + index}`,
    invoice_date: '2026-09-01',
    due_date: '2026-09-30',
    status: 'approved',
    currency: 'SEK',
    exchange_rate: null,
    subtotal: 1200,
    vat_amount: 300,
    vat_amount_sek: 300,
    total: 1500,
    total_sek: 1500,
    vat_treatment: 'standard_25',
    reverse_charge: false,
    paid_amount: 0,
    remaining_amount: 1500,
    registration_journal_entry_id: REGISTRATION,
    document_id: null,
    default_dimensions: null,
    supplier: { id: SUPPLIER, name: 'Kontorsbolaget AB', supplier_type: 'swedish_business' },
    items: DOMESTIC_ITEMS,
    ...overrides,
  }
}

function transaction(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: transactionId(index),
    company_id: COMPANY,
    date: '2026-09-28',
    amount: -1500,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
    cash_account_id: CASH_ACCOUNT,
    journal_entry_id: null,
    reconciliation_method: null,
    supplier_invoice_id: null,
    document_id: null,
    ...overrides,
  }
}

interface Scenario {
  name: string
  invoice: ReturnType<typeof invoice>
  transaction: ReturnType<typeof transaction>
  accountingMethod: 'accrual' | 'cash'
  lines?: Array<{ account_number: string; debit_amount: number; credit_amount: number; line_description?: string }>
  loseRace?: boolean
  /** Extra request body fields (storno_existing). */
  body?: Record<string, unknown>
}

const SCENARIOS: Scenario[] = [
  {
    name: 'accrual: a SEK row pays a registered invoice in full',
    invoice: invoice(0),
    transaction: transaction(0),
    accountingMethod: 'accrual',
  },
  {
    name: 'accrual: a whole-krona row settles an öre invoice with a bank fee on top',
    invoice: invoice(1, { total: 1499.6, total_sek: 1499.6, remaining_amount: 1499.6 }),
    transaction: transaction(1, { date: '2026-09-29', amount: -1520 }),
    accountingMethod: 'accrual',
  },
  {
    name: 'cash: a never-booked invoice under kontantmetoden',
    invoice: invoice(2, { registration_journal_entry_id: null }),
    transaction: transaction(2, { date: '2026-09-30' }),
    accountingMethod: 'cash',
  },
  {
    name: "custom lines: the caller's own rows",
    invoice: invoice(3),
    transaction: transaction(3, { date: '2026-10-01' }),
    accountingMethod: 'accrual',
    lines: [
      { account_number: '2440', debit_amount: 1500, credit_amount: 0, line_description: 'Egen rad' },
      { account_number: '1930', debit_amount: 0, credit_amount: 1500 },
    ],
  },
  {
    name: 'a categorized row with storno_existing: its verifikat is reversed before the payment is booked',
    invoice: invoice(4),
    transaction: transaction(4, { date: '2026-10-02', journal_entry_id: CATEGORIZED }),
    accountingMethod: 'accrual',
    body: { storno_existing: true },
  },
  {
    name: 'a reconciliation link is refused, even with storno_existing: nothing is reversed or booked',
    invoice: invoice(5),
    transaction: transaction(5, { date: '2026-10-03', journal_entry_id: CATEGORIZED, reconciliation_method: 'manual' }),
    accountingMethod: 'accrual',
    body: { storno_existing: true },
  },
  {
    name: 'a concurrent settlement wins: the payment verifikat is cancelled',
    invoice: invoice(6),
    transaction: transaction(6, { date: '2026-10-04' }),
    accountingMethod: 'accrual',
    loseRace: true,
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
  cancels: unknown[][]
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
    company_members: { data: { company_id: COMPANY, role: 'owner' } },
    // The read, then the row claim's compare-and-set.
    transactions: [{ data: s.transaction }, { data: [{ id: s.transaction.id }] }],
    // The verifikat a categorized row points at: booked from transaction(4).
    journal_entries: {
      data: [{ id: CATEGORIZED, status: 'posted', source_type: 'bank_transaction', source_id: transactionId(4), voucher_series: 'A', voucher_number: 12 }],
    },
    supplier_invoices: [{ data: s.invoice }, { data: s.loseRace ? [] : [{ id: s.invoice.id }] }],
    company_settings: { data: { accounting_method: s.accountingMethod } },
    supplier_invoice_payments: { data: { id: 'pay-1' } },
    document_attachments: { data: null },
    chart_of_accounts: { data: [] },
  })
}

let idempotency = 0

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    mockedCreate.mockReset()
    mockedFindPeriod.mockReset()
    mockedReverse.mockReset()
    mockedCancel.mockReset()
    mockedFindPeriod.mockResolvedValue(PERIOD)
    mockedCreate.mockImplementation(async (_sb, _c, _u, input: CreateJournalEntryInput) => ({ id: `je-${index}`, ...input }) as never)
    mockedReverse.mockImplementation(async (_sb, _c, _u, entryId: string) => ({ id: `storno-${entryId}`, status: 'posted' }) as never)
    mockedCancel.mockResolvedValue({ data: null, error: null } as never)
    const mock = supabaseFor(s, opts)
    vi.mocked(createServiceClientNoCookies).mockReturnValue(mock.supabase as never)
    const request = new Request(
      `https://x.test/api/v1/companies/${COMPANY}/transactions/${s.transaction.id}/match-supplier-invoice`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-fixture-not-a-real-key',
          'Content-Type': 'application/json',
          'Idempotency-Key': `engine-input-v1-match-si-${++idempotency}-${Date.now()}`,
        },
        body: JSON.stringify({ supplier_invoice_id: s.invoice.id, ...(s.lines ? { lines: s.lines } : {}), ...(s.body ?? {}) }),
      },
    )
    const response = await POST(request, { params: Promise.resolve({ companyId: COMPANY, id: s.transaction.id }) })
    const body = (await response.json()) as { data?: Record<string, unknown>; error?: { code?: string } }
    out.push({
      name: s.name,
      calls: mockedCreate.mock.calls.map((c) => record(c as unknown[])),
      reversals: mockedReverse.mock.calls.map((c) => record(c as unknown[])),
      cancels: mockedCancel.mock.calls.map((c) => record(c as unknown[])),
      outcome: { status: response.status, journal_entry_id: body.data?.journal_entry_id ?? null, error: body.error?.code ?? null },
      events: mock.findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('v1 supplier bank match engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    eventBus.clear()
    vi.mocked(validateApiKey).mockResolvedValue({
      userId: USER,
      companyId: COMPANY,
      apiKeyId: 'ak_1',
      apiKeyName: 'CI key',
      scopes: ['transactions:write'],
      mode: 'live',
    } as never)
  })

  it('hands the engine exactly what it handed it before the port', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, calls, reversals, cancels, outcome }) => ({
      name,
      calls: calls.map(trimTrailingUndefined),
      reversals,
      cancels,
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
      expect(run.cancels, run.name).toEqual(before.cancels)
      expect(run.calls, run.name).toHaveLength(before.calls.length)
      expect(run.reversals, run.name).toHaveLength(before.reversals.length)
      expect(run.events, run.name).toHaveLength(before.calls.length + before.reversals.length)
      // The storno of the row's earlier booking comes first, then the payment.
      const ids = run.events.map((e) => e.id)
      for (const [j, reversal] of run.reversals.entries()) {
        expect(before.reversals[j]![0], run.name).toBe(4)
        expect(reversal[0], run.name).toBe(6)
        expect(reversal.slice(1, 5), run.name).toEqual(before.reversals[j]!.slice(1, 5))
        expect(reversal[5], run.name).toBe('<undefined>')
        expect(reversal[6], run.name).toEqual({ businessEvent: { id: ids[0], role: 'reversal', onFailure: 'log' } })
      }
      for (const [j, call] of run.calls.entries()) {
        expect(trimTrailingUndefined(before.calls[j]!)[0], run.name).toBe(4)
        expect(call[0], run.name).toBe(7)
        expect(call.slice(1, 5), run.name).toEqual(before.calls[j]!.slice(1, 5))
        expect(call.slice(5, 7), run.name).toEqual(['<undefined>', '<undefined>'])
        expect(call[7], run.name).toEqual({ businessEvent: { id: ids[run.reversals.length], role: 'produced', onFailure: 'log' } })
      }
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still reverses and books, with exactly the off calls', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    const view = (runs: Run[]) => runs.map(({ calls, reversals, cancels, outcome }) => ({ calls, reversals, cancels, outcome }))
    expect(view(refused)).toEqual(view(off))
  })

  it('with POSTING_EVENTS=strict a refused event write stops the match before the engine is called', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const run of refused) {
      expect(run.calls, run.name).toEqual([])
      expect(run.reversals, run.name).toEqual([])
      expect(run.cancels, run.name).toEqual([])
      expect((run.outcome as { status: number }).status, run.name).toBeGreaterThanOrEqual(400)
    }
  })

  it('records what happened in business terms', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const events = (name: string) => runs.find((r) => r.name.startsWith(name))!.events
    // On an API key the caller's pairing is client_asserted.
    expect(events('accrual: a SEK row pays a registered invoice in full')[0]).toMatchObject({
      kind: 'purchase.paid',
      category: null,
      occurred_on: '2026-09-28',
      subject_type: 'supplier_invoice',
      subject_id: invoiceId(0),
      party_type: 'supplier',
      party_id: SUPPLIER,
      currency: 'SEK',
      amount: 1500,
      amount_sek: 1500,
      tax_amounts: [],
      evidence: { direction: 'out', link_basis: 'client_asserted' },
      jurisdiction: 'SE',
    })
    expect(events('accrual: a whole-krona row')[0]).toMatchObject({ amount: 1499.6, amount_sek: 1520 })
    expect(events('cash: a never-booked invoice')[0]).toMatchObject({ tax_amounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 300 }] })
    expect(events("custom lines: the caller's own rows")[0]).toMatchObject({ amount_sek: 1500, mapping_version: null })
    const [storno, paid] = events('a categorized row')
    // The caller chose this storno (storno_existing): on an API key, client_asserted.
    expect(storno).toMatchObject({
      kind: 'ledger.storno',
      subject_type: 'transaction',
      subject_id: transactionId(4),
      party_type: null,
      amount: null,
      evidence: { link_basis: 'client_asserted' },
    })
    expect(paid).toMatchObject({ kind: 'purchase.paid', subject_id: invoiceId(4) })
    expect(events('a reconciliation link')).toHaveLength(0)
  })
})
