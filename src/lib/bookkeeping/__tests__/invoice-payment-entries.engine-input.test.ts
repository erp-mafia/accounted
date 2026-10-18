/**
 * Posting port, step 2f-2: what the customer invoice payment generators hand
 * the engine, recorded call by call and compared with a committed fixture
 * (invoice-payment-entries.engine-input.json) that was taken before the
 * producers went through the port. createInvoicePaymentJournalEntry is the
 * faktureringsmetoden payment (the 1510 clearing) behind every mark-paid
 * door; createInvoiceCashEntry is the kontantmetoden payment (the sale and
 * its moms at payment) behind mark-paid, the kontantfaktura at issue and
 * every bank match door. Every argument of every createJournalEntry call is
 * recorded, an absent one as '<undefined>', so an extra argument or a
 * changed input fails here; trailing undefined arguments are dropped before
 * the comparison (the ledger adapter fills createJournalEntry's commitMethod
 * and rubricVersion positions, which a four-argument call receives as
 * undefined, the value its omitted optional parameters had).
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/bookkeeping/__tests__/invoice-payment-entries.engine-input.test.ts
 *
 * Since the generators post through the posting port, the scenarios also run
 * with POSTING_EVENTS=shadow and strict: the engine must get the same
 * arguments plus only the event link, a refused event write must still post
 * under shadow and stop the posting under strict, and the door's posting
 * context is read only while the port is on.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { CreateJournalEntryInput, EntityType, Invoice, InvoiceItem, Transaction } from '@/types'

// The engine calls the generators make are recorded; everything else in the
// engine stays real.
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  findFiscalPeriod: vi.fn(),
  createJournalEntry: vi.fn(),
}))

const { createJournalEntry, findFiscalPeriod } = await import('@/lib/bookkeeping/engine')
const { BookkeepingDatabaseError } = await import('@/lib/bookkeeping/errors')
const { createInvoicePaymentJournalEntry, createInvoiceCashEntry } = await import('../invoice-entries')

const mockedCreate = vi.mocked(createJournalEntry)
const mockedFindPeriod = vi.mocked(findFiscalPeriod)

const FIXTURE = path.join(__dirname, 'invoice-payment-entries.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const CUSTOMER = '00000000-0000-4000-8000-00000000b001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'
const CASH_ACCOUNT = '00000000-0000-4000-8000-00000000d001'
const OPERATION = '00000000-0000-4000-8000-00000000e002'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** What a door hands down for the event (read only while the port is on). */
interface Posting {
  linkBasis: { link_basis: 'user_created' | 'user_confirmed' | 'agent_proposed_user_approved'; link_evidence: { pending_operation_id: string } | null }
  settledAmount: number
}

const USER_CREATED = (settledAmount: number): Posting => ({ linkBasis: { link_basis: 'user_created', link_evidence: null }, settledAmount })
const CONFIRMED = (settledAmount: number): Posting => ({ linkBasis: { link_basis: 'user_confirmed', link_evidence: null }, settledAmount })
const STAGED = (settledAmount: number): Posting => ({
  linkBasis: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OPERATION } },
  settledAmount,
})

/** A stable UUID per scenario: the invoice row's id. */
function invoiceId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

function transactionId(index: number): string {
  return `00000000-0000-4000-8000-1${String(index + 1).padStart(11, '0')}`
}

type PaidInvoice = Invoice & { items?: InvoiceItem[]; deduction_total?: number; default_dimensions?: Record<string, string> }

function item(index: number, sortOrder: number, overrides: Partial<InvoiceItem>): InvoiceItem {
  return {
    id: `item-${index}-${sortOrder}`,
    invoice_id: invoiceId(index),
    sort_order: sortOrder,
    line_type: 'product',
    description: `Rad ${sortOrder + 1}`,
    quantity: 1,
    unit: 'st',
    unit_price: 0,
    line_total: 0,
    vat_rate: 25,
    vat_amount: 0,
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  } as InvoiceItem
}

function invoice(index: number, overrides: Partial<PaidInvoice> = {}): PaidInvoice {
  return {
    id: invoiceId(index),
    user_id: USER,
    company_id: COMPANY,
    customer_id: CUSTOMER,
    invoice_number: `F-${1000 + index}`,
    invoice_date: '2026-09-01',
    due_date: '2026-09-30',
    delivery_date: null,
    status: 'sent',
    currency: 'SEK',
    exchange_rate: null,
    exchange_rate_date: null,
    subtotal: 1200,
    subtotal_sek: 1200,
    vat_amount: 300,
    vat_amount_sek: 300,
    total: 1500,
    total_sek: 1500,
    ore_rounding: null,
    vat_treatment: 'standard_25',
    vat_rate: 25,
    moms_ruta: '05',
    your_reference: null,
    our_reference: null,
    notes: null,
    reverse_charge_text: null,
    credited_invoice_id: null,
    document_type: 'invoice',
    converted_from_id: null,
    paid_at: null,
    paid_amount: 0,
    remaining_amount: 1500,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    items: [item(index, 0, { description: 'Konsulttimmar', quantity: 12, unit: 'tim', unit_price: 100, line_total: 1200, vat_amount: 300 })],
    ...overrides,
  } as PaidInvoice
}

type BankRow = Pick<Transaction, 'id' | 'cash_account_id' | 'date' | 'amount' | 'currency'>

function bankRow(index: number, amount: number, date = '2026-09-15'): BankRow {
  return { id: transactionId(index), cash_account_id: CASH_ACCOUNT, date, amount, currency: 'SEK' }
}

const RUT_INVOICE = (index: number) =>
  invoice(index, {
    subtotal: 4800,
    subtotal_sek: 4800,
    vat_amount: 1200,
    vat_amount_sek: 1200,
    total: 6000,
    total_sek: 6000,
    remaining_amount: 3500,
    deduction_total: 2500,
    items: [
      item(index, 0, {
        description: 'Städning',
        quantity: 10,
        unit: 'tim',
        unit_price: 400,
        line_total: 4000,
        vat_amount: 1000,
        deduction_type: 'rut',
        deduction_amount: 2500,
        labor_hours: 10,
        work_type: 'STAD',
      }),
      item(index, 1, { description: 'Material', unit_price: 800, line_total: 800, vat_amount: 200 }),
    ],
  })

const EUR = (index: number) =>
  invoice(index, {
    currency: 'EUR',
    exchange_rate: 11.5,
    exchange_rate_date: '2026-09-01',
    subtotal: 200,
    subtotal_sek: 2300,
    vat_amount: 0,
    vat_amount_sek: 0,
    total: 200,
    total_sek: 2300,
    remaining_amount: 200,
    vat_treatment: 'reverse_charge',
    vat_rate: 0,
    moms_ruta: '39',
    reverse_charge_text: 'Omvänd betalningsskyldighet',
    items: [item(index, 0, { description: 'Hosting', unit_price: 200, line_total: 200, vat_rate: 0, vat_amount: 0 })],
  })

interface PaymentScenario {
  name: string
  kind: 'payment'
  invoice: PaidInvoice
  paymentDate: string
  exchangeRateDifference?: number
  customerName?: string
  paymentAmount?: number
  settlementAccountNumber?: string
  bankTransaction?: BankRow
  noPeriod?: boolean
  posting?: Posting
}

interface CashScenario {
  name: string
  kind: 'cash'
  invoice: PaidInvoice
  paymentDate: string
  entityType?: EntityType
  customerName?: string
  settlementAccountNumber?: string
  bankTransaction?: BankRow
  overpaymentAccount?: string
  noPeriod?: boolean
  posting?: Posting
}

type Scenario = PaymentScenario | CashScenario

const SCENARIOS: Scenario[] = [
  {
    name: 'payment: an issued SEK invoice paid in full to 1930',
    kind: 'payment',
    invoice: invoice(0),
    paymentDate: '2026-09-15',
    customerName: 'Kund AB',
    posting: USER_CREATED(1500),
  },
  {
    name: 'payment: a partial payment',
    kind: 'payment',
    invoice: invoice(1),
    paymentDate: '2026-09-16',
    customerName: 'Kund AB',
    paymentAmount: 600,
    posting: STAGED(600),
  },
  {
    name: 'payment: an EUR invoice paid with a kursvinst',
    kind: 'payment',
    invoice: EUR(2),
    paymentDate: '2026-09-17',
    exchangeRateDifference: 40,
    customerName: 'Kunde GmbH',
    posting: USER_CREATED(200),
  },
  {
    name: 'payment: an EUR invoice paid with a kursförlust',
    kind: 'payment',
    invoice: EUR(3),
    paymentDate: '2026-09-18',
    exchangeRateDifference: -25.5,
    customerName: 'Kunde GmbH',
  },
  {
    name: 'payment: a card payment settled into the PSP balance on 1686',
    kind: 'payment',
    invoice: invoice(4),
    paymentDate: '2026-09-19',
    customerName: 'Kund AB',
    settlementAccountNumber: '1686',
  },
  {
    name: 'payment: from a bank row, with the bank booking context',
    kind: 'payment',
    invoice: invoice(5),
    paymentDate: '2026-09-15',
    settlementAccountNumber: '1940',
    bankTransaction: bankRow(5, 1500),
    posting: CONFIRMED(1500),
  },
  {
    name: 'payment: a RUT invoice settles the customer share only',
    kind: 'payment',
    invoice: RUT_INVOICE(6),
    paymentDate: '2026-09-20',
    customerName: 'Privatkund',
    posting: USER_CREATED(3500),
  },
  {
    name: 'payment: the invoice dimensions ride every leg',
    kind: 'payment',
    invoice: invoice(7, { default_dimensions: { '6': 'P100' } }),
    paymentDate: '2026-09-21',
    customerName: 'Kund AB',
  },
  {
    name: 'payment: no open fiscal period, nothing posted',
    kind: 'payment',
    invoice: invoice(8),
    paymentDate: '2026-09-22',
    noPeriod: true,
  },
  {
    name: 'cash: kontantmetoden books the sale and its moms at payment for an aktiebolag',
    kind: 'cash',
    invoice: invoice(9),
    paymentDate: '2026-09-15',
    entityType: 'aktiebolag',
    customerName: 'Kund AB',
    posting: USER_CREATED(1500),
  },
  {
    name: 'cash: mixed rates for an enskild firma',
    kind: 'cash',
    invoice: invoice(10, {
      subtotal: 1600,
      subtotal_sek: 1600,
      vat_amount: 192,
      vat_amount_sek: 192,
      total: 1792,
      total_sek: 1792,
      remaining_amount: 1792,
      items: [
        item(10, 0, { description: 'Arbete', unit_price: 600, line_total: 600, vat_amount: 150 }),
        item(10, 1, { description: 'Mat', unit_price: 200, line_total: 200, vat_rate: 12, vat_amount: 24 }),
        item(10, 2, { description: 'Böcker', unit_price: 300, line_total: 300, vat_rate: 6, vat_amount: 18 }),
        item(10, 3, { description: 'Tryck', unit_price: 500, line_total: 500, vat_rate: 0, vat_amount: 0, revenue_account: '3004' }),
      ],
    }),
    paymentDate: '2026-09-16',
    entityType: 'enskild_firma',
    customerName: 'Kund AB',
  },
  {
    name: 'cash: a RUT invoice debits 1513 for the deduction',
    kind: 'cash',
    invoice: RUT_INVOICE(11),
    paymentDate: '2026-09-17',
    entityType: 'aktiebolag',
    customerName: 'Privatkund',
    posting: USER_CREATED(3500),
  },
  {
    name: 'cash: from a bank row 40 öre short of the total, the gap on 3740',
    kind: 'cash',
    invoice: invoice(12, { total: 1500.4, total_sek: 1500.4, vat_amount: 300.08, vat_amount_sek: 300.08, subtotal: 1200.32, subtotal_sek: 1200.32, items: [] }),
    paymentDate: '2026-09-18',
    entityType: 'aktiebolag',
    settlementAccountNumber: '1940',
    bankTransaction: bankRow(12, 1500, '2026-09-18'),
    posting: CONFIRMED(1500.4),
  },
  {
    name: 'cash: from a bank row paying too much, the excess on 2420',
    kind: 'cash',
    invoice: invoice(13),
    paymentDate: '2026-09-19',
    entityType: 'aktiebolag',
    customerName: 'Kund AB',
    bankTransaction: bankRow(13, 1700, '2026-09-19'),
    overpaymentAccount: '2420',
    posting: STAGED(1500),
  },
  {
    name: 'cash: an EUR invoice under reverse charge',
    kind: 'cash',
    invoice: EUR(14),
    paymentDate: '2026-09-20',
    entityType: 'aktiebolag',
    customerName: 'Kunde GmbH',
    posting: USER_CREATED(200),
  },
  {
    name: 'cash: no open fiscal period, nothing posted',
    kind: 'cash',
    invoice: invoice(15),
    paymentDate: '2026-09-21',
    noPeriod: true,
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
  calls: unknown[][]
  outcome: unknown
  events: Array<Record<string, unknown>>
  /** How often the door's posting context was read. */
  postingReads: number
}

interface RunOptions {
  /** The business_events insert refuses (a shadow failure). */
  refuseEvent?: boolean
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    mockedCreate.mockReset()
    mockedFindPeriod.mockReset()
    mockedFindPeriod.mockResolvedValue(s.noPeriod ? null : PERIOD)
    mockedCreate.mockImplementation(async (_sb, _c, _u, input: CreateJournalEntryInput) => ({ id: `je-${index}`, ...input }) as never)
    const { supabase, findCalls } = createTableMockSupabase({
      business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
      chart_of_accounts: { data: [] },
    })
    let postingReads = 0
    const posting = s.posting
      ? () => {
          postingReads++
          return s.posting!
        }
      : undefined
    let outcome: unknown
    try {
      const entry =
        s.kind === 'payment'
          ? await createInvoicePaymentJournalEntry(
              supabase as never,
              COMPANY,
              USER,
              s.invoice,
              s.paymentDate,
              s.exchangeRateDifference,
              s.customerName,
              s.paymentAmount,
              s.settlementAccountNumber,
              s.bankTransaction,
              posting,
            )
          : await createInvoiceCashEntry(
              supabase as never,
              COMPANY,
              USER,
              s.invoice,
              s.paymentDate,
              s.entityType,
              s.customerName,
              s.settlementAccountNumber,
              s.bankTransaction,
              s.overpaymentAccount,
              posting,
            )
      outcome = entry ? { posted: entry.id } : null
    } catch (err) {
      outcome = { threw: err instanceof BookkeepingDatabaseError ? 'BookkeepingDatabaseError' : String(err) }
    }
    out.push({
      name: s.name,
      calls: mockedCreate.mock.calls.map((c) => record(c as unknown[])),
      outcome,
      events: findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
      postingReads,
    })
  }
  return out
}

describe('customer invoice payment generators engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the engine exactly what it handed it before the port', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, calls, outcome }) => ({ name, calls: calls.map(trimTrailingUndefined), outcome }))
    if (process.env.UPDATE_ENGINE_INPUT_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
    expect(runs.flatMap((r) => r.events)).toEqual([])
    // Off, the door's context is never even read.
    expect(runs.map((r) => r.postingReads)).toEqual(runs.map(() => 0))
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
      // No period: nothing posted and nothing recorded.
      expect(run.events, run.name).toHaveLength(before.calls.length)
      for (const [j, call] of run.calls.entries()) {
        // Off, the adapter's six-argument call: the producer's four plus two undefined positions.
        expect(trimTrailingUndefined(before.calls[j]!)[0], run.name).toBe(4)
        expect(call[0], run.name).toBe(7)
        expect(call.slice(1, 5), run.name).toEqual(before.calls[j]!.slice(1, 5))
        // The adapter's commitMethod and rubricVersion positions, undefined as before.
        expect(call.slice(5, 7), run.name).toEqual(['<undefined>', '<undefined>'])
        expect(call[7], run.name).toEqual({ businessEvent: { id: run.events[0]!.id, role: 'produced', onFailure: 'log' } })
      }
    }
  })

  it('with POSTING_EVENTS=shadow a refused event write still posts, with exactly the off call', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const off = await runScenarios()
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const refused = await runScenarios({ refuseEvent: true })
    expect(refused.map(({ calls, outcome }) => ({ calls, outcome }))).toEqual(off.map(({ calls, outcome }) => ({ calls, outcome })))
    // The write was tried once per posting, and refused.
    expect(refused.map((r) => r.events.length)).toEqual(off.map((r) => r.calls.length))
  })

  it('with POSTING_EVENTS=strict a refused event write stops the posting before the engine is called', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const run of refused) {
      expect(run.calls, run.name).toEqual([])
      if (run.name.includes('no open fiscal period')) expect(run.outcome, run.name).toBeNull()
      else expect(run.outcome, run.name).toEqual({ threw: 'BookkeepingDatabaseError' })
    }
  })

  it('records what happened in business terms', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const event = (name: string) => runs.find((r) => r.name.startsWith(name))!.events[0]!

    expect(event('payment: an issued SEK invoice')).toMatchObject({
      kind: 'sale.payment_received',
      category: null,
      occurred_on: '2026-09-15',
      subject_type: 'invoice',
      subject_id: invoiceId(0),
      party_type: 'customer',
      party_id: CUSTOMER,
      currency: 'SEK',
      amount: 1500,
      amount_sek: 1500,
      // Faktureringsmetoden: the moms was the registration's.
      tax_amounts: [],
      evidence: { link_basis: 'user_created' },
      pending_operation_id: null,
      jurisdiction: 'SE',
      idempotency_key: null,
    })
    expect(event('payment: an issued SEK invoice').mapping_version).toMatch(/^se\.customer-payment-lines@/)
    // A staged partial names its operation; the kronor are the bank leg's.
    expect(event('payment: a partial payment')).toMatchObject({
      amount: 600,
      amount_sek: 600,
      evidence: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OPERATION } },
      pending_operation_id: OPERATION,
    })
    // The debt in EUR; the kronor that arrived, the kursvinst included.
    expect(event('payment: an EUR invoice paid with a kursvinst')).toMatchObject({ currency: 'EUR', amount: 200, amount_sek: 2340, tax_amounts: [] })
    // From a bank row: money in, the kronor on the row's account.
    expect(event('payment: from a bank row')).toMatchObject({ amount_sek: 1500, evidence: { direction: 'in', link_basis: 'user_confirmed' } })
    // The customer's share only: the deduction stays Skatteverket's on 1513.
    expect(event('payment: a RUT invoice')).toMatchObject({ amount: 3500, amount_sek: 3500, tax_amounts: [] })
    // Without a context from the door: no link basis and no debt, never a guess.
    expect(event('payment: a card payment')).toMatchObject({ amount: null, amount_sek: 1500, evidence: {} })
    expect(event('payment: the invoice dimensions')).toMatchObject({ amount: null, amount_sek: 1500 })

    // Kontantmetoden books the sale at payment: its moms rides along.
    expect(event('cash: kontantmetoden books the sale')).toMatchObject({
      kind: 'sale.payment_received',
      amount: 1500,
      amount_sek: 1500,
      tax_amounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 300 }],
      evidence: { link_basis: 'user_created' },
    })
    expect(event('cash: kontantmetoden books the sale').mapping_version).toMatch(/^se\.customer-payment-lines@/)
    expect(event('cash: mixed rates')).toMatchObject({ amount: null, tax_amounts: [{ tax: 'vat', amount_sek: 192 }] })
    // The 1513 debit is not money that arrived: only the bank leg counts.
    expect(event('cash: a RUT invoice')).toMatchObject({ amount: 3500, amount_sek: 3500, tax_amounts: [{ amount_sek: 1200 }] })
    expect(event('cash: from a bank row 40 öre short')).toMatchObject({ amount: 1500.4, amount_sek: 1500, evidence: { direction: 'in' } })
    expect(event('cash: from a bank row paying too much')).toMatchObject({ amount: 1500, amount_sek: 1700, pending_operation_id: OPERATION })
    // Reverse charge: the invoice states no moms.
    expect(event('cash: an EUR invoice')).toMatchObject({ currency: 'EUR', amount: 200, amount_sek: 2300, tax_amounts: [] })
    for (const run of runs) {
      for (const e of run.events) expect(e.id, run.name).toMatch(UUID)
    }
  })
})
