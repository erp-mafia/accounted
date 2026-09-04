import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CreateJournalEntryInput, Currency } from '@/types'
import { makeInvoice, makeSupplierInvoice } from '@/tests/helpers'
import { getErrorMessage } from '@/lib/errors/get-error-message'

// Mock riksbanken. The revaluation deliberately uses fetchExchangeRate, the
// documented booking path that returns null rather than one of the hardcoded
// display-only fallback constants, so the mock returns null for any currency
// the test did not price.
vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: vi.fn(),
}))

// Mock engine
vi.mock('../engine', () => ({
  createJournalEntry: vi.fn().mockImplementation(
    async (_supabase: unknown, _companyId: string, _userId: string, input: CreateJournalEntryInput) => ({
      id: 'entry-1',
      ...input,
      lines: input.lines,
      status: 'posted',
      voucher_number: 1,
      voucher_series: 'A',
      user_id: _userId,
      committed_at: '2024-12-31T00:00:00Z',
      reversed_by_id: null,
      reverses_id: null,
      correction_of_id: null,
      attachment_urls: null,
      created_at: '2024-12-31T00:00:00Z',
      updated_at: '2024-12-31T00:00:00Z',
    })
  ),
}))

// Mock supabase server
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

const { fetchExchangeRate } = await import('@/lib/currency/riksbanken')
const mockedFetchRate = vi.mocked(fetchExchangeRate)

const { createJournalEntry } = await import('../engine')
const mockedCreateEntry = vi.mocked(createJournalEntry)

const {
  getOpenForeignCurrencyReceivables,
  getOpenForeignCurrencyPayables,
  previewCurrencyRevaluation,
  executeCurrencyRevaluation,
} = await import('../currency-revaluation')

/**
 * Price the given currencies. Anything not listed resolves to null, which is
 * exactly what fetchExchangeRate does when Riksbanken is unreachable and the
 * cache is empty: no rate at all, never a fabricated one.
 */
function mockRates(rates: Partial<Record<Currency, number>>) {
  mockedFetchRate.mockImplementation(async (currency: Currency) => {
    const rate = rates[currency]
    return rate === undefined ? null : { currency, rate, date: '2024-12-31' }
  })
}

/**
 * Extra tables the preview reads besides the two invoice ledgers:
 * company_settings decides the FX exposure scope (cash/deferred/accrual) and
 * the payment tables feed the as-of-balansdagen outstanding reconstruction.
 */
interface MockTablesConfig {
  invoices?: ReturnType<typeof makeInvoice>[]
  supplierInvoices?: ReturnType<typeof makeSupplierInvoice>[]
  settings?: Record<string, unknown>
  invoicePayments?: Record<string, unknown>[]
  supplierInvoicePayments?: Record<string, unknown>[]
  existingRevaluation?: boolean
}

function buildFromMap(config: MockTablesConfig): Record<string, unknown[]> {
  return {
    invoices: config.invoices || [],
    supplier_invoices: config.supplierInvoices || [],
    company_settings: config.settings ? [config.settings] : [],
    invoice_payments: config.invoicePayments || [],
    supplier_invoice_payments: config.supplierInvoicePayments || [],
  }
}

// Helper to build mock supabase
function createMockSupabase(config: MockTablesConfig) {
  const fromMap = buildFromMap(config)

  const supabase = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'journal_entries') {
        // For idempotency check
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnThis(),
            then: undefined,
            count: undefined,
            // Build chain that resolves with count
            ...((() => {
              const chain: Record<string, unknown> = {}
              chain.eq = vi.fn().mockReturnValue(chain)
              chain.select = vi.fn().mockReturnValue(chain)
              // Terminal: return count
              Object.defineProperty(chain, 'then', {
                value: (resolve: (val: unknown) => void) => {
                  resolve({
                    count: config.existingRevaluation ? 1 : 0,
                    error: null,
                  })
                },
              })
              return chain
            })()),
          }),
        }
      }

      const data = fromMap[table] || []
      const chain = buildFilterChain(data)
      return chain
    }),
  }

  return supabase
}

function buildFilterChain(data: unknown[]) {
  let filtered = [...data]

  const chain: Record<string, unknown> = {}

  chain.select = vi.fn().mockImplementation(() => {
    return chain
  })

  chain.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
    filtered = filtered.filter((row) => (row as Record<string, unknown>)[col] === val)
    return chain
  })

  chain.neq = vi.fn().mockImplementation((col: string, val: unknown) => {
    filtered = filtered.filter((row) => (row as Record<string, unknown>)[col] !== val)
    return chain
  })

  chain.in = vi.fn().mockImplementation((col: string, vals: unknown[]) => {
    filtered = filtered.filter((row) => vals.includes((row as Record<string, unknown>)[col]))
    return chain
  })

  chain.not = vi.fn().mockImplementation((col: string, op: string, _val: unknown) => {
    if (op === 'is') {
      filtered = filtered.filter((row) => (row as Record<string, unknown>)[col] != null)
    }
    return chain
  })

  // ISO date strings compare correctly as strings, matching PostgREST lte.
  chain.lte = vi.fn().mockImplementation((col: string, val: string) => {
    filtered = filtered.filter((row) => {
      const v = (row as Record<string, unknown>)[col]
      return v != null && String(v) <= val
    })
    return chain
  })

  // Terminal used by fetchFxExposureScope's company_settings read.
  chain.maybeSingle = vi.fn().mockImplementation(() =>
    Promise.resolve({ data: filtered[0] ?? null, error: null })
  )

  // Paging stability order: no-op in the mock (data is already deterministic).
  chain.order = vi.fn().mockImplementation(() => chain)

  // fetchAllRows paginates via .range(from, to); slice so pagination terminates
  // correctly even when a test supplies more than one page of rows.
  chain.range = vi.fn().mockImplementation((from: number, to: number) => ({
    then: (resolve: (val: unknown) => void) =>
      resolve({ data: filtered.slice(from, to + 1), error: null }),
  }))

  // Make it thenable for await (used by callers that don't paginate)
  chain.then = (resolve: (val: unknown) => void) => {
    resolve({ data: filtered, error: null })
  }

  return chain
}

// Better mock for supabase that supports journal_entries idempotency check
function createFullMockSupabase(config: MockTablesConfig) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'journal_entries') {
        const countResult = {
          count: config.existingRevaluation ? 1 : 0,
          error: null,
        }
        const journalChain: Record<string, unknown> = {}
        journalChain.select = vi.fn().mockReturnValue(journalChain)
        journalChain.eq = vi.fn().mockReturnValue(journalChain)
        journalChain.then = (resolve: (val: unknown) => void) => {
          resolve(countResult)
        }
        return journalChain
      }

      const fromMap = buildFromMap(config)
      return buildFilterChain(fromMap[table] || [])
    }),
  }

  return supabase
}

describe('currency-revaluation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getOpenForeignCurrencyReceivables', () => {
    it('returns non-SEK invoices with sent/overdue status', async () => {
      const eurInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.5,
        total: 1000,
      })
      const sekInvoice = makeInvoice({
        status: 'sent',
        currency: 'SEK',
        total: 5000,
      })

      const supabase = createMockSupabase({ invoices: [eurInvoice, sekInvoice] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await getOpenForeignCurrencyReceivables(supabase as any, 'company-1')

      expect(result).toHaveLength(1)
      expect(result[0].currency).toBe('EUR')
    })

    it('excludes paid invoices', async () => {
      const paidEurInvoice = makeInvoice({
        status: 'paid',
        currency: 'EUR',
        exchange_rate: 11.5,
        total: 1000,
      })

      const supabase = createMockSupabase({ invoices: [paidEurInvoice] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await getOpenForeignCurrencyReceivables(supabase as any, 'company-1')

      expect(result).toHaveLength(0)
    })

    it('never revalues a quote or proforma: they sit on no 1510 balance', async () => {
      const invoice = makeInvoice({ id: 'inv-1', status: 'sent', currency: 'EUR', exchange_rate: 11.5 })
      const quote = makeInvoice({
        id: 'quote-1',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.5,
        document_type: 'quote',
      })
      const proforma = makeInvoice({
        id: 'proforma-1',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.5,
        document_type: 'proforma',
      })

      const supabase = createMockSupabase({ invoices: [invoice, quote, proforma] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await getOpenForeignCurrencyReceivables(supabase as any, 'company-1')

      expect(result.map((i) => i.id)).toEqual(['inv-1'])
    })

    it('includes partially_paid invoices: the unpaid remainder is still an open FX item', async () => {
      // payment-sync.ts moves a customer invoice to 'partially_paid' on a
      // partial settlement. Omitting the status made these receivables
      // entirely invisible to the balansdagen revaluation (ÅRL 4 kap. 13 §);
      // the payables side has always included it.
      const partialEur = makeInvoice({
        status: 'partially_paid',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        paid_amount: 400,
        remaining_amount: 600,
      })

      const supabase = createMockSupabase({ invoices: [partialEur] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await getOpenForeignCurrencyReceivables(supabase as any, 'company-1')

      expect(result).toHaveLength(1)
      expect(result[0].status).toBe('partially_paid')
    })

    // INVERTED (was: 'excludes invoices without exchange_rate'). The SQL
    // `.not('exchange_rate','is',null)` filter meant the invoices with the
    // largest unmeasured FX exposure never reached the caller and were never
    // reported. The fetcher now returns them; previewCurrencyRevaluation
    // partitions and counts them (see 'reports unconverted rows' below).
    it('returns invoices without exchange_rate so the caller can report them', async () => {
      const noRateInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: null,
        total: 1000,
      })

      const supabase = createMockSupabase({ invoices: [noRateInvoice] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await getOpenForeignCurrencyReceivables(supabase as any, 'company-1')

      expect(result).toHaveLength(1)
      expect(result[0].exchange_rate).toBeNull()
    })
  })

  describe('getOpenForeignCurrencyPayables', () => {
    it('returns non-SEK supplier invoices with open status', async () => {
      const eurSI = makeSupplierInvoice({
        status: 'registered',
        currency: 'EUR',
        exchange_rate: 11.5,
        remaining_amount: 5000,
      })
      const sekSI = makeSupplierInvoice({
        status: 'registered',
        currency: 'SEK',
        remaining_amount: 3000,
      })

      const supabase = createMockSupabase({ supplierInvoices: [eurSI, sekSI] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await getOpenForeignCurrencyPayables(supabase as any, 'company-1')

      expect(result).toHaveLength(1)
      expect(result[0].currency).toBe('EUR')
    })

    it('includes partially_paid supplier invoices', async () => {
      const partialSI = makeSupplierInvoice({
        status: 'partially_paid',
        currency: 'USD',
        exchange_rate: 10.5,
        remaining_amount: 2000,
      })

      const supabase = createMockSupabase({ supplierInvoices: [partialSI] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await getOpenForeignCurrencyPayables(supabase as any, 'company-1')

      expect(result).toHaveLength(1)
      expect(result[0].remaining_amount).toBe(2000)
    })

    it('excludes paid supplier invoices', async () => {
      const paidSI = makeSupplierInvoice({
        status: 'paid',
        currency: 'EUR',
        exchange_rate: 11.5,
      })

      const supabase = createMockSupabase({ supplierInvoices: [paidSI] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await getOpenForeignCurrencyPayables(supabase as any, 'company-1')

      expect(result).toHaveLength(0)
    })
  })

  describe('previewCurrencyRevaluation', () => {
    it('returns empty preview when no foreign currency items', async () => {
      const supabase = createMockSupabase({
        invoices: [],
        supplierInvoices: [],
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      expect(preview.items).toHaveLength(0)
      expect(preview.lines).toHaveLength(0)
      expect(preview.netEffect).toBe(0)
    })

    it('computes receivable gain (closing rate > original rate)', async () => {
      const eurInvoice = makeInvoice({
        id: 'inv-1',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_number: 'F-001',
      })

      mockRates({ EUR: 11.5 })

      const supabase = createMockSupabase({ invoices: [eurInvoice] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      expect(preview.items).toHaveLength(1)
      expect(preview.items[0].type).toBe('receivable')
      expect(preview.items[0].difference_sek).toBe(500) // 1000 * (11.5 - 11.0)

      // Should debit 1510 (receivable up), credit 3960 (gain)
      const debit1510 = preview.lines.find(l => l.account_number === '1510' && l.debit_amount > 0)
      const credit3960 = preview.lines.find(l => l.account_number === '3960' && l.credit_amount > 0)
      expect(debit1510).toBeDefined()
      expect(debit1510!.debit_amount).toBe(500)
      expect(credit3960).toBeDefined()
      expect(credit3960!.credit_amount).toBe(500)

      expect(preview.totalGain).toBe(500)
      expect(preview.totalLoss).toBe(0)
      expect(preview.netEffect).toBe(500)
    })

    it('computes receivable loss (closing rate < original rate)', async () => {
      const eurInvoice = makeInvoice({
        id: 'inv-2',
        status: 'overdue',
        currency: 'EUR',
        exchange_rate: 12.0,
        total: 1000,
        invoice_number: 'F-002',
      })

      mockRates({ EUR: 11.5 })

      const supabase = createMockSupabase({ invoices: [eurInvoice] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      expect(preview.items[0].difference_sek).toBe(-500) // 1000 * (11.5 - 12.0)

      // Should credit 1510 (receivable down), debit 7960 (loss)
      const credit1510 = preview.lines.find(l => l.account_number === '1510' && l.credit_amount > 0)
      const debit7960 = preview.lines.find(l => l.account_number === '7960' && l.debit_amount > 0)
      expect(credit1510).toBeDefined()
      expect(credit1510!.credit_amount).toBe(500)
      expect(debit7960).toBeDefined()
      expect(debit7960!.debit_amount).toBe(500)

      expect(preview.totalLoss).toBe(500)
      expect(preview.totalGain).toBe(0)
      expect(preview.netEffect).toBe(-500)
    })

    it('computes payable loss (closing rate > original rate: liability grew)', async () => {
      const eurSI = makeSupplierInvoice({
        id: 'si-1',
        status: 'registered',
        currency: 'EUR',
        exchange_rate: 11.0,
        remaining_amount: 2000,
        supplier_invoice_number: 'LF-001',
      })

      mockRates({ EUR: 11.5 })

      const supabase = createMockSupabase({ supplierInvoices: [eurSI] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      expect(preview.items[0].type).toBe('payable')
      expect(preview.items[0].difference_sek).toBe(1000) // 2000 * (11.5 - 11.0)

      // Should debit 7960 (loss), credit 2440 (liability up)
      const debit7960 = preview.lines.find(l => l.account_number === '7960' && l.debit_amount > 0)
      const credit2440 = preview.lines.find(l => l.account_number === '2440' && l.credit_amount > 0)
      expect(debit7960).toBeDefined()
      expect(debit7960!.debit_amount).toBe(1000)
      expect(credit2440).toBeDefined()
      expect(credit2440!.credit_amount).toBe(1000)
    })

    it('computes payable gain (closing rate < original rate: liability shrank)', async () => {
      const eurSI = makeSupplierInvoice({
        id: 'si-2',
        status: 'approved',
        currency: 'EUR',
        exchange_rate: 12.0,
        remaining_amount: 2000,
        supplier_invoice_number: 'LF-002',
      })

      mockRates({ EUR: 11.5 })

      const supabase = createMockSupabase({ supplierInvoices: [eurSI] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      expect(preview.items[0].difference_sek).toBe(-1000) // 2000 * (11.5 - 12.0)

      // Should debit 2440 (liability down), credit 3960 (gain)
      const debit2440 = preview.lines.find(l => l.account_number === '2440' && l.debit_amount > 0)
      const credit3960 = preview.lines.find(l => l.account_number === '3960' && l.credit_amount > 0)
      expect(debit2440).toBeDefined()
      expect(debit2440!.debit_amount).toBe(1000)
      expect(credit3960).toBeDefined()
      expect(credit3960!.credit_amount).toBe(1000)
    })

    it('handles mixed currencies correctly', async () => {
      const eurInvoice = makeInvoice({
        id: 'inv-eur',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_number: 'F-EUR',
      })
      const usdInvoice = makeInvoice({
        id: 'inv-usd',
        status: 'sent',
        currency: 'USD',
        exchange_rate: 10.0,
        total: 500,
        invoice_number: 'F-USD',
      })

      mockRates({ EUR: 11.5, USD: 10.5 })

      const supabase = createMockSupabase({ invoices: [eurInvoice, usdInvoice] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      expect(preview.items).toHaveLength(2)
      // EUR: 1000 * (11.5 - 11.0) = 500
      // USD: 500 * (10.5 - 10.0) = 250
      expect(preview.totalGain).toBe(750)
    })

    it('aggregates journal lines correctly with mixed gains and losses', async () => {
      const gainInvoice = makeInvoice({
        id: 'inv-gain',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_number: 'F-GAIN',
      })
      const lossSI = makeSupplierInvoice({
        id: 'si-loss',
        status: 'registered',
        currency: 'EUR',
        exchange_rate: 11.0,
        remaining_amount: 2000,
        supplier_invoice_number: 'LF-LOSS',
      })

      // EUR went up to 11.5
      mockRates({ EUR: 11.5 })

      const supabase = createMockSupabase({
        invoices: [gainInvoice],
        supplierInvoices: [lossSI],
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      // Receivable gain: 1000 * 0.5 = 500 → Debit 1510, Credit 3960
      // Payable loss: 2000 * 0.5 = 1000 → Debit 7960, Credit 2440
      expect(preview.totalGain).toBe(500)
      expect(preview.totalLoss).toBe(1000)
      expect(preview.netEffect).toBe(-500)

      // Verify all entries balance
      const totalDebit = preview.lines.reduce((sum, l) => sum + l.debit_amount, 0)
      const totalCredit = preview.lines.reduce((sum, l) => sum + l.credit_amount, 0)
      expect(Math.round(totalDebit * 100) / 100).toBe(Math.round(totalCredit * 100) / 100)
    })

    it('uses remaining_amount for partially paid supplier invoices', async () => {
      const partialSI = makeSupplierInvoice({
        id: 'si-partial',
        status: 'partially_paid',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 10000,
        remaining_amount: 5000, // Half paid
        supplier_invoice_number: 'LF-PARTIAL',
      })

      mockRates({ EUR: 11.5 })

      const supabase = createMockSupabase({ supplierInvoices: [partialSI] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      // Only remaining 5000 EUR is revalued, not full 10000
      expect(preview.items[0].amount_in_currency).toBe(5000)
      expect(preview.items[0].difference_sek).toBe(2500) // 5000 * (11.5 - 11.0)
    })

    it('revalues only the outstanding amount of a partially paid receivable', async () => {
      // Hand-computed: 1 000 EUR invoiced at 11,00 (11 000 kr on 1510),
      // 400 EUR since paid. Outstanding = 600 EUR. Closing 11,50:
      //   originalSek = 600 * 11,00 = 6 600,00
      //   closingSek  = 600 * 11,50 = 6 900,00
      //   unrealized gain = 300,00 kr (NOT 500,00 from the 1 000 EUR face value)
      const partialEur = makeInvoice({
        id: 'inv-partial',
        status: 'partially_paid',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        paid_amount: 400,
        remaining_amount: 600,
        invoice_number: 'F-PARTIAL',
      })

      mockRates({ EUR: 11.5 })

      const supabase = createMockSupabase({ invoices: [partialEur] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      expect(preview.items).toHaveLength(1)
      expect(preview.items[0].amount_in_currency).toBe(600)
      expect(preview.items[0].original_sek).toBe(6600)
      expect(preview.items[0].closing_sek).toBe(6900)
      expect(preview.items[0].difference_sek).toBe(300)

      const debit1510 = preview.lines.find(l => l.account_number === '1510' && l.debit_amount > 0)
      const credit3960 = preview.lines.find(l => l.account_number === '3960' && l.credit_amount > 0)
      expect(debit1510!.debit_amount).toBe(300)
      expect(credit3960!.credit_amount).toBe(300)

      // Balanced to the öre.
      const totalDebit = preview.lines.reduce((sum, l) => sum + l.debit_amount, 0)
      const totalCredit = preview.lines.reduce((sum, l) => sum + l.credit_amount, 0)
      expect(Math.round(totalDebit * 100)).toBe(Math.round(totalCredit * 100))
    })

    it('skips a receivable with nothing outstanding instead of revaluing its face value', async () => {
      // Edge: status still open but paid_amount covers the total (e.g. the
      // status update lagged the payment sync). There is no monetary item
      // left to value and nothing to report as unconverted either.
      const settledEur = makeInvoice({
        id: 'inv-settled',
        status: 'partially_paid',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        paid_amount: 1000,
        remaining_amount: 0,
      })

      mockRates({ EUR: 11.5 })

      const supabase = createMockSupabase({ invoices: [settledEur] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      expect(preview.items).toHaveLength(0)
      expect(preview.lines).toHaveLength(0)
      expect(preview.unconvertedFxCount).toBe(0)
      expect(mockedFetchRate).not.toHaveBeenCalled()
    })

    it('reports the outstanding amount (not face value) for an unrated partially paid receivable', async () => {
      const unratedPartial = makeInvoice({
        id: 'inv-unrated-partial',
        status: 'partially_paid',
        currency: 'USD',
        exchange_rate: null,
        total: 4000,
        paid_amount: 1500,
        remaining_amount: 2500,
        invoice_number: 'F-UNRATED-PARTIAL',
      })

      mockRates({})

      const supabase = createMockSupabase({ invoices: [unratedPartial] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      expect(preview.unconvertedFxCount).toBe(1)
      expect(preview.unconvertedFx[0]).toMatchObject({
        source_id: 'inv-unrated-partial',
        type: 'receivable',
        currency: 'USD',
        amount_in_currency: 2500,
      })
    })

    it('skips items with zero difference', async () => {
      const eurInvoice = makeInvoice({
        id: 'inv-same',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.5,
        total: 1000,
        invoice_number: 'F-SAME',
      })

      // Closing rate equals original rate
      mockRates({ EUR: 11.5 })

      const supabase = createMockSupabase({ invoices: [eurInvoice] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      expect(preview.items).toHaveLength(0)
      expect(preview.lines).toHaveLength(0)
    })

    it('reports rows with no exchange_rate as unconverted instead of dropping them', async () => {
      const ratedInvoice = makeInvoice({
        id: 'inv-rated',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_number: 'F-RATED',
      })
      const unratedInvoice = makeInvoice({
        id: 'inv-unrated',
        status: 'sent',
        currency: 'USD',
        exchange_rate: null,
        total: 4000,
        invoice_number: 'F-UNRATED',
      })
      const unratedSI = makeSupplierInvoice({
        id: 'si-unrated',
        status: 'registered',
        currency: 'GBP',
        exchange_rate: null,
        remaining_amount: 700,
        supplier_invoice_number: 'LF-UNRATED',
      })

      mockRates({ EUR: 11.5 })

      const supabase = createMockSupabase({
        invoices: [ratedInvoice, unratedInvoice],
        supplierInvoices: [unratedSI],
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      // Only the rated invoice is revalued.
      expect(preview.items).toHaveLength(1)
      expect(preview.items[0].source_id).toBe('inv-rated')

      // The other two are surfaced, not silently swallowed.
      expect(preview.unconvertedFxCount).toBe(2)
      expect(preview.unconvertedFx.map((u) => u.source_id).sort()).toEqual([
        'inv-unrated',
        'si-unrated',
      ])
      expect(preview.unconvertedFx.find((u) => u.source_id === 'inv-unrated')).toMatchObject({
        type: 'receivable',
        currency: 'USD',
        reference: 'F-UNRATED',
        amount_in_currency: 4000,
      })
      expect(preview.unconvertedFx.find((u) => u.source_id === 'si-unrated')).toMatchObject({
        type: 'payable',
        currency: 'GBP',
        reference: 'LF-UNRATED',
        amount_in_currency: 700,
      })

      // No rate was ever requested for a currency we cannot revalue anyway.
      expect(mockedFetchRate).toHaveBeenCalledTimes(1)
      expect(mockedFetchRate.mock.calls[0][0]).toBe('EUR')
      // Looked up for the closing date (not "today") and through the shared
      // exchange_rates cache, so the balansdagen rate stays reproducible.
      expect(mockedFetchRate.mock.calls[0][1]).toEqual(new Date('2024-12-31'))
      expect(mockedFetchRate.mock.calls[0][2]).toBe(supabase)
    })

    it('treats a zero exchange_rate as unconverted instead of valuing the row at 0 SEK', async () => {
      const zeroRateInvoice = makeInvoice({
        id: 'inv-zero',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 0,
        total: 1000,
        invoice_number: 'F-ZERO',
      })

      mockRates({ EUR: 11.5 })

      const supabase = createMockSupabase({ invoices: [zeroRateInvoice] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      // A 0 original rate makes originalSek 0, so the whole 11 500 SEK would
      // read as an orealiserad kursvinst on 3960. Same > 0 rule the reskontra
      // reports use for unconverted_fx_count.
      expect(preview.items).toHaveLength(0)
      expect(preview.lines).toHaveLength(0)
      expect(preview.unconvertedFxCount).toBe(1)
      expect(preview.unconvertedFx[0].source_id).toBe('inv-zero')
      expect(mockedFetchRate).not.toHaveBeenCalled()
    })

    it('reports a missing closing rate instead of substituting a fallback constant', async () => {
      const eurInvoice = makeInvoice({
        id: 'inv-norate',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_number: 'F-NORATE',
      })

      // Riksbanken unreachable and cache empty: fetchExchangeRate resolves null.
      mockRates({})

      const supabase = createMockSupabase({ invoices: [eurInvoice] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      expect(preview.missingClosingRates).toEqual([{ currency: 'EUR', date: '2024-12-31' }])
      // Nothing is valued off a guessed rate: no items, no lines, no 11.5.
      expect(preview.items).toHaveLength(0)
      expect(preview.lines).toHaveLength(0)
      expect(preview.closingRates).toEqual({})
    })

    it('all generated journal lines balance (debits === credits)', async () => {
      const eurInvoice = makeInvoice({
        id: 'inv-bal',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1234.56,
        invoice_number: 'F-BAL',
      })
      const gbpSI = makeSupplierInvoice({
        id: 'si-bal',
        status: 'overdue',
        currency: 'GBP',
        exchange_rate: 14.0,
        remaining_amount: 789.12,
        supplier_invoice_number: 'LF-BAL',
      })

      mockRates({ EUR: 11.8, GBP: 13.5 })

      const supabase = createMockSupabase({
        invoices: [eurInvoice],
        supplierInvoices: [gbpSI],
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      const totalDebit = preview.lines.reduce((sum, l) => sum + l.debit_amount, 0)
      const totalCredit = preview.lines.reduce((sum, l) => sum + l.credit_amount, 0)
      expect(Math.round(totalDebit * 100)).toBe(Math.round(totalCredit * 100))
    })
  })

  describe('executeCurrencyRevaluation', () => {
    it('returns null when no foreign currency items exist', async () => {
      const supabase = createFullMockSupabase({
        invoices: [],
        supplierInvoices: [],
        existingRevaluation: false,
      })

      mockRates({})

      const result = await executeCurrencyRevaluation(supabase, 'company-1', '2024-12-31', 'period-1')

      expect(result).toBeNull()
      expect(mockedCreateEntry).not.toHaveBeenCalled()
    })

    it('creates journal entry with correct source_type', async () => {
      const eurInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_number: 'F-001',
      })

      mockRates({ EUR: 11.5 })

      const supabase = createFullMockSupabase({
        invoices: [eurInvoice],
        existingRevaluation: false,
      })

      const result = await executeCurrencyRevaluation(supabase, 'company-1', '2024-12-31', 'period-1')

      expect(result).not.toBeNull()
      expect(mockedCreateEntry).toHaveBeenCalledOnce()

      const callArgs = mockedCreateEntry.mock.calls[0]
      expect(callArgs[3].source_type).toBe('currency_revaluation')
      expect(callArgs[3].fiscal_period_id).toBe('period-1')
      expect(callArgs[3].entry_date).toBe('2024-12-31')
      expect(callArgs[3].description).toContain('Omvärdering utländsk valuta')
    })

    it('throws when revaluation already exists for period (idempotency)', async () => {
      const supabase = createFullMockSupabase({
        existingRevaluation: true,
      })

      await expect(
        executeCurrencyRevaluation(supabase, 'company-1', '2024-12-31', 'period-1')
      ).rejects.toThrow('Currency revaluation already exists for this period')

      expect(mockedCreateEntry).not.toHaveBeenCalled()
    })

    it('books the receivable gain to 1510 / 3960 with a real Riksbanken rate', async () => {
      const eurInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_number: 'F-001',
      })
      const gbpSI = makeSupplierInvoice({
        status: 'registered',
        currency: 'GBP',
        exchange_rate: 14.0,
        remaining_amount: 500,
        supplier_invoice_number: 'LF-001',
      })

      // EUR up (receivable gain), GBP down (payable gain).
      mockRates({ EUR: 11.5, GBP: 13.5 })

      const supabase = createFullMockSupabase({
        invoices: [eurInvoice],
        supplierInvoices: [gbpSI],
        existingRevaluation: false,
      })

      await executeCurrencyRevaluation(supabase, 'company-1', '2024-12-31', 'period-1')

      const lines = mockedCreateEntry.mock.calls[0][3].lines
      const find = (account: string, side: 'debit_amount' | 'credit_amount') =>
        lines.find((l) => l.account_number === account && l[side] > 0)

      // Receivable revalued up 1000 * 0.5 = 500 → Dr 1510 / Cr 3960
      expect(find('1510', 'debit_amount')!.debit_amount).toBe(500)
      // Payable shrank 500 * 0.5 = 250 → Dr 2440 / Cr 3960
      expect(find('2440', 'debit_amount')!.debit_amount).toBe(250)
      expect(find('3960', 'credit_amount')!.credit_amount).toBe(750)
      expect(find('7960', 'debit_amount')).toBeUndefined()

      const totalDebit = lines.reduce((s, l) => s + l.debit_amount, 0)
      const totalCredit = lines.reduce((s, l) => s + l.credit_amount, 0)
      expect(Math.round(totalDebit * 100) / 100).toBe(Math.round(totalCredit * 100) / 100)
      expect(totalDebit).toBeGreaterThan(0)
    })

    it('refuses to post when the closing rate is unavailable', async () => {
      const eurInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_number: 'F-001',
      })

      // No rate at all. Before the fix, fetchMultipleRates padded its Map with
      // the display-only fallback (EUR 11.5) and this posted a real 3960/7960
      // verifikat computed from a hardcoded constant.
      mockRates({})

      const supabase = createFullMockSupabase({
        invoices: [eurInvoice],
        existingRevaluation: false,
      })

      await expect(
        executeCurrencyRevaluation(supabase, 'company-1', '2024-12-31', 'period-1')
      ).rejects.toMatchObject({
        code: 'FX_CLOSING_RATE_UNAVAILABLE',
        missingRates: [{ currency: 'EUR', date: '2024-12-31' }],
      })

      expect(mockedCreateEntry).not.toHaveBeenCalled()
    })

    it('translates the refusal into a Swedish message naming currency and date', async () => {
      const eurInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_number: 'F-001',
      })

      mockRates({})

      const supabase = createFullMockSupabase({
        invoices: [eurInvoice],
        existingRevaluation: false,
      })

      const err = await executeCurrencyRevaluation(
        supabase, 'company-1', '2024-12-31', 'period-1'
      ).catch((e: unknown) => e)

      const message = getErrorMessage(err)
      expect(message).toContain('EUR per 2024-12-31')
      expect(message).toContain('har inte bokförts')
      // Never leak the raw English engine message into a Swedish UI.
      expect(message).not.toContain('Riksbanken exchange rate available')
    })

    it('refuses a partial valuation when only some currencies have a rate', async () => {
      const eurInvoice = makeInvoice({
        id: 'inv-eur',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_number: 'F-EUR',
      })
      const usdInvoice = makeInvoice({
        id: 'inv-usd',
        status: 'sent',
        currency: 'USD',
        exchange_rate: 10.0,
        total: 500,
        invoice_number: 'F-USD',
      })

      mockRates({ EUR: 11.5 })

      const supabase = createFullMockSupabase({
        invoices: [eurInvoice, usdInvoice],
        existingRevaluation: false,
      })

      await expect(
        executeCurrencyRevaluation(supabase, 'company-1', '2024-12-31', 'period-1')
      ).rejects.toMatchObject({
        code: 'FX_CLOSING_RATE_UNAVAILABLE',
        missingRates: [{ currency: 'USD', date: '2024-12-31' }],
      })

      expect(mockedCreateEntry).not.toHaveBeenCalled()
    })

    it('surfaces unconverted rows on the result so the caller can warn', async () => {
      const ratedInvoice = makeInvoice({
        id: 'inv-rated',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_number: 'F-RATED',
      })
      const unratedInvoice = makeInvoice({
        id: 'inv-unrated',
        status: 'sent',
        currency: 'EUR',
        exchange_rate: null,
        total: 9000,
        invoice_number: 'F-UNRATED',
      })

      mockRates({ EUR: 11.5 })

      const supabase = createFullMockSupabase({
        invoices: [ratedInvoice, unratedInvoice],
        existingRevaluation: false,
      })

      const result = await executeCurrencyRevaluation(
        supabase, 'company-1', '2024-12-31', 'period-1'
      )

      expect(result).not.toBeNull()
      expect(result!.preview.unconvertedFxCount).toBe(1)
      expect(result!.preview.unconvertedFx[0].source_id).toBe('inv-unrated')
    })

    it('returns entry and preview in result', async () => {
      const eurInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_number: 'F-001',
      })

      mockRates({ EUR: 12.0 })

      const supabase = createFullMockSupabase({
        invoices: [eurInvoice],
        existingRevaluation: false,
      })

      const result = await executeCurrencyRevaluation(supabase, 'company-1', '2024-12-31', 'period-1')

      expect(result).not.toBeNull()
      expect(result!.entry).toBeDefined()
      expect(result!.preview).toBeDefined()
      expect(result!.preview.items).toHaveLength(1)
      expect(result!.preview.totalGain).toBe(1000) // 1000 * (12 - 11)
    })
  })

  // Regression: a year-end close revalued FX invoices that were NOT on the
  // balance sheet on balansdagen (issued later, settled earlier, or never
  // booked at all), writing down a 1510 that stood at zero. The population
  // must be measured AS OF the closing date, gated by the company's booking
  // mode, exactly like countOpenFxItemsAtBalansdagen in year-end-service.
  describe('as-of balansdagen population', () => {
    it('excludes an invoice issued after balansdagen', async () => {
      const laterInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_date: '2025-03-10',
      })

      mockRates({ EUR: 12.0 })
      const supabase = createMockSupabase({ invoices: [laterInvoice] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      expect(preview.items).toHaveLength(0)
      expect(preview.lines).toHaveLength(0)
      expect(preview.unconvertedFxCount).toBe(0)
    })

    it('includes an invoice settled after balansdagen at its as-of outstanding', async () => {
      // Paid in full in February 2025: on 2024-12-31 the whole amount was
      // still an open monetary item and must be valued (ÅRL 4 kap. 13 §).
      const settledLater = makeInvoice({
        id: 'inv-settled-later',
        status: 'paid',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        paid_amount: 1000,
        remaining_amount: 0,
        paid_at: '2025-02-01',
        invoice_date: '2024-11-15',
      })

      mockRates({ EUR: 12.0 })
      const supabase = createMockSupabase({
        invoices: [settledLater],
        invoicePayments: [
          {
            company_id: 'company-1',
            invoice_id: 'inv-settled-later',
            amount: 1000,
            payment_date: '2025-02-01',
          },
        ],
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      expect(preview.items).toHaveLength(1)
      expect(preview.items[0].amount_in_currency).toBe(1000)
      expect(preview.totalGain).toBe(1000) // 1000 * (12 - 11)
    })

    it('excludes the part of an invoice that was already paid on balansdagen', async () => {
      const partiallySettled = makeInvoice({
        id: 'inv-partial-asof',
        status: 'paid',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        paid_amount: 1000,
        remaining_amount: 0,
        paid_at: '2025-01-20',
        invoice_date: '2024-11-15',
      })

      mockRates({ EUR: 12.0 })
      const supabase = createMockSupabase({
        invoices: [partiallySettled],
        invoicePayments: [
          // 600 paid before balansdagen, 400 after: only 400 was open.
          {
            company_id: 'company-1',
            invoice_id: 'inv-partial-asof',
            amount: 600,
            payment_date: '2024-12-10',
          },
          {
            company_id: 'company-1',
            invoice_id: 'inv-partial-asof',
            amount: 400,
            payment_date: '2025-01-20',
          },
        ],
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      expect(preview.items).toHaveLength(1)
      expect(preview.items[0].amount_in_currency).toBe(400)
      expect(preview.totalGain).toBe(400) // 400 * (12 - 11)
    })

    it('excludes an unbooked row for a kontantmetoden company', async () => {
      // A registered-but-unbooked invoice is not on 1510, so revaluing it
      // fabricated a write-down of an account that stood at zero.
      const eurInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_date: '2024-11-15',
        journal_entry_id: null,
      })

      mockRates({ EUR: 12.0 })
      const supabase = createMockSupabase({
        invoices: [eurInvoice],
        settings: { company_id: 'company-1', accounting_method: 'cash' },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      expect(preview.items).toHaveLength(0)
      expect(preview.lines).toHaveLength(0)
    })

    it('still revalues a kontantmetoden company row booked at balansdagen', async () => {
      // BFL 5 kap 2 § 3 st: kontantmetoden companies must book their
      // outstanding fordringar/skulder at year-end. Those converted rows ARE
      // on 1510 and must be valued at balansdagskurs (ÅRL 4 kap. 13 §), so
      // gating on accounting_method rather than on the row would drop them.
      const bookedEur = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_date: '2024-11-15',
        journal_entry_id: 'je-yearend-conversion',
      })

      mockRates({ EUR: 12.0 })
      const supabase = createMockSupabase({
        invoices: [bookedEur],
        settings: { company_id: 'company-1', accounting_method: 'cash' },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      expect(preview.items).toHaveLength(1)
      expect(preview.totalGain).toBe(1000) // 1000 * (12 - 11)
    })

    it('excludes a post-dated invoice even when balansdagen is not historical', async () => {
      // The date ceiling is unconditional: an invoice issued after the
      // balансdagen is not on the balance sheet being valued, whether or not
      // that date happens to be in the past.
      const future = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10)
      const postDated = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
      const beforeToday = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)

      const openNow = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_date: beforeToday,
      })
      const laterInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 500,
        invoice_date: future,
      })

      mockRates({ EUR: 12.0 })
      const supabase = createMockSupabase({ invoices: [openNow, laterInvoice] })
      // Balansdagen between the two invoice dates, still in the future.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', postDated)

      expect(preview.items).toHaveLength(1)
      expect(preview.items[0].amount_in_currency).toBe(1000)
    })

    it('values a still-open invoice at what it owed on balansdagen', async () => {
      // The common straddling case: the row is 'partially_paid' today, so the
      // OLD status list already fetched it, but its live paid_amount reflects
      // payments made after balansdagen.
      const straddling = makeInvoice({
        id: 'inv-straddle',
        status: 'partially_paid',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        paid_amount: 900,
        remaining_amount: 100,
        invoice_date: '2024-10-01',
      })

      mockRates({ EUR: 12.0 })
      const supabase = createMockSupabase({
        invoices: [straddling],
        invoicePayments: [
          { company_id: 'company-1', invoice_id: 'inv-straddle', amount: 300, payment_date: '2024-11-05' },
          { company_id: 'company-1', invoice_id: 'inv-straddle', amount: 600, payment_date: '2025-02-11' },
        ],
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      // 700 was open on balansdagen, not the live 100.
      expect(preview.items).toHaveLength(1)
      expect(preview.items[0].amount_in_currency).toBe(700)
      expect(preview.totalGain).toBe(700)
    })

    it('applies the same as-of reconstruction to payables', async () => {
      const straddlingPayable = makeSupplierInvoice({
        id: 'si-straddle',
        status: 'partially_paid',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 2000,
        remaining_amount: 200,
        invoice_date: '2024-10-01',
      })

      mockRates({ EUR: 12.0 })
      const supabase = createMockSupabase({
        supplierInvoices: [straddlingPayable],
        supplierInvoicePayments: [
          { company_id: 'company-1', supplier_invoice_id: 'si-straddle', amount: 500, payment_date: '2024-12-01' },
          { company_id: 'company-1', supplier_invoice_id: 'si-straddle', amount: 1300, payment_date: '2025-03-04' },
        ],
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      // 1500 was owed on balansdagen; a rising rate is a LOSS on a payable.
      expect(preview.items).toHaveLength(1)
      expect(preview.items[0].amount_in_currency).toBe(1500)
      expect(preview.totalLoss).toBe(1500)
      expect(preview.totalGain).toBe(0)
    })

    it('excludes an unbooked payable under deferred booking', async () => {
      const bookedSi = makeSupplierInvoice({
        status: 'registered',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        remaining_amount: 1000,
        invoice_date: '2024-11-01',
        registration_journal_entry_id: 'je-si-1',
      })
      const unbookedSi = makeSupplierInvoice({
        status: 'registered',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 400,
        remaining_amount: 400,
        invoice_date: '2024-11-02',
        registration_journal_entry_id: null,
      })

      mockRates({ EUR: 12.0 })
      const supabase = createMockSupabase({
        supplierInvoices: [bookedSi, unbookedSi],
        settings: {
          company_id: 'company-1',
          accounting_method: 'accrual',
          defer_invoice_booking: true,
        },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      expect(preview.items).toHaveLength(1)
      expect(preview.items[0].amount_in_currency).toBe(1000)
      expect(preview.totalLoss).toBe(1000)
    })

    it('renders a preview instead of throwing when settings cannot be read', async () => {
      // previewCurrencyRevaluation is the read-only surface: the year-end
      // preview must still render (same contract as the missing-rate path).
      const eurInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_date: '2024-11-15',
      })

      mockRates({ EUR: 12.0 })
      const supabase = createMockSupabase({ invoices: [eurInvoice] })
      const original = supabase.from
      supabase.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'company_settings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: null,
                  error: { message: 'connection reset' },
                }),
              }),
            }),
          }
        }
        return original(table)
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      expect(preview.items).toHaveLength(1)
      expect(preview.totalGain).toBe(1000)
    })

    it('under deferred booking only revalues rows whose registration is booked', async () => {
      const bookedInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_date: '2024-11-15',
        journal_entry_id: 'je-1',
      })
      const unbookedInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 500,
        invoice_date: '2024-11-20',
        journal_entry_id: null,
      })

      mockRates({ EUR: 12.0 })
      const supabase = createMockSupabase({
        invoices: [bookedInvoice, unbookedInvoice],
        settings: {
          company_id: 'company-1',
          accounting_method: 'accrual',
          defer_invoice_booking: true,
        },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      expect(preview.items).toHaveLength(1)
      expect(preview.items[0].amount_in_currency).toBe(1000)
      expect(preview.totalGain).toBe(1000) // only the booked 1000 EUR row
    })

    it('executeCurrencyRevaluation posts nothing when nothing was open on balansdagen', async () => {
      // The Oppy case end to end: only a post-balansdagen invoice exists, so
      // the year-end run must not create any verifikat at all.
      const laterInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_date: '2025-03-10',
      })

      mockRates({ EUR: 12.0 })
      const supabase = createFullMockSupabase({
        invoices: [laterInvoice],
        existingRevaluation: false,
      })

      const result = await executeCurrencyRevaluation(supabase, 'company-1', '2024-12-31', 'period-1')

      expect(result).toBeNull()
      expect(mockedCreateEntry).not.toHaveBeenCalled()
    })
  })
})
