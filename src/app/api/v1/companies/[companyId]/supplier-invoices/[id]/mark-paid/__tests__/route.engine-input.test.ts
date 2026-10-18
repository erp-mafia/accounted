/**
 * Posting port, step 2e: what the v1 mark-paid door
 * (POST /api/v1/companies/{companyId}/supplier-invoices/{id}/mark-paid) hands
 * the engine, recorded call by call and compared with a committed fixture
 * (route.engine-input.json) that was taken before the door went through the
 * port. The payment verifikat comes from the caller's own rows, the
 * kontantmetoden generator or the 2440 clearing generator; a payment whose
 * invoice update fails, or that loses the settlement race, is reversed with
 * a storno on the payment date. Every argument is recorded, an absent one as
 * '<undefined>'; trailing undefined arguments are dropped before the
 * comparison (see
 * src/lib/bookkeeping/__tests__/supplier-payment-entries.engine-input.test.ts).
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run 'src/app/api/v1/companies/[companyId]/supplier-invoices/[id]/mark-paid/__tests__/route.engine-input.test.ts'
 *
 * Since the payment verifikat and the door's stornos post through the
 * posting port, the scenarios also run with POSTING_EVENTS=shadow and
 * strict: the engine must get the same arguments plus only the event link,
 * a refused event write must still book and reverse under shadow, and under
 * strict the door stops before the engine is called.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput } from '@/types'

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
}))
vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({
  anchorSupplierInvoiceDocument: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false, fiscal_period_id: 'fp-1' }),
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

const { validateApiKey, createServiceClientNoCookies } = await import('@/lib/auth/api-keys')
const { createJournalEntry, findFiscalPeriod, reverseEntry } = await import('@/lib/bookkeeping/engine')
const { POST } = await import('../route')

const mockedCreate = vi.mocked(createJournalEntry)
const mockedFindPeriod = vi.mocked(findFiscalPeriod)
const mockedReverse = vi.mocked(reverseEntry)

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
    supplier_id: SUPPLIER,
    arrival_number: 120 + index,
    supplier_invoice_number: `F-${6000 + index}`,
    invoice_date: '2026-09-01',
    due_date: '2026-09-30',
    received_date: '2026-09-02',
    status: 'approved',
    currency: 'SEK',
    exchange_rate: null,
    subtotal: 1200,
    subtotal_sek: 1200,
    vat_amount: 300,
    vat_amount_sek: 300,
    total: 1500,
    total_sek: 1500,
    vat_treatment: 'standard_25',
    reverse_charge: false,
    payment_reference: null,
    paid_amount: 0,
    remaining_amount: 1500,
    is_credit_note: false,
    credited_invoice_id: null,
    registration_journal_entry_id: REGISTRATION,
    payment_journal_entry_id: null,
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
  /** The invoice update after the payment verifikat: lost to a concurrent payment, or failed. */
  update?: 'lost' | 'error'
}

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
    name: "custom lines: the caller's own rows",
    invoice: invoice(3),
    body: {
      payment_date: '2026-10-01',
      lines: [
        { account_number: '2440', debit_amount: 1500, credit_amount: 0, line_description: 'Egen rad' },
        { account_number: '1930', debit_amount: 0, credit_amount: 1500 },
      ] satisfies CreateJournalEntryLineInput[],
    },
    accountingMethod: 'accrual',
  },
  {
    name: 'a concurrent payment wins: the payment verifikat is reversed on the payment date',
    invoice: invoice(4),
    body: { payment_date: '2026-10-02' },
    accountingMethod: 'accrual',
    update: 'lost',
  },
  {
    name: 'the invoice update fails: the payment verifikat is reversed on the payment date',
    invoice: invoice(5),
    body: { payment_date: '2026-10-03' },
    accountingMethod: 'accrual',
    update: 'error',
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
  const updated = { id: s.invoice.id, status: 'paid', total: 1500, paid_amount: 1500, remaining_amount: 0, paid_at: null, payment_journal_entry_id: 'je' }
  return createTableMockSupabase({
    business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    company_members: { data: { company_id: COMPANY, role: 'owner' } },
    supplier_invoices: [
      { data: s.invoice },
      s.update === 'lost' ? { data: null } : s.update === 'error' ? { error: { message: 'update refused', code: '42501' } } : { data: updated },
    ],
    company_settings: { data: { accounting_method: s.accountingMethod } },
    supplier_invoice_payments: { data: null },
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
    mockedFindPeriod.mockResolvedValue(PERIOD)
    mockedCreate.mockImplementation(async (_sb, _c, _u, input: CreateJournalEntryInput) => ({ id: `je-${index}`, ...input }) as never)
    mockedReverse.mockImplementation(async (_sb, _c, _u, entryId: string) => ({ id: `storno-${entryId}`, status: 'posted' }) as never)
    const mock = supabaseFor(s, opts)
    vi.mocked(createServiceClientNoCookies).mockReturnValue(mock.supabase as never)
    const request = new Request(`https://x.test/api/v1/companies/${COMPANY}/supplier-invoices/${s.invoice.id}/mark-paid`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Content-Type': 'application/json',
        'Idempotency-Key': `engine-input-v1-mark-paid-${++idempotency}-${Date.now()}`,
      },
      body: JSON.stringify(s.body),
    })
    const response = await POST(request, { params: Promise.resolve({ companyId: COMPANY, id: s.invoice.id }) })
    const body = (await response.json()) as { data?: Record<string, unknown>; error?: { code?: string } }
    out.push({
      name: s.name,
      calls: mockedCreate.mock.calls.map((c) => record(c as unknown[])),
      reversals: mockedReverse.mock.calls.map((c) => record(c as unknown[])),
      outcome: { status: response.status, error: body.error?.code ?? null },
      events: mock.findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('v1 supplier mark-paid engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    eventBus.clear()
    vi.mocked(validateApiKey).mockResolvedValue({
      userId: USER,
      companyId: COMPANY,
      apiKeyId: 'ak_1',
      apiKeyName: 'CI key',
      scopes: ['suppliers:write'],
      mode: 'live',
    } as never)
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
        expect(trimTrailingUndefined(before.calls[j]!)[0], run.name).toBe(4)
        expect(call[0], run.name).toBe(7)
        expect(call.slice(1, 5), run.name).toEqual(before.calls[j]!.slice(1, 5))
        expect(call.slice(5, 7), run.name).toEqual(['<undefined>', '<undefined>'])
        expect(call[7], run.name).toEqual({ businessEvent: { id: ids[0], role: 'produced', onFailure: 'log' } })
      }
      for (const [j, reversal] of run.reversals.entries()) {
        // Off, reverseEntry's five arguments (the payment date); shadow adds only the options with the link.
        expect(before.reversals[j]![0], run.name).toBe(5)
        expect(reversal[0], run.name).toBe(6)
        expect(reversal.slice(1, 6), run.name).toEqual(before.reversals[j]!.slice(1, 6))
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

  it('with POSTING_EVENTS=strict a refused event write stops the payment before the engine is called', { timeout: 60_000 }, async () => {
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
    // On an API key the caller's statement that it is paid is client_asserted.
    expect(events('accrual: a registered SEK invoice paid in full')[0]).toMatchObject({
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
      evidence: { link_basis: 'client_asserted' },
      jurisdiction: 'SE',
    })
    expect(events('accrual: a partial payment from a named account')[0]).toMatchObject({ amount: 600, amount_sek: 600 })
    expect(events('cash: a never-booked invoice')[0]).toMatchObject({ tax_amounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 300 }] })
    expect(events("custom lines: the caller's own rows")[0]).toMatchObject({ amount: 1500, amount_sek: null, mapping_version: null })
    // The door's own storno: ledger.storno of the invoice, system_derived, dated the day.
    for (const name of ['a concurrent payment wins', 'the invoice update fails']) {
      const [paid, storno] = events(name)
      expect(paid, name).toMatchObject({ kind: 'purchase.paid', subject_id: storno!.subject_id })
      expect(storno, name).toMatchObject({
        kind: 'ledger.storno',
        subject_type: 'supplier_invoice',
        party_type: null,
        amount: null,
        amount_sek: null,
        mapping_version: null,
        evidence: { link_basis: 'system_derived' },
      })
      expect(storno!.occurred_on, name).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})
