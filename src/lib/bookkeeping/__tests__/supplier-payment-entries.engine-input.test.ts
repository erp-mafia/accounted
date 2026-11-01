/**
 * Posting port, step 2e: what the supplier payment generators hand the
 * engine, recorded call by call and compared with a committed fixture
 * (supplier-payment-entries.engine-input.json) that was taken before the
 * producers went through the port. createSupplierInvoicePaymentEntry (the
 * 2440 clearing under faktureringsmetoden) and createSupplierInvoiceCashEntry
 * (the kontantmetoden verifikat) are the generators behind every supplier
 * payment door: both mark-paid routes and, through createSupplierBankMatchEntry,
 * the dashboard and v1 bank matches and the debit of a signed payment order.
 * Every argument of every createJournalEntry call is recorded, an absent one
 * as '<undefined>', so an extra argument or a changed input fails here;
 * trailing undefined arguments are dropped before the comparison (the ledger
 * adapter fills createJournalEntry's commitMethod and rubricVersion
 * positions, which a four-argument call receives as undefined, the value its
 * omitted optional parameters had).
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/bookkeeping/__tests__/supplier-payment-entries.engine-input.test.ts
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
import type { CreateJournalEntryInput, SupplierInvoice, SupplierInvoiceItem, Transaction } from '@/types'
import type { SupplierBankMatchBooking } from '@/lib/invoices/apply-supplier-payment'
import type { SupplierPaymentPostingContext } from '../supplier-invoice-business-events'

// The engine calls the generators make are recorded; everything else in the
// engine stays real.
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  findFiscalPeriod: vi.fn(),
  createJournalEntry: vi.fn(),
}))

const { createJournalEntry, findFiscalPeriod } = await import('@/lib/bookkeeping/engine')
const { BookkeepingDatabaseError } = await import('@/lib/bookkeeping/errors')
const { createSupplierInvoicePaymentEntry, createSupplierInvoiceCashEntry } = await import('../supplier-invoice-entries')
const { createSupplierBankMatchEntry } = await import('../supplier-bank-match-entry')

const mockedCreate = vi.mocked(createJournalEntry)
const mockedFindPeriod = vi.mocked(findFiscalPeriod)

const FIXTURE = path.join(__dirname, 'supplier-payment-entries.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const SUPPLIER = '00000000-0000-4000-8000-00000000b001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'
const CASH_ACCOUNT = '00000000-0000-4000-8000-00000000ca01'
const OPERATION = '00000000-0000-4000-8000-00000000e002'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A stable UUID per scenario: the supplier invoice row's id. */
function invoiceId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

function transactionId(index: number): string {
  return `00000000-0000-4000-8000-0000000a${String(index + 1).padStart(4, '0')}`
}

function invoice(index: number, overrides: Partial<SupplierInvoice> = {}): SupplierInvoice {
  return {
    id: invoiceId(index),
    user_id: USER,
    company_id: COMPANY,
    supplier_id: SUPPLIER,
    arrival_number: 60 + index,
    supplier_invoice_number: `F-${3000 + index}`,
    invoice_date: '2026-09-01',
    due_date: '2026-09-30',
    received_date: '2026-09-02',
    delivery_date: null,
    status: 'registered',
    approved_at: null,
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
    reverse_charge: false,
    payment_reference: null,
    paid_at: null,
    paid_amount: 0,
    remaining_amount: 1500,
    is_credit_note: false,
    credited_invoice_id: null,
    registration_journal_entry_id: null,
    payment_journal_entry_id: null,
    transaction_id: null,
    document_id: null,
    paid_with_private_funds: false,
    bank_entered_at: null,
    notes: null,
    created_at: '2026-09-02T00:00:00Z',
    updated_at: '2026-09-02T00:00:00Z',
    ...overrides,
  } as SupplierInvoice
}

function item(sortOrder: number, overrides: Partial<SupplierInvoiceItem>): SupplierInvoiceItem {
  return {
    id: `item-${sortOrder}`,
    supplier_invoice_id: 'unused',
    sort_order: sortOrder,
    description: `Rad ${sortOrder + 1}`,
    quantity: 1,
    unit: 'st',
    unit_price: 0,
    line_total: 0,
    account_number: '6110',
    vat_code: null,
    vat_rate: 0.25,
    vat_amount: 0,
    reverse_charge_rate: null,
    accrual_period_start: null,
    accrual_period_end: null,
    accrual_balance_account: null,
    dimensions: {},
    apply_slp: false,
    created_at: '2026-09-02T00:00:00Z',
    ...overrides,
  } as SupplierInvoiceItem
}

const DOMESTIC_ITEMS = [
  item(0, { description: 'Skärmar', unit_price: 1000, line_total: 1000, account_number: '5410', vat_amount: 250 }),
  item(1, { description: 'Pärmar', unit_price: 200, line_total: 200, account_number: '6110', vat_amount: 50 }),
]

const REVERSE_CHARGE_ITEMS = [
  item(0, { description: 'Hosting', unit_price: 150, line_total: 150, account_number: '6540', vat_rate: 0, reverse_charge_rate: 0.25 }),
  item(1, { description: 'Support', unit_price: 50, line_total: 50, account_number: '6550', vat_rate: 0 }),
]

const EUR_INVOICE = {
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
  reverse_charge: true,
} as Partial<SupplierInvoice>

type BankLine = Pick<Transaction, 'id' | 'cash_account_id' | 'date' | 'amount' | 'currency'>

function bankLine(index: number, date: string, amount: number, currency: Transaction['currency'] = 'SEK'): BankLine {
  return { id: transactionId(index), cash_account_id: CASH_ACCOUNT, date, amount, currency }
}

/** One generator call, as a door makes it. */
type Scenario =
  | {
      name: string
      kind: 'payment'
      invoice: SupplierInvoice
      paymentAmount: number
      paymentDate: string
      exchangeRateDifference?: number
      supplierName?: string
      paymentAccount: string
      bankTransaction?: BankLine
      bankFeeSek?: number
      sekClearingDebt?: number
      noPeriod?: boolean
      /** What the door hands down for the event (read only while the port is on). */
      posting?: SupplierPaymentPostingContext
    }
  | {
      name: string
      kind: 'cash'
      invoice: SupplierInvoice
      items: SupplierInvoiceItem[]
      paymentDate: string
      supplierType: string
      supplierName?: string
      paymentAccount: string
      settledBankSek?: number
      bankTransaction?: BankLine
      bankFeeSek?: number
      noPeriod?: boolean
      posting?: SupplierPaymentPostingContext
    }
  | {
      name: string
      kind: 'bank_match'
      invoice: SupplierInvoice
      booking: SupplierBankMatchBooking
      paymentAccount: string
      transaction: BankLine
      posting?: SupplierPaymentPostingContext
    }

const SCENARIOS: Scenario[] = [
  {
    name: 'payment: a SEK invoice paid in full from the default account',
    kind: 'payment',
    invoice: invoice(0),
    paymentAmount: 1500,
    paymentDate: '2026-09-28',
    supplierName: 'Kontorsbolaget AB',
    paymentAccount: '1930',
    posting: { linkBasis: { link_basis: 'user_created', link_evidence: null }, settledAmount: 1500 },
  },
  {
    name: 'payment: a partial payment out of private funds (2893) with invoice dimensions',
    kind: 'payment',
    invoice: invoice(1, { default_dimensions: { '6': 'P100' } } as Partial<SupplierInvoice>),
    paymentAmount: 600,
    paymentDate: '2026-09-29',
    supplierName: 'Kontorsbolaget AB',
    paymentAccount: '2893',
  },
  {
    name: 'payment: an EUR invoice cleared at the booked rate with a kursförlust',
    kind: 'payment',
    invoice: invoice(2, EUR_INVOICE),
    paymentAmount: 2300,
    paymentDate: '2026-10-02',
    paymentAccount: '1930',
    exchangeRateDifference: -23.5,
    supplierName: 'Hosting GmbH',
    posting: {
      linkBasis: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OPERATION } },
      settledAmount: 200,
    },
  },
  {
    name: 'payment: an EUR invoice cleared at the booked rate with a kursvinst',
    kind: 'payment',
    invoice: invoice(3, EUR_INVOICE),
    paymentAmount: 2300,
    paymentDate: '2026-10-03',
    paymentAccount: '1930',
    exchangeRateDifference: 12.25,
  },
  {
    name: 'payment: a matched SEK bank row with öresavrundning and a bank fee',
    kind: 'payment',
    invoice: invoice(4, { total: 1499.6, total_sek: 1499.6, remaining_amount: 1499.6 }),
    paymentAmount: 1525,
    paymentDate: '2026-10-05',
    paymentAccount: '1930',
    bankTransaction: bankLine(4, '2026-10-05', -1525),
    bankFeeSek: 25,
    sekClearingDebt: 1499.6,
    posting: { linkBasis: { link_basis: 'user_confirmed', link_evidence: null }, settledAmount: 1499.6 },
  },
  {
    name: 'payment: no open fiscal period, nothing posted',
    kind: 'payment',
    invoice: invoice(5),
    paymentAmount: 1500,
    paymentDate: '2027-02-01',
    paymentAccount: '1930',
    noPeriod: true,
  },
  {
    name: 'cash: a domestic invoice at 25 % paid from the default account',
    kind: 'cash',
    invoice: invoice(6, { default_dimensions: { '6': 'P200' } } as Partial<SupplierInvoice>),
    items: DOMESTIC_ITEMS,
    paymentDate: '2026-09-30',
    paymentAccount: '1930',
    supplierType: 'swedish_business',
    supplierName: 'Kontorsbolaget AB',
    posting: { linkBasis: { link_basis: 'user_created', link_evidence: null }, settledAmount: 1500 },
  },
  {
    name: 'cash: an EU supplier in EUR under reverse charge, settled from a bank row',
    kind: 'cash',
    invoice: invoice(7, EUR_INVOICE),
    items: REVERSE_CHARGE_ITEMS,
    paymentDate: '2026-10-06',
    supplierType: 'eu_business',
    paymentAccount: '1930',
    settledBankSek: 2311.4,
    bankTransaction: bankLine(7, '2026-10-06', -200, 'EUR'),
    posting: { linkBasis: { link_basis: 'user_confirmed', link_evidence: null }, settledAmount: 200 },
  },
  {
    name: 'cash: a SEK invoice settled with a whole-krona bank row and a bank fee',
    kind: 'cash',
    invoice: invoice(8, { total: 1499.6, total_sek: 1499.6, remaining_amount: 1499.6, vat_amount: 299.92, vat_amount_sek: 299.92 }),
    items: [
      item(0, { description: 'Skärmar', unit_price: 1199.68, line_total: 1199.68, account_number: '5410', vat_amount: 299.92 }),
    ],
    paymentDate: '2026-10-07',
    supplierType: 'swedish_business',
    paymentAccount: '1930',
    settledBankSek: 1500,
    bankTransaction: bankLine(8, '2026-10-07', -1520),
    bankFeeSek: 20,
  },
  {
    name: 'cash: no open fiscal period, nothing posted',
    kind: 'cash',
    invoice: invoice(9),
    items: DOMESTIC_ITEMS,
    paymentDate: '2027-02-02',
    paymentAccount: '1930',
    supplierType: 'swedish_business',
    noPeriod: true,
  },
  {
    name: 'bank match: a kontantmetoden booking of a matched row',
    kind: 'bank_match',
    invoice: invoice(10, {
      supplier: { id: SUPPLIER, name: 'Kontorsbolaget AB', supplier_type: 'swedish_business' },
      items: DOMESTIC_ITEMS,
    } as Partial<SupplierInvoice>),
    booking: { kind: 'cash', settledBankSek: 1500, bankFeeSek: 0 } as SupplierBankMatchBooking,
    paymentAccount: '1930',
    transaction: bankLine(10, '2026-10-08', -1500),
    posting: { linkBasis: { link_basis: 'user_confirmed', link_evidence: null }, settledAmount: 1500 },
  },
  {
    name: 'bank match: a SEK clearing of a matched row names the supplier',
    kind: 'bank_match',
    invoice: invoice(11, {
      supplier: { id: SUPPLIER, name: 'Kontorsbolaget AB', supplier_type: 'swedish_business' },
    } as Partial<SupplierInvoice>),
    booking: { kind: 'clearing', paymentAmount: 1500, sekClearingDebt: 1500, bankFeeSek: 0 } as SupplierBankMatchBooking,
    paymentAccount: '1931',
    transaction: bankLine(11, '2026-10-09', -1500),
    posting: {
      linkBasis: { link_basis: 'rule_ocr_reference', link_evidence: { rule_id: 'payment_order:end_to_end_id', score: 1 } },
      settledAmount: 1500,
    },
  },
  {
    name: 'bank match: an EUR clearing with a kursdifferens',
    kind: 'bank_match',
    invoice: invoice(12, {
      ...EUR_INVOICE,
      supplier: { id: SUPPLIER, name: 'Hosting GmbH', supplier_type: 'eu_business' },
    } as Partial<SupplierInvoice>),
    booking: { kind: 'clearing', paymentAmount: 2300, exchangeRateDifference: -11.4, bankFeeSek: 0 } as SupplierBankMatchBooking,
    paymentAccount: '1930',
    transaction: bankLine(12, '2026-10-10', -200, 'EUR'),
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

function supabaseFor(opts: RunOptions) {
  return createTableMockSupabase({
    business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    chart_of_accounts: { data: [] },
  })
}

async function runScenarios(opts: RunOptions = {}): Promise<Run[]> {
  const out: Run[] = []
  for (const [index, s] of SCENARIOS.entries()) {
    mockedCreate.mockReset()
    mockedFindPeriod.mockReset()
    mockedFindPeriod.mockResolvedValue('noPeriod' in s && s.noPeriod ? null : PERIOD)
    mockedCreate.mockImplementation(async (_sb, _c, _u, input: CreateJournalEntryInput) => ({ id: `je-${index}`, ...input }) as never)
    const { supabase, findCalls } = supabaseFor(opts)
    let postingReads = 0
    const posting = s.posting
      ? () => {
          postingReads++
          return s.posting!
        }
      : undefined
    let outcome: unknown
    try {
      let entry: { id: string } | null
      if (s.kind === 'payment') {
        entry = await createSupplierInvoicePaymentEntry(
          supabase as never, COMPANY, USER, s.invoice, s.paymentAmount, s.paymentDate, s.exchangeRateDifference,
          s.supplierName, s.paymentAccount, s.bankTransaction, s.bankFeeSek, s.sekClearingDebt, posting,
        )
      } else if (s.kind === 'cash') {
        entry = await createSupplierInvoiceCashEntry(
          supabase as never, COMPANY, USER, s.invoice, s.items, s.paymentDate, s.supplierType, s.supplierName,
          s.paymentAccount, s.settledBankSek, s.bankTransaction, s.bankFeeSek, posting,
        )
      } else {
        entry = await createSupplierBankMatchEntry(supabase as never, COMPANY, USER, {
          invoice: s.invoice,
          booking: s.booking,
          paymentAccount: s.paymentAccount,
          transaction: s.transaction,
          posting,
        })
      }
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

describe('supplier payment generators engine input (posting port parity)', () => {
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

    expect(event('payment: a SEK invoice paid in full')).toMatchObject({
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
      idempotency_key: null,
    })
    expect(event('payment: a SEK invoice paid in full').mapping_version).toMatch(/^se\.supplier-payment-lines@/)
    // Out of private funds: what left 2893; no door context, so no settled amount.
    expect(event('payment: a partial payment out of private funds')).toMatchObject({ amount: null, amount_sek: 600, evidence: {} })
    // Kursförlust: 2440 cleared at the booked 2 300, the bank paid 2 323,50.
    expect(event('payment: an EUR invoice cleared at the booked rate with a kursförlust')).toMatchObject({
      currency: 'EUR',
      amount: 200,
      amount_sek: 2323.5,
      evidence: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OPERATION } },
      pending_operation_id: OPERATION,
    })
    expect(event('payment: an EUR invoice cleared at the booked rate with a kursvinst')).toMatchObject({ amount_sek: 2287.75 })
    // A matched bank row: the kronor that left the bank, the 6570 fee included.
    expect(event('payment: a matched SEK bank row')).toMatchObject({
      amount: 1499.6,
      amount_sek: 1524.6,
      evidence: { direction: 'out', link_basis: 'user_confirmed' },
    })
    // Kontantmetoden books the moms the invoice states at payment.
    expect(event('cash: a domestic invoice at 25 %')).toMatchObject({
      kind: 'purchase.paid',
      occurred_on: '2026-09-30',
      amount_sek: 1500,
      tax_amounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 300 }],
    })
    // Omvänd skattskyldighet: the invoice states no moms; the self-assessed pair stays in the lines.
    expect(event('cash: an EU supplier in EUR')).toMatchObject({ currency: 'EUR', amount: 200, amount_sek: 2311.4, tax_amounts: [] })
    expect(event('cash: a SEK invoice settled with a whole-krona bank row')).toMatchObject({ amount_sek: 1520 })
    expect(event('bank match: a kontantmetoden booking')).toMatchObject({ amount_sek: 1500, evidence: { direction: 'out', link_basis: 'user_confirmed' } })
    expect(event('bank match: a SEK clearing')).toMatchObject({
      amount_sek: 1500,
      evidence: { direction: 'out', link_basis: 'rule_ocr_reference', link_evidence: { rule_id: 'payment_order:end_to_end_id', score: 1 } },
    })
    for (const run of runs) {
      for (const e of run.events) {
        expect(e.id, run.name).toMatch(UUID)
        expect(e.mapping_version, run.name).toMatch(/^se\.supplier-payment-lines@/)
      }
    }
  })
})
