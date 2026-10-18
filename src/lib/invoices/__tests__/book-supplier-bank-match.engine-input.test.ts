/**
 * Posting port, step 2e: what bookSupplierBankMatch (the dashboard match
 * door and the debit of a signed bank payment order) hands the engine,
 * recorded call by call and compared with a committed fixture
 * (book-supplier-bank-match.engine-input.json) that was taken before the
 * producer went through the port. The payment verifikat comes either from the
 * generator the plan names (createSupplierBankMatchEntry) or from the
 * person's own rows; a payment that loses the settlement race is cancelled
 * through the engine's cleanup door. Every argument is recorded, an absent
 * one as '<undefined>'; trailing undefined arguments are dropped before the
 * comparison (see supplier-payment-entries.engine-input.test.ts).
 *
 * Regenerate only on purpose, from the code before the move:
 *   UPDATE_ENGINE_INPUT_FIXTURE=1 npx vitest run src/lib/invoices/__tests__/book-supplier-bank-match.engine-input.test.ts
 *
 * Since the payment verifikat posts through the posting port, the scenarios
 * also run with POSTING_EVENTS=shadow and strict: the engine must get the
 * same arguments plus only the event link, a refused event write must still
 * book under shadow, and under strict the match stops before the engine is
 * called, with nothing to cancel.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput, SupplierInvoice, SupplierInvoiceItem, Transaction } from '@/types'
import type { LinkBasisInput } from '@/lib/links/stamp'

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  findFiscalPeriod: vi.fn(),
  createJournalEntry: vi.fn(),
  cancelOrphanedEntry: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/settlement-account', () => ({
  resolveSettlementAccount: vi.fn(async () => '1930'),
}))
vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({
  anchorSupplierInvoiceDocument: vi.fn(async () => null),
}))
vi.mock('@/lib/invoices/match-log', () => ({
  logMatchEvent: vi.fn(async () => undefined),
}))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn(async () => undefined),
}))
vi.mock('@/lib/invoices/paid-events', () => ({
  emitSupplierInvoicePaidIfSettled: vi.fn(async () => undefined),
}))

const { createJournalEntry, findFiscalPeriod, cancelOrphanedEntry } = await import('@/lib/bookkeeping/engine')
const { bookSupplierBankMatch } = await import('../book-supplier-bank-match')

const mockedCreate = vi.mocked(createJournalEntry)
const mockedFindPeriod = vi.mocked(findFiscalPeriod)
const mockedCancel = vi.mocked(cancelOrphanedEntry)

const FIXTURE = path.join(__dirname, 'book-supplier-bank-match.engine-input.json')
const SUPABASE = '<supabase>'
const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const SUPPLIER = '00000000-0000-4000-8000-00000000b001'
const PERIOD = '00000000-0000-4000-8000-00000000f001'
const CASH_ACCOUNT = '00000000-0000-4000-8000-00000000ca01'
const REGISTRATION = '00000000-0000-4000-8000-00000000e001'
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

function invoiceId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

function transactionId(index: number): string {
  return `00000000-0000-4000-8000-0000000a${String(index + 1).padStart(4, '0')}`
}

const DOMESTIC_ITEMS = [
  { id: 'item-0', sort_order: 0, description: 'Skärmar', quantity: 1, unit_price: 1000, line_total: 1000, account_number: '5410', vat_rate: 0.25, vat_amount: 250, dimensions: {} },
  { id: 'item-1', sort_order: 1, description: 'Pärmar', quantity: 1, unit_price: 200, line_total: 200, account_number: '6110', vat_rate: 0.25, vat_amount: 50, dimensions: {} },
] as unknown as SupplierInvoiceItem[]

function invoice(index: number, overrides: Partial<SupplierInvoice> = {}): SupplierInvoice {
  return {
    id: invoiceId(index),
    company_id: COMPANY,
    supplier_id: SUPPLIER,
    arrival_number: 80 + index,
    supplier_invoice_number: `F-${4000 + index}`,
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
    remaining_amount: 1500,
    registration_journal_entry_id: REGISTRATION,
    document_id: null,
    supplier: { id: SUPPLIER, name: 'Kontorsbolaget AB', supplier_type: 'swedish_business' },
    items: DOMESTIC_ITEMS,
    ...overrides,
  } as unknown as SupplierInvoice
}

interface Row {
  date: string
  amount: number
  currency?: Transaction['currency']
  amount_sek?: number | null
  document_id?: string | null
}

interface Scenario {
  name: string
  invoice: SupplierInvoice
  row: Row
  accountingMethod: 'accrual' | 'cash'
  customLines?: CreateJournalEntryLineInput[]
  /** A concurrent settlement wins the invoice's status compare-and-set. */
  loseRace?: boolean
  match?: 'matched' | 'auto_matched'
  linkBasis?: LinkBasisInput
}

const SCENARIOS: Scenario[] = [
  {
    name: 'accrual: a SEK row pays a registered invoice in full',
    invoice: invoice(0),
    row: { date: '2026-09-28', amount: -1500 },
    accountingMethod: 'accrual',
  },
  {
    name: 'accrual: a whole-krona SEK row settles an öre invoice (3740)',
    invoice: invoice(1, { total: 1499.6, total_sek: 1499.6, remaining_amount: 1499.6 }),
    row: { date: '2026-09-29', amount: -1500 },
    accountingMethod: 'accrual',
  },
  {
    name: 'accrual: a SEK row paying more than owed books the excess on 6570',
    invoice: invoice(2),
    row: { date: '2026-09-30', amount: -1525 },
    accountingMethod: 'accrual',
  },
  {
    name: 'accrual: an EUR row clears at the booked rate with a kursdifferens',
    invoice: invoice(3, {
      currency: 'EUR',
      exchange_rate: 11.5,
      subtotal: 200,
      vat_amount: 0,
      vat_amount_sek: 0,
      total: 200,
      total_sek: 2300,
      remaining_amount: 200,
      vat_treatment: 'reverse_charge',
      reverse_charge: true,
      supplier: { id: SUPPLIER, name: 'Hosting GmbH', supplier_type: 'eu_business' },
    } as Partial<SupplierInvoice>),
    row: { date: '2026-10-01', amount: -200, currency: 'EUR', amount_sek: -2311.4 },
    accountingMethod: 'accrual',
  },
  {
    name: 'accrual: a partial SEK payment',
    invoice: invoice(4),
    row: { date: '2026-10-02', amount: -500, document_id: '00000000-0000-4000-8000-00000000d004' },
    accountingMethod: 'accrual',
  },
  {
    name: 'cash: a never-booked domestic invoice settled from the row',
    invoice: invoice(5, { registration_journal_entry_id: null }),
    row: { date: '2026-10-03', amount: -1500 },
    accountingMethod: 'cash',
  },
  {
    name: "custom lines: the person's own rows on a registered invoice",
    invoice: invoice(6),
    row: { date: '2026-10-04', amount: -1500 },
    accountingMethod: 'accrual',
    customLines: [
      { account_number: '2440', debit_amount: 1500, credit_amount: 0, line_description: 'Egen rad' },
      { account_number: '1930', debit_amount: 0, credit_amount: 1500 },
    ],
  },
  {
    name: "custom lines: the person's own kontantmetoden rows",
    invoice: invoice(7, { registration_journal_entry_id: null }),
    row: { date: '2026-10-05', amount: -1500 },
    accountingMethod: 'cash',
    customLines: [
      { account_number: '5410', debit_amount: 1200, credit_amount: 0 },
      { account_number: '2641', debit_amount: 300, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1500 },
    ],
  },
  {
    name: 'custom lines that do not balance are refused before the engine',
    invoice: invoice(8),
    row: { date: '2026-10-06', amount: -1500 },
    accountingMethod: 'accrual',
    customLines: [
      { account_number: '2440', debit_amount: 1500, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1400 },
    ],
  },
  {
    name: 'a concurrent settlement wins: the payment verifikat is cancelled',
    invoice: invoice(9),
    row: { date: '2026-10-07', amount: -1500 },
    accountingMethod: 'accrual',
    loseRace: true,
  },
  {
    name: 'the debit of a signed bank payment order (auto_matched, rule basis)',
    invoice: invoice(10),
    row: { date: '2026-10-08', amount: -1500 },
    accountingMethod: 'accrual',
    match: 'auto_matched',
    linkBasis: { basis: 'rule_ocr_reference', evidence: { rule_id: 'payment_order_debit', reference: 'PO-1' } },
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
  return createTableMockSupabase({
    business_events: opts.refuseEvent ? { error: { message: 'business_events refused', code: '42501' } } : { data: null },
    company_settings: { data: { accounting_method: s.accountingMethod } },
    supplier_invoices: { data: s.loseRace ? [] : [{ id: s.invoice.id }] },
    supplier_invoice_payments: { data: null },
    transactions: { data: null },
    document_attachments: { data: null },
    chart_of_accounts: { data: [] },
  })
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
    const { supabase, findCalls } = supabaseFor(s, opts)
    const result = await bookSupplierBankMatch(supabase as never, {
      transaction: {
        id: transactionId(index),
        date: s.row.date,
        amount: s.row.amount,
        currency: s.row.currency ?? 'SEK',
        amount_sek: s.row.amount_sek ?? null,
        cash_account_id: CASH_ACCOUNT,
        document_id: s.row.document_id ?? null,
      },
      invoice: s.invoice,
      userId: USER,
      companyId: COMPANY,
      log,
      customLines: s.customLines ?? null,
      match: { action: s.match ?? 'matched', method: 'manual_confirm', confidence: 1 },
      linkBasis: s.linkBasis ?? { basis: 'user_confirmed' },
    })
    out.push({
      name: s.name,
      calls: mockedCreate.mock.calls.map((c) => record(c as unknown[])),
      cancels: mockedCancel.mock.calls.map((c) => record(c as unknown[])),
      outcome: result.ok
        ? { ok: true, journalEntryId: result.journalEntryId, settledAmount: result.plan.settledAmount }
        : { ok: false, code: result.code },
      events: findCalls('business_events', 'insert').map((args) => args[0] as Record<string, unknown>),
    })
  }
  return out
}

describe('supplier bank match engine input (posting port parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    eventBus.clear()
  })

  it('hands the engine exactly what it handed it before the port', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', '')
    const runs = await runScenarios()
    const recorded = runs.map(({ name, calls, cancels, outcome }) => ({
      name,
      calls: calls.map(trimTrailingUndefined),
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

  it('with POSTING_EVENTS=strict a refused event write stops the match before the engine is called', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'strict')
    const refused = await runScenarios({ refuseEvent: true })
    for (const run of refused) {
      expect(run.calls, run.name).toEqual([])
      expect(run.cancels, run.name).toEqual([])
      expect(run.outcome, run.name).toMatchObject({ ok: false })
    }
  })

  it('records what happened in business terms', { timeout: 60_000 }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'shadow')
    const runs = await runScenarios()
    const event = (name: string) => runs.find((r) => r.name.startsWith(name))!.events[0]!
    expect(event('accrual: a SEK row pays a registered invoice in full')).toMatchObject({
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
      evidence: { direction: 'out', link_basis: 'user_confirmed' },
      pending_operation_id: null,
      jurisdiction: 'SE',
    })
    expect(event('accrual: a SEK row pays a registered invoice in full').mapping_version).toMatch(/^se\.supplier-payment-lines@/)
    // The debt settled is the invoice's öre total; the bank paid whole kronor.
    expect(event('accrual: a whole-krona SEK row')).toMatchObject({ amount: 1499.6, amount_sek: 1500 })
    expect(event('accrual: a SEK row paying more than owed')).toMatchObject({ amount: 1500, amount_sek: 1525 })
    expect(event('accrual: an EUR row')).toMatchObject({ currency: 'EUR', amount: 200, amount_sek: 2311.4 })
    expect(event('accrual: a partial SEK payment')).toMatchObject({ amount: 500, amount_sek: 500 })
    expect(event('cash: a never-booked domestic invoice')).toMatchObject({
      tax_amounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 300 }],
    })
    // The person's own rows: no rule source; the payment leg on the row's own account.
    expect(event("custom lines: the person's own rows on a registered invoice")).toMatchObject({ amount_sek: 1500, mapping_version: null })
    expect(event("custom lines: the person's own kontantmetoden rows")).toMatchObject({
      mapping_version: null,
      tax_amounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 300 }],
    })
    // The lost race's verifikat had its event before the cancel.
    expect(runs.find((r) => r.name.startsWith('a concurrent settlement wins'))!.events).toHaveLength(1)
    expect(event('the debit of a signed bank payment order')).toMatchObject({
      evidence: { direction: 'out', link_basis: 'rule_ocr_reference', link_evidence: { rule_id: 'payment_order_debit', reference: 'PO-1' } },
    })
    expect(runs.find((r) => r.name.startsWith('custom lines that do not balance'))!.events).toEqual([])
  })
})
