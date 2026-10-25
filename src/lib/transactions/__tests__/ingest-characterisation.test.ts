/**
 * Characterisation of ingestTransactions' suggestion passes, written against
 * the hard-wired sequence before the passes became a registry of matchers and
 * kept identical through that change: the snapshot beside this file is the
 * parity proof.
 *
 * Each batch runs through a recording database (fakeDb below) that serves
 * fixture rows by table and filter and records, in order, every write and
 * RPC, plus the collaborators ingest hands a row to (the split, the order
 * settle, the mapping engine, the voucher, the counterparty template, the
 * collections sweep). The decision functions run for real where they are
 * pure (the payment order match, the supplier heuristics, the ROT/RUT
 * matchers); the customer invoice scorer is a small stand-in so a fixture can
 * name its confidence. Recorded per batch: the IngestResult, the ordered
 * trace, the reads, how often each batch-level loader ran, and the ingest
 * log records.
 *
 * Branches the fixture reaches (see 'reaches every branch' below): an OCR hit,
 * an end-to-end debit, a Swedbank amount debit, a refused settle that leaves a
 * hint, a refused settle whose hint is refused (the heuristics run), strong,
 * weak and ambiguous supplier matches, a strong match the pool no longer
 * holds, ROT/RUT 1:1 and set, a ROT/RUT hint that fails, claims between rows
 * and between the split and the passes, a mapping rule that books and one
 * that wants review, a complete and an incomplete split and one that throws,
 * re-reads (a stronger hint, a hint that stands, an order debit, a weak hint
 * that stands, a booked row, a split, nothing new), a raw insert, an invoice
 * pool that fails, a scorer that throws and a settle that throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BankTransactionPartInput, RawTransaction, SupplierInvoice, Transaction } from '@/types'
import type { PaymentOrderRow } from '@/lib/payments/orders/types'
import type { RotRutPayoutRequestCandidate } from '@/lib/invoices/rot-rut-payout-matching'
import { makeSupplier, makeSupplierInvoice, makeTransaction } from '@/tests/helpers'
import { ARCIM, arcimOrder, order as paymentOrder } from '@/lib/payments/orders/__tests__/fixtures'

type Row = Record<string, unknown>
type Filter = [op: string, column: string, value: unknown]

/** A customer invoice as the stand-in scorer reads it. */
interface FixtureInvoice {
  id: string
  total: number
  /** The bank reference that names it (an OCR hit). */
  ocr: string | null
}

interface SplitAnswer {
  complete: boolean
  suggestions: Array<{ suggested_invoice_id: string | null; suggested_supplier_invoice_id: string | null }> | null
}

interface Scenario {
  invoices: FixtureInvoice[]
  invoicePoolFails: boolean
  paymentOrders: PaymentOrderRow[]
  settle: Record<string, { ok: true } | { ok: false; reason: string; code?: string } | 'throw'>
  rotRut: RotRutPayoutRequestCandidate[]
  split: Record<string, SplitAnswer | 'throw'>
  mapping: Record<string, { confidence: number; requires_review?: boolean }>
}

const h = vi.hoisted(() => {
  const trace: unknown[] = []
  const logs: Array<Record<string, unknown>> = []
  const loads: Record<string, number> = {}
  const scenario = {} as Scenario
  const count = (loader: string) => {
    loads[loader] = (loads[loader] ?? 0) + 1
  }
  return { trace, logs, loads, scenario, count }
})

vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  return {
    ...actual,
    createLogger: (module: string, base = {}) => actual.createTestLogger(module, h.logs as never, base),
  }
})

vi.mock('@/lib/invoices/invoice-matching', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/invoices/invoice-matching')>()
  return {
    ...actual,
    loadInvoiceMatchPool: async () => {
      h.trace.push({ call: 'loadInvoiceMatchPool' })
      if (h.scenario.invoicePoolFails) throw new Error('invoice pool read failed')
      return { invoices: h.scenario.invoices }
    },
    bestInvoiceMatch: (tx: Transaction, pool: { invoices: FixtureInvoice[] }, minConfidence: number) => {
      h.trace.push({ call: 'bestInvoiceMatch', tx: tx.id, minConfidence })
      if (tx.description === 'KASTA') throw new Error('scorer failed')
      const byRef = tx.reference ? pool.invoices.find((inv) => inv.ocr === tx.reference) : undefined
      const byAmount = pool.invoices.find((inv) => inv.total === tx.amount)
      const match = byRef
        ? { invoice: byRef, confidence: 0.99, matchReason: 'OCR' }
        : byAmount
          ? { invoice: byAmount, confidence: 0.8, matchReason: 'amount' }
          : null
      return match && match.confidence >= minConfidence ? match : null
    },
  }
})

vi.mock('@/lib/invoices/rot-rut-payout-candidates', () => ({
  loadOpenRotRutPayoutRequests: async () => {
    h.count('loadOpenRotRutPayoutRequests')
    return h.scenario.rotRut
  },
}))

vi.mock('@/lib/payments/orders/auto-settle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/payments/orders/auto-settle')>()
  return {
    ...actual,
    loadOpenPaymentOrders: async () => {
      h.count('loadOpenPaymentOrders')
      return h.scenario.paymentOrders
    },
    settleOrderWithDebit: async (
      _supabase: unknown,
      args: { order: { id: string }; transaction: { id: string }; confidence: number; basis: string },
    ) => {
      h.trace.push({
        call: 'settleOrderWithDebit',
        order: args.order.id,
        tx: args.transaction.id,
        confidence: args.confidence,
        basis: args.basis,
      })
      const answer = h.scenario.settle[args.order.id]
      if (answer === 'throw') throw new Error('settle threw')
      return answer && answer.ok ? { ok: true, journalEntryId: `je:${args.transaction.id}`, orderLinked: true, linkedBy: 'trigger' } : answer
    },
  }
})

vi.mock('@/lib/transactions/parts-apply', () => ({
  applyTransactionSplit: async (
    _supabase: unknown,
    input: {
      tx: { id: string; external_id?: string | null }
      parts: unknown[]
      pools: { customerInvoices: Array<{ id: string }>; supplierInvoices: Array<{ id: string }>; excludeInvoiceIds?: ReadonlySet<string> } | null
    },
  ) => {
    h.trace.push({
      call: 'applyTransactionSplit',
      tx: input.tx.id,
      parts: input.parts.length,
      pools: input.pools
        ? {
            customerInvoices: input.pools.customerInvoices.map((inv) => inv.id),
            supplierInvoices: input.pools.supplierInvoices.map((inv) => inv.id),
            excludeInvoiceIds: [...(input.pools.excludeInvoiceIds ?? [])].sort(),
          }
        : null,
    })
    const answer = h.scenario.split[input.tx.external_id ?? '']
    if (answer === 'throw') throw new Error('parts write refused')
    return answer ?? { complete: false, suggestions: null }
  },
}))

vi.mock('@/lib/bookkeeping/mapping-engine', () => ({
  evaluateMappingRules: async (_supabase: unknown, _companyId: string, tx: Transaction, entityType: string, settlementAccount?: string) => {
    h.trace.push({ call: 'evaluateMappingRules', tx: tx.id, entityType, settlementAccount: settlementAccount ?? null })
    const rule = h.scenario.mapping[tx.description] ?? { confidence: 0.5 }
    return {
      rule: null,
      debit_account: '6990',
      credit_account: '1930',
      risk_level: 'low',
      confidence: rule.confidence,
      requires_review: rule.requires_review ?? false,
      default_private: false,
      vat_lines: [],
      description: tx.description,
    }
  },
}))

vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: async (_supabase: unknown, _companyId: string, _userId: string, tx: Transaction) => {
    h.trace.push({ call: 'createTransactionJournalEntry', tx: tx.id })
    return { id: `je:${tx.id}` }
  },
}))

vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  upsertCounterpartyTemplate: async (_supabase: unknown, _companyId: string, tx: Transaction, _mapping: unknown, source: string) => {
    h.trace.push({ call: 'upsertCounterpartyTemplate', tx: tx.id, source })
  },
}))

vi.mock('@/lib/collections/sweep-hook', () => ({
  scheduleCollectionSweep: (companyId: string, ids: readonly string[]) => {
    h.trace.push({ call: 'scheduleCollectionSweep', companyId, ids: [...ids] })
  },
}))

vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: async () => null,
}))

import { ingestTransactions } from '../ingest'

const COMPANY = 'company-ch'
const USER = 'user-ch'
const CASH_ACCOUNT = ARCIM.cashAccountId
const CONNECTION = 'conn-op'

// ---------------------------------------------------------------------------
// The recording database
// ---------------------------------------------------------------------------

function matches(row: Row, [op, column, value]: Filter): boolean {
  const v = row[column] as never
  switch (op) {
    case 'eq':
      return v === value
    case 'neq':
      return v != null && v !== value
    case 'is':
      return value === null ? v == null : v === value
    case 'not.is':
      return value === null ? v != null : v !== value
    case 'in':
      return (value as unknown[]).includes(v)
    case 'gt':
      return v != null && v > (value as never)
    case 'gte':
      return v != null && v >= (value as never)
    case 'lt':
      return v != null && v < (value as never)
    case 'lte':
      return v != null && v <= (value as never)
    default:
      throw new Error(`fakeDb: filter ${op} is not modelled`)
  }
}

const describeFilters = (filters: Filter[]) =>
  filters.map(([op, column, value]) => `${op} ${column} ${JSON.stringify(value)}`).join('; ')

interface FakeDbOptions {
  tables: Record<string, Row[]>
  /** A write the database refuses: the error it answers with, or null. */
  failWrite?: (write: { op: string; table: string; payload: unknown }) => { message: string; code?: string } | null
  /** A read the database refuses: the error it answers with, or null. */
  failRead?: (table: string) => { message: string } | null
}

function fakeDb({ tables, failWrite, failRead }: FakeDbOptions) {
  const reads: string[] = []

  class Query {
    private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select'
    private payload: unknown = undefined
    private filters: Filter[] = []
    private returning = false
    private mode: 'many' | 'single' | 'maybeSingle' = 'many'
    private window: [number, number] | null = null
    private max: number | null = null

    constructor(private readonly table: string) {}

    select() {
      if (this.op !== 'select') this.returning = true
      return this
    }
    insert(payload: unknown) {
      this.op = 'insert'
      this.payload = payload
      return this
    }
    update(payload: unknown) {
      this.op = 'update'
      this.payload = payload
      return this
    }
    upsert(payload: unknown) {
      this.op = 'upsert'
      this.payload = payload
      return this
    }
    delete() {
      this.op = 'delete'
      return this
    }
    eq(column: string, value: unknown) {
      this.filters.push(['eq', column, value])
      return this
    }
    neq(column: string, value: unknown) {
      this.filters.push(['neq', column, value])
      return this
    }
    is(column: string, value: unknown) {
      this.filters.push(['is', column, value])
      return this
    }
    not(column: string, op: string, value: unknown) {
      this.filters.push([`not.${op}`, column, value])
      return this
    }
    in(column: string, values: unknown[]) {
      this.filters.push(['in', column, values])
      return this
    }
    gt(column: string, value: unknown) {
      this.filters.push(['gt', column, value])
      return this
    }
    gte(column: string, value: unknown) {
      this.filters.push(['gte', column, value])
      return this
    }
    lt(column: string, value: unknown) {
      this.filters.push(['lt', column, value])
      return this
    }
    lte(column: string, value: unknown) {
      this.filters.push(['lte', column, value])
      return this
    }
    order() {
      return this
    }
    range(from: number, to: number) {
      this.window = [from, to]
      return this
    }
    limit(n: number) {
      this.max = n
      return this
    }
    single() {
      this.mode = 'single'
      return this
    }
    maybeSingle() {
      this.mode = 'maybeSingle'
      return this
    }

    private shape(rows: Row[]): { data: unknown; error: unknown } {
      if (this.mode === 'single') return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'no row', code: 'PGRST116' } }
      if (this.mode === 'maybeSingle') return { data: rows[0] ?? null, error: null }
      return { data: rows, error: null }
    }

    private run(): { data: unknown; error: unknown } {
      const rows = (tables[this.table] ?? []).filter((row) => this.filters.every((f) => matches(row, f)))
      if (this.op === 'select') {
        reads.push(`${this.table}: ${describeFilters(this.filters)}`)
        const readError = failRead?.(this.table) ?? null
        if (readError) return { data: null, error: readError }
        let out = rows
        if (this.window) out = out.slice(this.window[0], this.window[1] + 1)
        if (this.max !== null) out = out.slice(0, this.max)
        return this.shape(out)
      }
      h.trace.push({ write: this.op, table: this.table, payload: this.payload ?? null, where: describeFilters(this.filters) })
      const error = failWrite?.({ op: this.op, table: this.table, payload: this.payload }) ?? null
      if (error) return { data: null, error }
      if (!this.returning) return { data: null, error: null }
      if (this.op === 'insert') {
        const payload = this.payload as Row
        const row: Row = {
          journal_entry_id: null,
          invoice_id: null,
          supplier_invoice_id: null,
          potential_invoice_id: null,
          potential_supplier_invoice_id: null,
          potential_match_method: null,
          is_ignored: false,
          ...payload,
          id: `tx:${String(payload.external_id)}`,
        }
        return this.shape([row])
      }
      return this.shape(rows.map((row) => ({ id: row.id })))
    }

    then<T>(resolve: (value: { data: unknown; error: unknown }) => T, reject?: (reason: unknown) => T) {
      try {
        return Promise.resolve(resolve(this.run()))
      } catch (error) {
        return reject ? Promise.resolve(reject(error)) : Promise.reject(error)
      }
    }
  }

  const supabase = {
    from: (table: string) => new Query(table),
    rpc: (fn: string, args: unknown) => {
      h.trace.push({ rpc: fn, args })
      return Promise.resolve({ data: null, error: null })
    },
  }
  return { supabase, reads }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const cashAccount: Row = {
  id: CASH_ACCOUNT,
  company_id: COMPANY,
  ledger_account: '1930',
  iban: null,
  currency: 'SEK',
  enabled: true,
  bank_connection_id: CONNECTION,
  invoice_payee: false,
}
const company: Row = { id: COMPANY, entity_type: 'aktiebolag' }

function raw(externalId: string, overrides: Partial<RawTransaction> = {}): RawTransaction {
  return {
    external_id: externalId,
    date: '2026-10-12',
    description: 'Bankrad',
    amount: -1,
    currency: 'SEK',
    mcc_code: null,
    merchant_name: null,
    reference: null,
    bank_connection_id: CONNECTION,
    import_source: 'open_payments',
    ...overrides,
  }
}

function stored(externalId: string, overrides: Partial<Transaction> = {}): Row {
  return makeTransaction({
    id: `st:${externalId}`,
    company_id: COMPANY,
    user_id: USER,
    external_id: externalId,
    bank_connection_id: CONNECTION,
    cash_account_id: CASH_ACCOUNT,
    import_source: 'open_payments',
    merchant_name: null,
    is_enriched: false,
    ...overrides,
  }) as unknown as Row
}

const part = (amount: number, seq: number): BankTransactionPartInput => ({
  amount,
  currency: 'SEK',
  counterparty_name: `Betalare ${seq}`,
  counterparty_org_number: null,
  counterparty_account: null,
  reference: null,
  invoice_numbers: [],
  message: null,
  provider_part_id: `P${seq}`,
})

function supplierInvoice(id: string, total: number, overrides: Partial<SupplierInvoice> = {}, supplierName = 'Leverantör AB'): Row {
  return makeSupplierInvoice({
    id,
    company_id: COMPANY,
    status: 'approved',
    total,
    remaining_amount: total,
    supplier: makeSupplier({ id: `sup:${id}`, name: supplierName, bankgiro: null }),
    ...overrides,
  }) as unknown as Row
}

const rotRutRequest = (id: string, total: number): RotRutPayoutRequestCandidate => ({
  id,
  name: `Begäran ${id}`,
  deduction_type: 'rot',
  status: 'submitted',
  requested_total: total,
  decided_total: null,
  settlement_journal_entry_id: null,
})

/** An order Accounted sent, settleable, matched by amount, account and date. */
const executedOrder = (id: string, amount: number, supplierInvoiceId: string, payeeName: string) =>
  paymentOrder(id, {
    company_id: COMPANY,
    status: 'executed',
    provider_payment_id: `pay-${id}`,
    amount,
    requested_execution_date: '2026-10-14',
    cash_account_id: CASH_ACCOUNT,
    payee_bankgiro: '99887766',
    payee_name: payeeName,
    supplier_invoice_id: supplierInvoiceId,
  })

const REREAD_E2E = 'ACCREREAD0000000000000000000000000'

function openPaymentsScenario(): { scenario: Scenario; tables: Record<string, Row[]>; rows: RawTransaction[] } {
  const scenario: Scenario = {
    invoices: [
      { id: 'inv-split-a', total: 1000, ocr: 'OCR-SPLIT-A' },
      { id: 'inv-split-b', total: 2000, ocr: null },
      { id: 'inv-ocr', total: 1250, ocr: 'OCR-1001' },
      { id: 'inv-700', total: 700, ocr: null },
      { id: 'inv-reread', total: 2000.5, ocr: 'OCR-2002' },
      { id: 'inv-650b', total: 650, ocr: null },
    ],
    invoicePoolFails: false,
    paymentOrders: [
      paymentOrder('po-e2e', {
        company_id: COMPANY,
        status: 'accepted',
        provider_payment_id: 'pay-e2e',
        amount: 1000,
        end_to_end_id: 'ACC0F3A',
        supplier_invoice_id: 'si-e2e',
      }),
      arcimOrder({ company_id: COMPANY }),
      executedOrder('po-refused', 250, 'si-refused', 'Byggvaror Norr AB'),
      executedOrder('po-refused-2', 420, 'si-po2', 'Lagerhuset AB'),
      paymentOrder('po-reread', {
        company_id: COMPANY,
        status: 'accepted',
        provider_payment_id: 'pay-reread',
        amount: 737.5,
        end_to_end_id: REREAD_E2E,
        supplier_invoice_id: 'si-reread',
      }),
    ],
    settle: {
      'po-e2e': { ok: true },
      [ARCIM.orderId]: { ok: true },
      'po-refused': { ok: false, reason: 'booking_failed', code: 'TARGET_PERIOD_LOCKED' },
      'po-refused-2': { ok: false, reason: 'amount_mismatch' },
      'po-reread': { ok: true },
    },
    rotRut: [rotRutRequest('rr-1', 5000), rotRutRequest('rr-2', 1500), rotRutRequest('rr-3', 2500), rotRutRequest('rr-4', 800)],
    split: {
      'op-split-complete': {
        complete: true,
        suggestions: [
          { suggested_invoice_id: 'inv-split-a', suggested_supplier_invoice_id: null },
          { suggested_invoice_id: 'inv-split-b', suggested_supplier_invoice_id: null },
        ],
      },
      'op-split-incomplete': {
        complete: false,
        suggestions: [
          { suggested_invoice_id: 'inv-split-b', suggested_supplier_invoice_id: null },
          { suggested_invoice_id: null, suggested_supplier_invoice_id: null },
        ],
      },
      'op-split-supplier': {
        complete: true,
        suggestions: [
          { suggested_invoice_id: null, suggested_supplier_invoice_id: 'si-split' },
          { suggested_invoice_id: null, suggested_supplier_invoice_id: 'si-split-b' },
        ],
      },
      'op-split-throws': 'throw',
      'op-reread-split': {
        complete: true,
        suggestions: [
          { suggested_invoice_id: 'inv-reread-split', suggested_supplier_invoice_id: null },
          { suggested_invoice_id: 'inv-reread-split-b', suggested_supplier_invoice_id: null },
        ],
      },
    },
    mapping: {
      SPOTIFY: { confidence: 0.9 },
      'KONTORSGIGANTEN 420': { confidence: 0.9 },
      'ELEKTRO GROSSISTEN': { confidence: 0.9 },
      OKAND: { confidence: 0.95, requires_review: true },
    },
  }

  const tables: Record<string, Row[]> = {
    companies: [company],
    cash_accounts: [cashAccount],
    supplier_invoices: [
      supplierInvoice('si-e2e', 1000, { payment_reference: '5550001' }, 'Elektro Grossisten AB'),
      supplierInvoice(ARCIM.invoiceId, 10, {}, 'Mattsson Systems AB'),
      supplierInvoice('si-refused', 250, { payment_reference: '5550250' }, 'Byggvaror Norr AB'),
      supplierInvoice('si-po2', 420, {}, 'Lagerhuset AB'),
      supplierInvoice('si-kontor', 418, {}, 'Kontorsgiganten AB'),
      supplierInvoice('si-ocr', 1200, { payment_reference: '7777001' }, 'Revisorerna AB'),
      supplierInvoice('si-weak', 333, {}, 'Pappersgrossen AB'),
      supplierInvoice('si-amb-1', 640, { invoice_date: '2026-10-01', due_date: '2026-10-31' }, 'Stadbolaget AB'),
      supplierInvoice('si-amb-2', 640, { invoice_date: '2026-10-01', due_date: '2026-10-31' }, 'Stadbolaget AB'),
      supplierInvoice('si-split', 900, { payment_reference: '9990900' }, 'Delad Leverans AB'),
      supplierInvoice('si-reread', 737.5, {}, 'Omlast AB'),
    ],
    transactions: [
      stored('op-reread-ocr', { date: '2026-10-05', amount: 2000.5, description: 'Bg-inbetalning', original_description: 'Bg-inbetalning', potential_invoice_id: 'inv-old' }),
      stored('op-reread-stands', { date: '2026-10-05', amount: 650, description: 'Bg-inbetalning', original_description: 'Bg-inbetalning', potential_invoice_id: 'inv-650a' }),
      stored('op-reread-e2e', { date: '2026-10-06', amount: -737.5, description: 'Omlast', original_description: 'Omlast', end_to_end_id: null }),
      stored('op-reread-supplier', { date: '2026-10-06', amount: -335, description: 'PAPPERSGROSSEN', original_description: 'PAPPERSGROSSEN', potential_supplier_invoice_id: 'si-weak' }),
      stored('op-reread-booked', { date: '2026-10-07', amount: -55, description: 'Bokad rad', original_description: 'Bokad rad', journal_entry_id: 'je-old' }),
      stored('op-reread-split', { date: '2026-10-07', amount: 1800, description: 'Bg-inbetalning', original_description: 'Bg-inbetalning', is_enriched: true }),
      stored('op-reread-same', { date: '2026-10-08', amount: -12, description: 'Samma', original_description: 'Samma' }),
    ],
  }

  const rows: RawTransaction[] = [
    // Income
    raw('op-split-complete', { date: '2026-10-10', amount: 3000, description: 'Bg-inbetalning', parts: [part(1000, 1), part(2000, 2)] }),
    raw('op-ocr', { date: '2026-10-10', amount: 1250, description: 'Inbetalning', reference: 'OCR-1001' }),
    raw('op-ocr-again', { date: '2026-10-10', amount: 1250, description: 'Inbetalning igen', reference: 'OCR-1001' }),
    raw('op-claimed-by-split', { date: '2026-10-10', amount: 1000, description: 'Delbetalning', reference: 'OCR-SPLIT-A' }),
    raw('op-split-incomplete', { date: '2026-10-11', amount: 700, description: 'Bg-inbetalning', parts: [part(400, 1), part(300, 2)] }),
    raw('op-rotrut-single', { date: '2026-10-11', amount: 5000, description: 'SKATTEVERKET' }),
    raw('op-rotrut-set', { date: '2026-10-11', amount: 4000, description: 'SKATTEVERKET' }),
    raw('op-rotrut-hint-fails', { date: '2026-10-11', amount: 800, description: 'Skatteverket utbetalning' }),
    raw('op-scorer-throws', { date: '2026-10-11', amount: 321, description: 'KASTA' }),
    raw('op-split-throws', { date: '2026-10-11', amount: 60, description: 'Bg-inbetalning', parts: [part(30, 1), part(30, 2)] }),
    raw('op-zero', { date: '2026-10-11', amount: 0, description: 'Nollrad' }),
    // Expense
    raw('op-e2e', { date: '2026-10-12', amount: -1000, description: 'Betalning', end_to_end_id: 'acc0f3a' }),
    raw('op-swedbank', {
      date: '2026-10-13',
      value_date: '2026-10-13',
      amount: -10,
      description: 'MATTSSON SYSTEMS BG 0000052386828',
      reference: 'Bg-bet. via internet',
    }),
    raw('op-refused', { date: '2026-10-14', amount: -250, description: 'BETALNING 250' }),
    raw('op-refused-hint-fails', { date: '2026-10-14', amount: -420, description: 'KONTORSGIGANTEN 420' }),
    raw('op-supplier-strong', { date: '2026-10-14', amount: -1200, description: 'Revision', reference: '7777001' }),
    raw('op-supplier-strong-again', { date: '2026-10-14', amount: -1200, description: 'Revision igen', reference: '7777001' }),
    raw('op-supplier-weak', { date: '2026-10-10', amount: -335, description: 'PAPPERSGROSSEN' }),
    raw('op-supplier-ambiguous', { date: '2026-10-10', amount: -640, description: 'Stadning oktober' }),
    raw('op-split-supplier', { date: '2026-10-12', amount: -900, description: 'Bg-betalning', parts: [part(-600, 1), part(-300, 2)] }),
    raw('op-claimed-supplier', { date: '2026-10-12', amount: -900, description: 'Delad igen', reference: '9990900' }),
    raw('op-after-settle', { date: '2026-10-12', amount: -1000, description: 'ELEKTRO GROSSISTEN', reference: '5550001' }),
    raw('op-mapping', { date: '2026-10-12', amount: -99, description: 'SPOTIFY' }),
    raw('op-mapping-review', { date: '2026-10-12', amount: -45, description: 'OKAND' }),
    // Re-reads of stored rows (Layer 1)
    raw('op-reread-ocr', { date: '2026-10-05', amount: 2000.5, description: 'Bg-inbetalning', reference: 'OCR-2002', is_enriched: true }),
    raw('op-reread-stands', { date: '2026-10-05', amount: 650, description: 'Bg-inbetalning', merchant_name: 'Kund Sex AB' }),
    raw('op-reread-e2e', { date: '2026-10-06', amount: -737.5, description: 'Omlast', end_to_end_id: REREAD_E2E }),
    raw('op-reread-supplier', { date: '2026-10-06', amount: -335, description: 'PAPPERSGROSSEN', counterparty_org_number: '5566778899' }),
    raw('op-reread-booked', { date: '2026-10-07', amount: -55, description: 'Bokad rad', reference: 'NY-REF' }),
    raw('op-reread-split', { date: '2026-10-07', amount: 1800, description: 'Bg-inbetalning', parts: [part(800, 1), part(1000, 2)] }),
    raw('op-reread-same', { date: '2026-10-08', amount: -12, description: 'Samma' }),
  ]
  return { scenario, tables, rows }
}

/** The failure batch: an invoice pool that fails on every income row, a settle that throws. */
function failuresScenario(): { scenario: Scenario; tables: Record<string, Row[]>; rows: RawTransaction[] } {
  const base = openPaymentsScenario()
  const scenario: Scenario = {
    ...base.scenario,
    invoicePoolFails: true,
    paymentOrders: [executedOrder('po-throws', 77, 'si-throws', 'Kastare AB')],
    settle: { 'po-throws': 'throw' },
    rotRut: [],
    split: {},
  }
  const tables = {
    ...base.tables,
    transactions: [],
    supplier_invoices: [supplierInvoice('si-throws', 77, { payment_reference: '7070707' }, 'Kastare AB')],
  }
  const rows = [
    raw('fail-income-1', { date: '2026-10-14', amount: 500, description: 'KUND BETALAR' }),
    raw('fail-income-2', { date: '2026-10-14', amount: 600, description: 'KUND BETALAR IGEN' }),
    raw('fail-settle', { date: '2026-10-14', amount: -77, description: 'KASTARE', reference: '7070707' }),
    raw('fail-mapping', { date: '2026-10-14', amount: -99, description: 'SPOTIFY' }),
  ]
  return { scenario, tables, rows }
}

const failingWrites = (write: { op: string; table: string; payload: unknown }) => {
  const payload = (write.payload ?? {}) as Row
  if (write.op !== 'update' || write.table !== 'transactions') return null
  if (payload.potential_rot_rut_payout_request_id === 'rr-4') return { message: 'hint refused' }
  if (payload.potential_supplier_invoice_id === 'si-po2') return { message: 'hint refused' }
  return null
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

async function record(
  setup: { scenario: Scenario; tables: Record<string, Row[]>; rows: RawTransaction[] },
  options: Parameters<typeof ingestTransactions>[4],
  failRead?: FakeDbOptions['failRead'],
) {
  h.trace.length = 0
  h.logs.length = 0
  for (const key of Object.keys(h.loads)) delete h.loads[key]
  Object.assign(h.scenario, setup.scenario)
  const db = fakeDb({ tables: setup.tables, failWrite: failingWrites, failRead })
  const result = await ingestTransactions(db.supabase as never, COMPANY, USER, setup.rows, options)
  return {
    result,
    trace: [...h.trace],
    reads: db.reads,
    loads: { ...h.loads },
    logs: h.logs
      .filter((rec) => rec.module === 'transactions.ingest')
      .map(({ ts: _ts, ...rest }) => rest),
  }
}

describe('ingestTransactions suggestion passes (characterisation)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-16T09:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('an Open Payments batch: new rows through every pass, and re-reads', async () => {
    const recorded = await record(openPaymentsScenario(), { settlementAccount: '1930' })
    expect(recorded).toMatchSnapshot()
  })

  it('a raw insert: rows and splits stored, re-read enrichment written, no pass and no loader', async () => {
    const base = openPaymentsScenario()
    const rows = [
      base.rows.find((r) => r.external_id === 'op-split-complete')!,
      base.rows.find((r) => r.external_id === 'op-swedbank')!,
      base.rows.find((r) => r.external_id === 'op-ocr')!,
      base.rows.find((r) => r.external_id === 'op-reread-ocr')!,
    ]
    const recorded = await record({ ...base, rows }, { settlementAccount: '1930', rawInsertOnly: true })
    expect(recorded.loads).toEqual({})
    expect(recorded).toMatchSnapshot()
  })

  it('failures: an invoice pool that fails on every income row, a settle that throws, the heuristics after it', async () => {
    const recorded = await record(failuresScenario(), { settlementAccount: '1930' })
    expect(recorded).toMatchSnapshot()
  })

  it('reaches every branch the parity proof relies on', async () => {
    const { trace, result } = await record(openPaymentsScenario(), { settlementAccount: '1930' })
    const writes = trace as Array<Record<string, unknown>>
    const updated = (column: string, value: unknown) =>
      writes.some((w) => w.write === 'update' && (w.payload as Row)?.[column] === value)
    const settled = (basis: string) => writes.some((w) => w.call === 'settleOrderWithDebit' && w.basis === basis)
    const logged = (predicate: (payload: Row) => boolean) =>
      writes.some((w) => w.write === 'insert' && w.table === 'payment_match_log' && predicate(w.payload as Row))

    // Customer invoice: OCR hit, a claimed invoice never offered twice, a stronger re-read hint.
    expect(updated('potential_invoice_id', 'inv-ocr')).toBe(true)
    expect(writes.filter((w) => (w.payload as Row)?.potential_invoice_id === 'inv-ocr')).toHaveLength(1)
    expect(updated('potential_invoice_id', 'inv-split-a')).toBe(false)
    expect(updated('potential_invoice_id', 'inv-700')).toBe(true)
    expect(updated('potential_invoice_id', 'inv-reread')).toBe(true)
    expect(updated('potential_invoice_id', 'inv-650b')).toBe(false)
    // Payment orders: end-to-end, the Swedbank payee debit, a refused settle that leaves a hint.
    expect(settled('end_to_end_id')).toBe(true)
    expect(settled('payee')).toBe(true)
    expect(settled('amount_account_date')).toBe(true)
    expect(updated('potential_supplier_invoice_id', 'si-refused')).toBe(true)
    // A refused hint falls through to the heuristics: weak, then the mapping rule books.
    expect(updated('potential_supplier_invoice_id', 'si-kontor')).toBe(true)
    // Supplier heuristics: strong (once: the pool drains), weak, ambiguous.
    expect(writes.filter((w) => (w.payload as Row)?.potential_supplier_invoice_id === 'si-ocr')).toHaveLength(1)
    expect(updated('potential_supplier_invoice_id', 'si-weak')).toBe(true)
    expect(updated('potential_supplier_invoice_id', 'si-amb-1')).toBe(true)
    expect(updated('potential_supplier_invoice_id', 'si-split')).toBe(false)
    expect(updated('potential_supplier_invoice_id', 'si-e2e')).toBe(false)
    // ROT/RUT: 1:1, the set, the hint that fails.
    expect(updated('potential_rot_rut_payout_request_id', 'rr-1')).toBe(true)
    expect(logged((p) => JSON.stringify(p.new_state) === JSON.stringify({ rot_rut_payout_request_ids: ['rr-3', 'rr-2'] }))).toBe(true)
    expect(writes.some((w) => w.write === 'update' && (w.payload as Row)?.potential_rot_rut_payout_request_id === 'rr-4')).toBe(true)
    // The mapping rule: books two rows, one wants review.
    expect(writes.filter((w) => w.call === 'createTransactionJournalEntry').map((w) => w.tx)).toEqual([
      'tx:op-refused-hint-fails',
      'tx:op-after-settle',
      'tx:op-mapping',
    ])
    // The split: complete, incomplete, throws, on a re-read.
    expect(writes.filter((w) => w.call === 'applyTransactionSplit').map((w) => w.tx)).toEqual([
      'tx:op-split-complete',
      'tx:op-split-incomplete',
      'tx:op-split-throws',
      'tx:op-split-supplier',
      'st:op-reread-split',
    ])
    expect(result).toMatchObject({ enriched_updated: 5, duplicates: 7, errors: 0 })
  })
})

// ---------------------------------------------------------------------------
// The package gate (INGEST_PACKAGE_GATING, lib/transactions/ingest-package-gate.ts)
// ---------------------------------------------------------------------------

type Recording = Awaited<ReturnType<typeof record>>

/** The gate's switch read: the stored profile, then the switches of the packages that own a matcher. */
const PROFILE_READ = `companies: eq id "${COMPANY}"`
const SWITCH_READ = `company_capability_config: eq company_id "${COMPANY}"; in capability_key ["package:customer-invoices","package:supplier-invoices-and-payments"]`
/** Kundfakturor's obligation probes (lib/modules/obligations.ts), read only once it is switched off. */
const CUSTOMER_INVOICE_PROBES = [
  `invoices: eq company_id "${COMPANY}"; in status ["sent","overdue","partially_paid"]; eq document_type "invoice"; is credited_invoice_id null; gt remaining_amount 0`,
  `recurring_invoice_schedules: eq company_id "${COMPANY}"; eq status "active"`,
  `collection_cases: eq company_id "${COMPANY}"; eq is_open true`,
  `rot_rut_payout_requests: eq company_id "${COMPANY}"; in status ["generated","submitted","paid","partially_paid"]; is settlement_journal_entry_id null`,
]

/**
 * The recording without the gate's own reads, after checking they ran as one
 * block (the profile and switch read, then any probes).
 */
function withoutGateReads(recorded: Recording, probes: string[] = []): Recording {
  const gateReads = [PROFILE_READ, SWITCH_READ, ...probes]
  const at = recorded.reads.indexOf(SWITCH_READ) - 1
  expect(at).toBeGreaterThanOrEqual(0)
  expect(recorded.reads.slice(at, at + gateReads.length)).toEqual(gateReads)
  return { ...recorded, reads: [...recorded.reads.slice(0, at), ...recorded.reads.slice(at + gateReads.length)] }
}

/** A company's own choice for a package, as set_company_package_choice stores it. */
const switchedOff = (packageId: string): Row => ({ company_id: COMPANY, capability_key: `package:${packageId}`, enabled: false })

/** Which passes the batch's log line counted, and the packages it skipped. */
function passLine(recorded: Recording) {
  const line = recorded.logs.find((rec) => rec.msg === 'ingest suggestion passes') as
    | { passes: Record<string, unknown>; packagesOff?: string[] }
    | undefined
  return { passes: Object.keys(line?.passes ?? {}).sort(), packagesOff: line?.packagesOff }
}

describe('ingestTransactions package gate (INGEST_PACKAGE_GATING)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-16T09:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('flag on, every package on: each characterised batch runs exactly as with the flag off, plus the one switch read', async () => {
    const base = openPaymentsScenario()
    const rawRows = ['op-split-complete', 'op-swedbank', 'op-ocr', 'op-reread-ocr'].map(
      (id) => base.rows.find((r) => r.external_id === id)!,
    )
    const batches: Array<[ReturnType<typeof openPaymentsScenario>, Parameters<typeof ingestTransactions>[4]]> = [
      [openPaymentsScenario(), { settlementAccount: '1930' }],
      [{ ...openPaymentsScenario(), rows: rawRows }, { settlementAccount: '1930', rawInsertOnly: true }],
      [failuresScenario(), { settlementAccount: '1930' }],
    ]
    for (const [setup, options] of batches) {
      const flagOff = await record(setup, options)
      vi.stubEnv('INGEST_PACKAGE_GATING', 'true')
      const flagOn = await record(setup, options)
      vi.unstubAllEnvs()
      expect(withoutGateReads(flagOn)).toEqual(flagOff)
    }
  })

  it('Kundfakturor switched off with nothing open: no customer invoice, ROT/RUT or collections pass and no customer pool; the supplier side runs as before', async () => {
    const setup = openPaymentsScenario()
    setup.tables.company_capability_config = [switchedOff('customer-invoices')]
    const flagOff = await record(setup, { settlementAccount: '1930' })
    vi.stubEnv('INGEST_PACKAGE_GATING', 'true')
    const flagOn = await record(setup, { settlementAccount: '1930' })

    const trace = flagOn.trace as Array<Record<string, unknown>>
    // The customer invoice pool and the open begäran are never read, the sweep never scheduled.
    expect(trace.filter((t) => t.call === 'loadInvoiceMatchPool' || t.call === 'bestInvoiceMatch')).toEqual([])
    expect(trace.filter((t) => t.call === 'scheduleCollectionSweep')).toEqual([])
    expect(flagOn.loads).toEqual({ loadOpenPaymentOrders: 1 })
    expect(flagOff.loads).toEqual({ loadOpenPaymentOrders: 1, loadOpenRotRutPayoutRequests: 1 })
    // No customer invoice or begäran hint is written.
    const hints = (column: string) => trace.filter((t) => t.write === 'update' && (t.payload as Row)?.[column] !== undefined)
    expect(hints('potential_invoice_id')).toEqual([])
    expect(hints('potential_rot_rut_payout_request_id')).toEqual([])
    // The split still runs, against an empty customer pool.
    const split = trace.find((t) => t.call === 'applyTransactionSplit' && t.tx === 'tx:op-split-complete')
    expect((split?.pools as { customerInvoices: string[] }).customerInvoices).toEqual([])
    // The gate read Kundfakturor's obligations, found none, and the log names it.
    withoutGateReads(flagOn, CUSTOMER_INVOICE_PROBES)
    expect(passLine(flagOn).packagesOff).toEqual(['customer-invoices'])
    expect(passLine(flagOn).passes.filter((p) => p.startsWith('rot-rut') || p === 'customer-invoice')).toEqual([])
    expect(passLine(flagOff).packagesOff).toBeUndefined()

    // The expense side is untouched: the same order debits, the same supplier hints.
    const supplierSide = (recorded: Recording) =>
      (recorded.trace as Array<Record<string, unknown>>).filter(
        (t) => t.call === 'settleOrderWithDebit' || (t.write === 'update' && (t.payload as Row)?.potential_supplier_invoice_id !== undefined),
      )
    expect(supplierSide(flagOn)).toEqual(supplierSide(flagOff))
    expect(supplierSide(flagOn).length).toBeGreaterThan(0)
  })

  it('Kundfakturor switched off while a begäran awaits its payout: winding down, every matcher runs as with the flag off', async () => {
    const setup = openPaymentsScenario()
    setup.tables.company_capability_config = [switchedOff('customer-invoices')]
    setup.tables.rot_rut_payout_requests = [
      { id: 'rr-pending', company_id: COMPANY, status: 'submitted', settlement_journal_entry_id: null },
    ]
    const flagOff = await record(setup, { settlementAccount: '1930' })
    vi.stubEnv('INGEST_PACKAGE_GATING', 'true')
    const flagOn = await record(setup, { settlementAccount: '1930' })
    expect(withoutGateReads(flagOn, CUSTOMER_INVOICE_PROBES)).toEqual(flagOff)
  })

  it('a switch read that fails runs every matcher as with the flag off', async () => {
    const setup = openPaymentsScenario()
    setup.tables.company_capability_config = [switchedOff('customer-invoices')]
    const failSwitch = (table: string) => (table === 'company_capability_config' ? { message: 'switch read failed' } : null)
    const flagOff = await record(setup, { settlementAccount: '1930' }, failSwitch)
    vi.stubEnv('INGEST_PACKAGE_GATING', 'true')
    const flagOn = await record(setup, { settlementAccount: '1930' }, failSwitch)
    expect(withoutGateReads(flagOn)).toEqual(flagOff)
  })

  it('Leverantörsfakturor och betalningar off by the profile with nothing open: no order or supplier pass, the supplier pool never read', async () => {
    const setup = openPaymentsScenario()
    // Enskild firma starts with the package off; nothing is owed or on its way.
    setup.tables.companies = [{ ...company, profile_id: 'sole-trader', profile_version: 1 }]
    setup.tables.supplier_invoices = []
    vi.stubEnv('INGEST_PACKAGE_GATING', 'true')
    const flagOn = await record(setup, { settlementAccount: '1930' })

    const trace = flagOn.trace as Array<Record<string, unknown>>
    expect(flagOn.loads).toEqual({ loadOpenRotRutPayoutRequests: 1 })
    expect(flagOn.reads.filter((r) => r.startsWith('supplier_invoices:') && r.includes('remaining_amount'))).toEqual([])
    expect(trace.filter((t) => t.call === 'settleOrderWithDebit')).toEqual([])
    const split = trace.find((t) => t.call === 'applyTransactionSplit' && t.tx === 'tx:op-split-supplier')
    expect((split?.pools as { supplierInvoices: string[] }).supplierInvoices).toEqual([])
    expect(passLine(flagOn).packagesOff).toEqual(['supplier-invoices-and-payments'])
    expect(passLine(flagOn).passes.filter((p) => p === 'payment-order' || p === 'supplier-invoice')).toEqual([])
    // The income side still matches: the OCR hint and the ROT/RUT payout.
    expect(trace.some((t) => t.write === 'update' && (t.payload as Row)?.potential_invoice_id === 'inv-ocr')).toBe(true)
    expect(trace.some((t) => t.write === 'update' && (t.payload as Row)?.potential_rot_rut_payout_request_id === 'rr-1')).toBe(true)
  })
})
