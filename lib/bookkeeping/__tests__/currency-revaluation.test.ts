import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CreateJournalEntryInput, Currency } from '@/types'
import { makeInvoice, makeSupplierInvoice } from '@/tests/helpers'

// Mock riksbanken
vi.mock('@/lib/currency/riksbanken', () => ({
  fetchMultipleRates: vi.fn(),
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

const { fetchMultipleRates } = await import('@/lib/currency/riksbanken')
const mockedFetchRates = vi.mocked(fetchMultipleRates)

const { createJournalEntry } = await import('../engine')
const mockedCreateEntry = vi.mocked(createJournalEntry)

const {
  getOpenForeignCurrencyReceivables,
  getOpenForeignCurrencyPayables,
  previewCurrencyRevaluation,
  executeCurrencyRevaluation,
} = await import('../currency-revaluation')

// Helper to build mock supabase
function createMockSupabase(config: {
  invoices?: ReturnType<typeof makeInvoice>[]
  supplierInvoices?: ReturnType<typeof makeSupplierInvoice>[]
  existingRevaluation?: boolean
}) {
  const fromMap: Record<string, unknown[]> = {
    invoices: config.invoices || [],
    supplier_invoices: config.supplierInvoices || [],
  }

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
              // Terminal — return count
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

  // Paging stability order — no-op in the mock (data is already deterministic).
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
function createFullMockSupabase(config: {
  invoices?: ReturnType<typeof makeInvoice>[]
  supplierInvoices?: ReturnType<typeof makeSupplierInvoice>[]
  existingRevaluation?: boolean
}) {
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

      const fromMap: Record<string, unknown[]> = {
        invoices: config.invoices || [],
        supplier_invoices: config.supplierInvoices || [],
      }
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

    it('excludes invoices without exchange_rate', async () => {
      const noRateInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: null,
        total: 1000,
      })

      const supabase = createMockSupabase({ invoices: [noRateInvoice] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await getOpenForeignCurrencyReceivables(supabase as any, 'company-1')

      expect(result).toHaveLength(0)
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
    function mockRates(rates: Record<Currency, number>) {
      mockedFetchRates.mockResolvedValue(
        new Map(
          Object.entries(rates).map(([currency, rate]) => [
            currency as Currency,
            { currency: currency as Currency, rate, date: '2024-12-31' },
          ])
        )
      )
    }

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

      mockRates({ EUR: 11.5 } as Record<Currency, number>)

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

      mockRates({ EUR: 11.5 } as Record<Currency, number>)

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

    it('computes payable loss (closing rate > original rate — liability grew)', async () => {
      const eurSI = makeSupplierInvoice({
        id: 'si-1',
        status: 'registered',
        currency: 'EUR',
        exchange_rate: 11.0,
        remaining_amount: 2000,
        supplier_invoice_number: 'LF-001',
      })

      mockRates({ EUR: 11.5 } as Record<Currency, number>)

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

    it('computes payable gain (closing rate < original rate — liability shrank)', async () => {
      const eurSI = makeSupplierInvoice({
        id: 'si-2',
        status: 'approved',
        currency: 'EUR',
        exchange_rate: 12.0,
        remaining_amount: 2000,
        supplier_invoice_number: 'LF-002',
      })

      mockRates({ EUR: 11.5 } as Record<Currency, number>)

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

      mockRates({ EUR: 11.5, USD: 10.5 } as Record<Currency, number>)

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
      mockRates({ EUR: 11.5 } as Record<Currency, number>)

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

      mockRates({ EUR: 11.5 } as Record<Currency, number>)

      const supabase = createMockSupabase({ supplierInvoices: [partialSI] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      // Only remaining 5000 EUR is revalued, not full 10000
      expect(preview.items[0].amount_in_currency).toBe(5000)
      expect(preview.items[0].difference_sek).toBe(2500) // 5000 * (11.5 - 11.0)
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
      mockRates({ EUR: 11.5 } as Record<Currency, number>)

      const supabase = createMockSupabase({ invoices: [eurInvoice] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const preview = await previewCurrencyRevaluation(supabase as any, 'company-1', '2024-12-31')

      expect(preview.items).toHaveLength(0)
      expect(preview.lines).toHaveLength(0)
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

      mockRates({ EUR: 11.8, GBP: 13.5 } as Record<Currency, number>)

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
    function mockRates(rates: Record<Currency, number>) {
      mockedFetchRates.mockResolvedValue(
        new Map(
          Object.entries(rates).map(([currency, rate]) => [
            currency as Currency,
            { currency: currency as Currency, rate, date: '2024-12-31' },
          ])
        )
      )
    }

    it('returns null when no foreign currency items exist', async () => {
      const supabase = createFullMockSupabase({
        invoices: [],
        supplierInvoices: [],
        existingRevaluation: false,
      })

      mockRates({} as Record<Currency, number>)

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

      mockRates({ EUR: 11.5 } as Record<Currency, number>)

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

    it('returns entry and preview in result', async () => {
      const eurInvoice = makeInvoice({
        status: 'sent',
        currency: 'EUR',
        exchange_rate: 11.0,
        total: 1000,
        invoice_number: 'F-001',
      })

      mockRates({ EUR: 12.0 } as Record<Currency, number>)

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
})
