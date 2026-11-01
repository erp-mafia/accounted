/**
 * Posting port, step 2e: what the dashboard mark-paid door
 * (POST /api/supplier-invoices/[id]/mark-paid) hands the engine, recorded
 * call by call and compared with a committed fixture
 * (route.engine-input.json) that was taken before the door went through the
 * port. The payment verifikat comes from the person's own rows, the
 * kontantmetoden generator or the 2440 clearing generator; a payment that
 * loses the settlement race, or whose payment row cannot be recorded, is
 * cancelled through the engine's cleanup door. Every argument is recorded, an
 * absent one as '<undefined>'; trailing undefined arguments are dropped
 * before the comparison (see
 * src/lib/bookkeeping/__tests__/supplier-payment-entries.engine-input.test.ts).
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run 'src/app/api/supplier-invoices/[id]/mark-paid/__tests__/route.engine-input.test.ts'
 *
 * Since the payment verifikat posts through the posting port, the scenarios
 * also run with POSTING_EVENTS=shadow and strict: the engine must get the
 * same arguments plus only the event link, a refused event write must still
 * book under shadow, and under strict the door stops before the engine is
 * called.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createMockRouteParams, createTableMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput } from '@/types'

const client = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(client.current),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('00000000-0000-4000-8000-00000000c001'),
  getActiveCompanyId: vi.fn().mockResolvedValue('00000000-0000-4000-8000-00000000c001'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
  getCompanyRole: vi.fn().mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' }),
}))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  findFiscalPeriod: vi.fn(),
  createJournalEntry: vi.fn(),
  cancelOrphanedEntry: vi.fn(),
}))
vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({
  anchorSupplierInvoiceDocument: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/invoices/duplicate-guard-history', () => ({
  recordSupplierInvoiceDuplicateGuardBypass: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/invoices/duplicate-payment-candidates', () => ({
  findDuplicatePaymentCandidatesForSupplierInvoice: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/invoices/paid-events', () => ({
  emitSupplierInvoicePaidIfSettled: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/payments/orders/signed-payment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/orders/signed-payment')>()),
  findSignedBankPayment: vi.fn(async () => null),
}))

const { createJournalEntry, findFiscalPeriod, cancelOrphanedEntry } = await import('@/lib/bookkeeping/engine')
const { POST } = await import('../route')

const mockedCreate = vi.mocked(createJournalEntry)
const mockedFindPeriod = vi.mocked(findFiscalPeriod)
const mockedCancel = vi.mocked(cancelOrphanedEntry)

const FIXTURE = path.join(__dirname, 'route.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const SUPPLIER = '00000000-0000-4000-8000-00000000b001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'
const REGISTRATION = '00000000-0000-4000-8000-00000000e001'

function invoiceId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
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
    arrival_number: 100 + index,
    supplier_invoice_number: `F-${5000 + index}`,
    invoice_date: '2026-09-01',
    due_date: '2026-09-30',
    status: 'registered',
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
    paid_at: null,
    remaining_amount: 1500,
    registration_journal_entry_id: REGISTRATION,
    payment_journal_entry_id: null,
    document_id: null,
    default_dimensions: null,
    supplier: { id: SUPPLIER, name: 'Kontorsbolaget AB', supplier_type: 'swedish_business' },
    items: DOMESTIC_ITEMS,
    ...overrides,
  }
}

interface Scenario {
  name: string
  invoice: ReturnType<typeof invoice>
  body: Record<string, unknown>
  accountingMethod: 'accrual' | 'cash'
  /** A concurrent payment wins the invoice's status compare-and-set. */
  loseRace?: boolean
  /** The supplier_invoice_payments row cannot be written. */
  paymentRowFails?: boolean
}

const OWN_ROWS: CreateJournalEntryLineInput[] = [
  { account_number: '2440', debit_amount: 1500, credit_amount: 0, line_description: 'Egen rad' },
  { account_number: '1930', debit_amount: 0, credit_amount: 1500 },
]

const SCENARIOS: Scenario[] = [
  {
    name: 'accrual: a registered SEK invoice paid in full from the default account',
    invoice: invoice(0),
    body: { payment_date: '2026-09-28' },
    accountingMethod: 'accrual',
  },
  {
    name: 'accrual: a partial payment from a named account with a note',
    invoice: invoice(1, { default_dimensions: { '6': 'P100' } }),
    body: { payment_date: '2026-09-29', amount: 600, payment_account: '1931', notes: 'Delbetalning' },
    accountingMethod: 'accrual',
  },
  {
    name: 'cash: a never-booked invoice under kontantmetoden',
    invoice: invoice(2, { registration_journal_entry_id: null }),
    body: { payment_date: '2026-09-30' },
    accountingMethod: 'cash',
  },
  {
    name: "custom lines: the person's own rows on a registered invoice",
    invoice: invoice(3),
    body: { payment_date: '2026-10-01', lines: OWN_ROWS },
    accountingMethod: 'accrual',
  },
  {
    name: "custom lines: the person's own kontantmetoden rows",
    invoice: invoice(4, { registration_journal_entry_id: null }),
    body: {
      payment_date: '2026-10-02',
      lines: [
        { account_number: '5410', debit_amount: 1200, credit_amount: 0 },
        { account_number: '2641', debit_amount: 300, credit_amount: 0 },
        { account_number: '2893', debit_amount: 0, credit_amount: 1500 },
      ],
    },
    accountingMethod: 'cash',
  },
  {
    name: 'a concurrent payment wins: the payment verifikat is cancelled',
    invoice: invoice(5),
    body: { payment_date: '2026-10-03' },
    accountingMethod: 'accrual',
    loseRace: true,
  },
  {
    name: 'the payment row cannot be recorded: the invoice is rolled back and the verifikat cancelled',
    invoice: invoice(6),
    body: { payment_date: '2026-10-04' },
    accountingMethod: 'accrual',
    paymentRowFails: true,
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
  cancels: unknown[][]
  outcome: unknown
  events: Array<Record<string, unknown>>
}

interface RunOptions {
  /** The business_events insert refuses (a shadow failure). */
  refuseEvent?: boolean
}

function supabaseFor(s: Scenario, opts: RunOptions) {
  const mock = createTableMockSupabase({
    business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    supplier_invoices: [
      { data: s.invoice },
      { data: s.loseRace ? [] : [{ id: s.invoice.id }] },
      { data: null },
    ],
    company_settings: { data: { accounting_method: s.accountingMethod, last_supplier_payment_account: null } },
    supplier_invoice_payments: s.paymentRowFails ? { error: { message: 'insert refused', code: '42501' } } : { data: null },
    chart_of_accounts: { data: [] },
  })
  mock.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: USER, email: 'test@test.se' } }, error: null })
  return mock
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    mockedCreate.mockReset()
    mockedFindPeriod.mockReset()
    mockedCancel.mockReset()
    mockedFindPeriod.mockResolvedValue(PERIOD)
    mockedCreate.mockImplementation(async (_sb, _c, _u, input: CreateJournalEntryInput) => ({ id: `je-${index}`, ...input }) as never)
    mockedCancel.mockResolvedValue({ data: null, error: null } as never)
    const mock = supabaseFor(s, opts)
    client.current = mock.supabase
    const response = await POST(
      createMockRequest(`/api/supplier-invoices/${s.invoice.id}/mark-paid`, { method: 'POST', body: s.body }),
      createMockRouteParams({ id: s.invoice.id }),
    )
    const body = (await response.json()) as Record<string, unknown>
    out.push({
      name: s.name,
      calls: mockedCreate.mock.calls.map((c) => record(c as unknown[])),
      cancels: mockedCancel.mock.calls.map((c) => record(c as unknown[])),
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

describe('dashboard supplier mark-paid engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    eventBus.clear()
  })

  it('hands the engine exactly what it handed it before the port', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, calls, cancels, outcome }) => ({ name, calls: calls.map(trimTrailingUndefined), cancels, outcome }))
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
      expect(run.events, run.name).toHaveLength(before.calls.length)
      for (const [j, call] of run.calls.entries()) {
        expect(trimTrailingUndefined(before.calls[j]!)[0], run.name).toBe(4)
        expect(call[0], run.name).toBe(7)
        expect(call.slice(1, 5), run.name).toEqual(before.calls[j]!.slice(1, 5))
        expect(call.slice(5, 7), run.name).toEqual(['<undefined>', '<undefined>'])
        expect(call[7], run.name).toEqual({ businessEvent: { id: run.events[0]!.id, role: 'produced', onFailure: 'log' } })
      }
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still books, with exactly the off call', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    const view = (runs: Run[]) => runs.map(({ calls, cancels, outcome }) => ({ calls, cancels, outcome }))
    expect(view(refused)).toEqual(view(off))
  })

  it('with POSTING_EVENTS=strict a refused event write stops the payment before the engine is called', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const run of refused) {
      expect(run.calls, run.name).toEqual([])
      expect(run.cancels, run.name).toEqual([])
      expect((run.outcome as { status: number }).status, run.name).toBeGreaterThanOrEqual(400)
    }
  })

  it('records what happened in business terms', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const event = (name: string) => runs.find((r) => r.name.startsWith(name))!.events[0]!
    expect(event('accrual: a registered SEK invoice paid in full')).toMatchObject({
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
      evidence: { link_basis: 'user_created' },
      pending_operation_id: null,
      jurisdiction: 'SE',
    })
    expect(event('accrual: a registered SEK invoice paid in full').mapping_version).toMatch(/^se\.supplier-payment-lines@/)
    expect(event('accrual: a partial payment from a named account')).toMatchObject({ amount: 600, amount_sek: 600 })
    expect(event('cash: a never-booked invoice')).toMatchObject({
      amount: 1500,
      amount_sek: 1500,
      tax_amounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 300 }],
    })
    // The person's own rows and no payment account named: no SEK and no rule source.
    expect(event("custom lines: the person's own rows")).toMatchObject({ amount: 1500, amount_sek: null, mapping_version: null })
    expect(event("custom lines: the person's own kontantmetoden rows")).toMatchObject({
      amount_sek: null,
      mapping_version: null,
      tax_amounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 300 }],
    })
  })
})
