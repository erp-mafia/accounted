import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  amountsMatchExact,
  amountsMatchFuzzy,
  customerNameMatches,
  calculateMatchScore,
  findMatchingInvoices,
  findInvoiceMatchCandidates,
  getBestInvoiceMatch,
} from '../invoice-matching'
import type { Transaction, Invoice, Customer } from '@/types'
import {
  makeTransaction,
  makeInvoice,
  makeCustomer,
  createMockSupabase,
  createQueuedMockSupabase,
} from '@/tests/helpers'

// ============================================================
// amountsMatchExact
// ============================================================

describe('amountsMatchExact', () => {
  it('matches identical amounts', () => {
    expect(amountsMatchExact(1000, 1000)).toBe(true)
  })

  it('matches amounts differing only in floating-point noise', () => {
    // 1000.004 rounds to 1000.00, same as 1000.00
    expect(amountsMatchExact(1000.004, 1000)).toBe(true)
  })

  it('rejects amounts differing by 0.01', () => {
    expect(amountsMatchExact(1000.01, 1000)).toBe(false)
  })
})

// ============================================================
// amountsMatchFuzzy
// ============================================================

describe('amountsMatchFuzzy', () => {
  it('matches amounts within 1% tolerance', () => {
    // 990 vs 1000 → diff=10, tolerance=min(10,500)=10 → 10 <= 10
    expect(amountsMatchFuzzy(990, 1000)).toBe(true)
  })

  it('rejects amounts outside 1% tolerance', () => {
    // 980 vs 1000 → diff=20, tolerance=min(10,500)=10 → 20 > 10
    expect(amountsMatchFuzzy(980, 1000)).toBe(false)
  })

  it('returns false when invoiceTotal is 0', () => {
    expect(amountsMatchFuzzy(100, 0)).toBe(false)
  })

  it('caps tolerance at 500 SEK for large invoices', () => {
    // 100000 vs 100600 → diff=600, tolerance=min(100000*0.01=1000, 500)=500 → 600 > 500
    expect(amountsMatchFuzzy(100600, 100000)).toBe(false)
    // 100000 vs 100400 → diff=400, tolerance=500 → 400 <= 500
    expect(amountsMatchFuzzy(100400, 100000)).toBe(true)
  })
})

// ============================================================
// customerNameMatches
// ============================================================

describe('customerNameMatches', () => {
  it('matches when significant word from customer name appears in description', () => {
    expect(customerNameMatches('Kontorsbolaget AB', 'Betalning Kontorsbolaget', null)).toBe(true)
  })

  it('ignores words shorter than 3 characters', () => {
    // "AB" is 2 chars, filtered out
    expect(customerNameMatches('AB', 'AB payment', null)).toBe(false)
  })

  it('matches against merchant_name', () => {
    expect(customerNameMatches('Kontorsbolaget', 'Random description', 'Kontorsbolaget AB')).toBe(true)
  })

  it('returns false when customerName is undefined', () => {
    expect(customerNameMatches(undefined as unknown as string, 'Description', null)).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(customerNameMatches('KONTORSBOLAGET', 'betalning kontorsbolaget', null)).toBe(true)
  })
})

// ============================================================
// calculateMatchScore
// ============================================================

describe('calculateMatchScore', () => {
  function makeTx(overrides: Partial<Transaction> = {}): Transaction {
    return makeTransaction({ amount: 12500, description: 'Betalning Kundnamn AB', merchant_name: null, ...overrides })
  }

  function makeInv(overrides: Partial<Invoice & { customer?: Customer }> = {}): Invoice & { customer?: Customer } {
    return {
      ...makeInvoice({ total: 12500 }),
      customer: makeCustomer({ name: 'Kundnamn AB' }),
      ...overrides,
    }
  }

  it('returns 0.95 for exact amount + customer name match', () => {
    const { confidence } = calculateMatchScore(makeTx(), makeInv())
    expect(confidence).toBe(0.95)
  })

  it('returns 0.80 for exact amount without customer match', () => {
    const { confidence } = calculateMatchScore(
      makeTx({ description: 'Random payment', merchant_name: null }),
      makeInv({ customer: makeCustomer({ name: 'Completely Different Co' }) })
    )
    expect(confidence).toBe(0.80)
  })

  it('returns 0.70 for fuzzy amount + customer name match', () => {
    // 12375 is within 1% of 12500 (diff=125, tolerance=min(125,500)=125)
    const { confidence } = calculateMatchScore(
      makeTx({ amount: 12375 }),
      makeInv()
    )
    expect(confidence).toBe(0.70)
  })

  it('returns 0.50 for fuzzy amount without customer match', () => {
    const { confidence } = calculateMatchScore(
      makeTx({ amount: 12375, description: 'Random', merchant_name: null }),
      makeInv({ customer: makeCustomer({ name: 'Completely Different Co' }) })
    )
    expect(confidence).toBe(0.50)
  })

  it('returns 0 confidence when no amount match', () => {
    const { confidence } = calculateMatchScore(
      makeTx({ amount: 99999 }),
      makeInv()
    )
    expect(confidence).toBe(0)
  })
})

// ============================================================
// findMatchingInvoices (integration: mock Supabase)
// ============================================================

describe('findMatchingInvoices', () => {
  const { supabase, mockResult } = createMockSupabase()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty for expense transactions (amount <= 0)', async () => {
    const tx = makeTransaction({ amount: -1000 })
    const result = await findMatchingInvoices(supabase as never, 'company-1', tx)
    expect(result).toEqual([])
  })

  it('returns empty when Supabase query errors', async () => {
    mockResult({ data: null, error: { message: 'db error' } })
    const tx = makeTransaction({ amount: 12500 })
    const result = await findMatchingInvoices(supabase as never, 'company-1', tx)
    expect(result).toEqual([])
  })

  it('never proposes a quote or proforma: the candidate query is scoped to fakturor', async () => {
    const queued = createQueuedMockSupabase()
    queued.enqueue({ data: [], error: null })
    const tx = makeTransaction({ amount: 12500 })

    await findMatchingInvoices(queued.supabase as never, 'company-1', tx)

    expect(queued.findCalls('invoices', 'eq')).toContainEqual(['document_type', 'invoice'])
  })

  it('matches by OCR reference with confidence 0.99', async () => {
    const tx = makeTransaction({ amount: 12500, reference: 'F-2024001' })
    mockResult({
      data: [
        { ...makeInvoice({ invoice_number: 'F-2024001', total: 12500, status: 'sent', remaining_amount: 12500, currency: 'SEK' }) },
      ],
      error: null,
    })

    const result = await findMatchingInvoices(supabase as never, 'company-1', tx)
    expect(result).toHaveLength(1)
    expect(result[0].confidence).toBe(0.99)
    expect(result[0].matchReason).toContain('OCR-referens')
  })

  it('never suggests a credit note, even when its OCR reference matches', async () => {
    const tx = makeTransaction({ amount: 12500, reference: 'KR-F-2024001' })
    mockResult({
      data: [
        makeInvoice({
          invoice_number: 'KR-F-2024001',
          status: 'sent',
          total: -12500,
          credited_invoice_id: 'original-invoice-1',
        }),
      ],
      error: null,
    })

    const result = await findMatchingInvoices(supabase as never, 'company-1', tx)

    expect(result).toEqual([])
  })

  it('returns immediately on OCR match without further scoring', async () => {
    const tx = makeTransaction({ amount: 12500, reference: 'F-2024001' })
    mockResult({
      data: [
        { ...makeInvoice({ invoice_number: 'F-2024001', total: 12500, status: 'sent', remaining_amount: 12500, currency: 'SEK' }) },
        // Second invoice with exact amount: should not be scored
        {
          ...makeInvoice({ id: 'inv-2', invoice_number: 'F-2024002', total: 12500, status: 'sent', remaining_amount: 12500, currency: 'SEK' }),
          customer: makeCustomer({ name: 'Test match description' }),
        },
      ],
      error: null,
    })

    const result = await findMatchingInvoices(supabase as never, 'company-1', tx)
    // Only the OCR match should be returned
    expect(result).toHaveLength(1)
    expect(result[0].confidence).toBe(0.99)
  })

  it('scores exact amount + customer name at 0.95', async () => {
    const tx = makeTransaction({ amount: 12500, description: 'Betalning Testbolaget', reference: null })
    mockResult({
      data: [{
        ...makeInvoice({ total: 12500, status: 'sent', remaining_amount: 12500, currency: 'SEK' }),
        customer: makeCustomer({ name: 'Testbolaget AB' }),
      }],
      error: null,
    })

    const result = await findMatchingInvoices(supabase as never, 'company-1', tx)
    expect(result).toHaveLength(1)
    expect(result[0].confidence).toBe(0.95)
  })

  it('scores exact amount only at 0.80', async () => {
    const tx = makeTransaction({ amount: 12500, description: 'Unrelated text', merchant_name: null, reference: null })
    mockResult({
      data: [{
        ...makeInvoice({ total: 12500, status: 'sent', remaining_amount: 12500, currency: 'SEK' }),
        customer: makeCustomer({ name: 'Completely Different Name' }),
      }],
      error: null,
    })

    const result = await findMatchingInvoices(supabase as never, 'company-1', tx)
    expect(result).toHaveLength(1)
    expect(result[0].confidence).toBe(0.80)
  })

  it('sorts matches by confidence descending', async () => {
    const tx = makeTransaction({ amount: 12500, description: 'Betalning Testbolaget', merchant_name: null, reference: null })
    mockResult({
      data: [
        // Exact amount, no name match → 0.80
        {
          ...makeInvoice({ id: 'inv-low', total: 12500, status: 'sent', remaining_amount: 12500, currency: 'SEK' }),
          customer: makeCustomer({ name: 'Nope Corp' }),
        },
        // Exact amount + name match → 0.95
        {
          ...makeInvoice({ id: 'inv-high', total: 12500, status: 'sent', remaining_amount: 12500, currency: 'SEK' }),
          customer: makeCustomer({ name: 'Testbolaget AB' }),
        },
      ],
      error: null,
    })

    const result = await findMatchingInvoices(supabase as never, 'company-1', tx)
    expect(result).toHaveLength(2)
    expect(result[0].confidence).toBe(0.95)
    expect(result[1].confidence).toBe(0.80)
  })

  it('filters out matches below 0.50 threshold', async () => {
    const tx = makeTransaction({ amount: 99999, description: 'No match', merchant_name: null, reference: null })
    mockResult({
      data: [{
        ...makeInvoice({ total: 50000, status: 'sent', remaining_amount: 50000, currency: 'SEK' }),
        customer: makeCustomer({ name: 'Irrelevant' }),
      }],
      error: null,
    })

    const result = await findMatchingInvoices(supabase as never, 'company-1', tx)
    expect(result).toEqual([])
  })

  it('uses remaining_amount for partially_paid invoices', async () => {
    const tx = makeTransaction({ amount: 5000, description: 'Unrelated', merchant_name: null, reference: null })
    mockResult({
      data: [{
        ...makeInvoice({ total: 12500, remaining_amount: 5000, status: 'partially_paid', currency: 'SEK' }),
        customer: makeCustomer({ name: 'Different' }),
      }],
      error: null,
    })

    const result = await findMatchingInvoices(supabase as never, 'company-1', tx)
    expect(result).toHaveLength(1)
    expect(result[0].confidence).toBe(0.80) // exact amount match
  })

  it('skips invoices with non-matching currency', async () => {
    const tx = makeTransaction({ amount: 12500, currency: 'SEK', description: 'Payment', merchant_name: null, reference: null })
    mockResult({
      data: [{
        ...makeInvoice({ total: 12500, remaining_amount: 12500, status: 'sent', currency: 'EUR', total_sek: null }),
        customer: makeCustomer({ name: 'Different' }),
      }],
      error: null,
    })

    const result = await findMatchingInvoices(supabase as never, 'company-1', tx)
    // EUR invoice with no total_sek → currency mismatch → skipped
    expect(result).toEqual([])
  })
})

// ============================================================
// getBestInvoiceMatch
// ============================================================

describe('getBestInvoiceMatch', () => {
  const { supabase, mockResult } = createMockSupabase()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns highest-confidence match when above minConfidence', async () => {
    const tx = makeTransaction({ amount: 12500, description: 'Unrelated', merchant_name: null, reference: null })
    mockResult({
      data: [{
        ...makeInvoice({ total: 12500, status: 'sent', remaining_amount: 12500, currency: 'SEK' }),
        customer: makeCustomer({ name: 'Different' }),
      }],
      error: null,
    })

    const result = await getBestInvoiceMatch(supabase as never, 'company-1', tx)
    expect(result).not.toBeNull()
    expect(result!.confidence).toBe(0.80)
  })

  it('returns null when best match below minConfidence', async () => {
    const tx = makeTransaction({ amount: 12500, description: 'Unrelated', merchant_name: null, reference: null })
    mockResult({
      data: [{
        ...makeInvoice({ total: 12500, status: 'sent', remaining_amount: 12500, currency: 'SEK' }),
        customer: makeCustomer({ name: 'Different' }),
      }],
      error: null,
    })

    // minConfidence 0.90 → 0.80 match rejected
    const result = await getBestInvoiceMatch(supabase as never, 'company-1', tx, 0.90)
    expect(result).toBeNull()
  })

  it('defaults minConfidence to 0.80', async () => {
    const tx = makeTransaction({ amount: 12500, description: 'Unrelated', merchant_name: null, reference: null })
    mockResult({
      data: [{
        ...makeInvoice({ total: 12500, status: 'sent', remaining_amount: 12500, currency: 'SEK' }),
        customer: makeCustomer({ name: 'Different' }),
      }],
      error: null,
    })

    // Exact amount only → 0.80, meets default threshold
    const result = await getBestInvoiceMatch(supabase as never, 'company-1', tx)
    expect(result).not.toBeNull()
  })
})

// ============================================================
// findMatchingInvoices: paid-voucher status-leak guard
// ============================================================
//
// Defensive filter added because manual verifikationer (booked outside the
// match-invoice flow) leave the invoice in 'sent' status even though a
// payment voucher exists via invoice_payments. Matching such an invoice
// would double-book the bank receipt. Tests verify that:
//   - sent/overdue invoices with an invoice_payments.journal_entry_id are
//     excluded from the candidate list
//   - partially_paid invoices remain candidates regardless (they may take
//     more payments legitimately)
//   - invoices without payment rows still pass through unchanged

describe('findMatchingInvoices: status-leak guard', () => {
  it('excludes a sent invoice that already has a payment voucher', async () => {
    const { supabase: queuedSupabase, enqueue } = createQueuedMockSupabase()
    const inv = {
      ...makeInvoice({
        id: 'inv-leaked',
        total: 1000,
        status: 'sent',
        remaining_amount: 1000,
        currency: 'SEK',
      }),
      customer: makeCustomer({ name: 'Acme AB' }),
    }
    enqueue({ data: [inv], error: null })
    enqueue({ data: [{ invoice_id: 'inv-leaked' }], error: null })

    const tx = makeTransaction({ amount: 1000, description: 'Acme payment', reference: null })
    const result = await findMatchingInvoices(queuedSupabase as never, 'company-1', tx)
    expect(result).toEqual([])
  })

  it('keeps a partially_paid invoice as a candidate even with a prior payment voucher', async () => {
    const { supabase: queuedSupabase, enqueue } = createQueuedMockSupabase()
    const inv = {
      ...makeInvoice({
        id: 'inv-partial',
        total: 1000,
        status: 'partially_paid',
        remaining_amount: 400,
        currency: 'SEK',
      }),
      customer: makeCustomer({ name: 'Acme AB' }),
    }
    enqueue({ data: [inv], error: null })
    // The status-leak guard only queries when there are sent/overdue rows;
    // partially_paid invoices skip the second query, so no enqueue needed.

    const tx = makeTransaction({ amount: 400, description: 'Acme partial', reference: null })
    const result = await findMatchingInvoices(queuedSupabase as never, 'company-1', tx)
    expect(result).toHaveLength(1)
    expect(result[0].invoice.id).toBe('inv-partial')
  })

  it('passes sent invoices through when no payment rows exist for them', async () => {
    const { supabase: queuedSupabase, enqueue } = createQueuedMockSupabase()
    const inv = {
      ...makeInvoice({
        id: 'inv-clean',
        total: 1000,
        status: 'sent',
        remaining_amount: 1000,
        currency: 'SEK',
      }),
      customer: makeCustomer({ name: 'Acme AB' }),
    }
    enqueue({ data: [inv], error: null })
    enqueue({ data: [], error: null })

    const tx = makeTransaction({ amount: 1000, description: 'Acme payment', reference: null })
    const result = await findMatchingInvoices(queuedSupabase as never, 'company-1', tx)
    expect(result).toHaveLength(1)
    expect(result[0].invoice.id).toBe('inv-clean')
  })
})

// ============================================================
// findInvoiceMatchCandidates: unconverted foreign-currency invoices
// ============================================================
//
// A foreign-currency invoice with no stored SEK conversion is not comparable
// to a kronor bank row, so it is excluded from candidacy. That is correct (the
// alternative is "matching" 1 000 EUR against 1 000 kr) but it used to be
// silent: the user saw no suggestion and no explanation. The exclusion is now
// reported so a caller can point at the repair,
// POST /api/invoices/{id}/refresh-exchange-rate.

describe('findInvoiceMatchCandidates: unconverted FX exclusions', () => {
  function enqueueSingleInvoice(inv: unknown) {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [inv], error: null })
    // Status-leak guard's invoice_payments lookup.
    enqueue({ data: [], error: null })
    return supabase
  }

  it('reports no exclusions for an ordinary SEK match', async () => {
    const supabase = enqueueSingleInvoice({
      ...makeInvoice({ total: 12500, status: 'sent', remaining_amount: 12500, currency: 'SEK' }),
      customer: makeCustomer({ name: 'Different' }),
    })

    const tx = makeTransaction({ amount: 12500, description: 'Unrelated', merchant_name: null, reference: null })
    const result = await findInvoiceMatchCandidates(supabase as never, 'company-1', tx)

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].confidence).toBe(0.80)
    expect(result.unconvertedFxCount).toBe(0)
    expect(result.unconvertedFxInvoices).toEqual([])
  })

  it('still matches a EUR invoice that has a stored SEK conversion', async () => {
    // 1 000 EUR booked at 12.50 → total_sek 12 500 vs a 12 500 kr receipt.
    const supabase = enqueueSingleInvoice({
      ...makeInvoice({
        total: 1000,
        remaining_amount: 1000,
        status: 'sent',
        currency: 'EUR',
        total_sek: 12500,
        exchange_rate: 12.5,
      }),
      customer: makeCustomer({ name: 'Different' }),
    })

    const tx = makeTransaction({ amount: 12500, currency: 'SEK', description: 'Unrelated', merchant_name: null, reference: null })
    const result = await findInvoiceMatchCandidates(supabase as never, 'company-1', tx)

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].confidence).toBe(0.80)
    expect(result.unconvertedFxCount).toBe(0)
  })

  it('excludes a EUR invoice with no SEK conversion AND reports it', async () => {
    const supabase = enqueueSingleInvoice({
      ...makeInvoice({
        id: 'inv-eur-no-rate',
        invoice_number: 'F-2024099',
        total: 1000,
        remaining_amount: 1000,
        status: 'sent',
        currency: 'EUR',
        total_sek: null,
        exchange_rate: null,
      }),
      customer: makeCustomer({ name: 'Different' }),
    })

    const tx = makeTransaction({ amount: 12500, currency: 'SEK', description: 'Unrelated', merchant_name: null, reference: null })
    const result = await findInvoiceMatchCandidates(supabase as never, 'company-1', tx)

    expect(result.matches).toEqual([])
    expect(result.unconvertedFxCount).toBe(1)
    expect(result.unconvertedFxInvoices).toEqual([
      {
        invoiceId: 'inv-eur-no-rate',
        invoiceNumber: 'F-2024099',
        currency: 'EUR',
        reason: 'unconverted_fx',
      },
    ])
  })

  it('does not report a SEK invoice against a foreign bank row as an FX exclusion', async () => {
    // Nothing a rate refresh on the invoice would fix: the bank row is the
    // foreign side. Still excluded, just not as an unconverted-FX invoice.
    const supabase = enqueueSingleInvoice({
      ...makeInvoice({ total: 12500, remaining_amount: 12500, status: 'sent', currency: 'SEK' }),
      customer: makeCustomer({ name: 'Different' }),
    })

    const tx = makeTransaction({ amount: 12500, currency: 'EUR', description: 'Unrelated', merchant_name: null, reference: null })
    const result = await findInvoiceMatchCandidates(supabase as never, 'company-1', tx)

    expect(result.matches).toEqual([])
    expect(result.unconvertedFxCount).toBe(0)
  })

  // total_sek = 0 passes the `total_sek != null` currency guard and then hits
  // the conversion's old `return invoiceAmount` fallback, comparing 1 000 EUR
  // against a 1 000 kr receipt and scoring it an exact match at 0.80. The
  // fallback now returns null, so the invoice is not comparable at all.
  const zeroConversionInvoice = () => ({
    ...makeInvoice({
      id: 'inv-eur-zero-sek',
      total: 1000,
      remaining_amount: 1000,
      status: 'sent',
      currency: 'EUR',
      total_sek: 0,
    }),
    customer: makeCustomer({ name: 'Different' }),
  })
  const zeroConversionTx = () =>
    makeTransaction({ amount: 1000, currency: 'SEK', description: 'Unrelated', merchant_name: null, reference: null })

  it('never matches the raw foreign total when the stored conversion is zero', async () => {
    const supabase = enqueueSingleInvoice(zeroConversionInvoice())

    const result = await findMatchingInvoices(supabase as never, 'company-1', zeroConversionTx())

    expect(result).toEqual([])
  })

  it('reports the zero-conversion invoice as an unconverted FX exclusion', async () => {
    const supabase = enqueueSingleInvoice(zeroConversionInvoice())

    const result = await findInvoiceMatchCandidates(supabase as never, 'company-1', zeroConversionTx())

    expect(result.unconvertedFxCount).toBe(1)
    expect(result.unconvertedFxInvoices[0].invoiceId).toBe('inv-eur-zero-sek')
  })

  it('keeps the array-returning wrapper working for existing callers', async () => {
    const supabase = enqueueSingleInvoice({
      ...makeInvoice({ total: 12500, status: 'sent', remaining_amount: 12500, currency: 'SEK' }),
      customer: makeCustomer({ name: 'Different' }),
    })

    const tx = makeTransaction({ amount: 12500, description: 'Unrelated', merchant_name: null, reference: null })
    const result = await findMatchingInvoices(supabase as never, 'company-1', tx)

    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(1)
  })
})

// ============================================================
// findInvoiceMatchCandidates: currency normalization
// ============================================================
//
// `invoices.currency` and `transactions.currency` are both nullable with
// DEFAULT 'SEK', so a legacy NULL (or a lowercase code) means kronor. The raw
// `invoice.currency === transaction.currency` comparison sent those rows down
// the cross-currency branch, where `total_sek` (DEFAULT 0) is never usable, so
// legacy NULL-currency invoices were excluded from ALL matching with no
// exclusion report either (isUnconvertedForeignInvoice required a truthy
// currency). Both helpers now normalize through normalizeCurrencyCode.

describe('findInvoiceMatchCandidates: currency normalization', () => {
  function enqueueSingleInvoice(inv: unknown) {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [inv], error: null })
    // Status-leak guard's invoice_payments lookup.
    enqueue({ data: [], error: null })
    return supabase
  }

  it('matches a legacy NULL-currency invoice against a SEK bank row', async () => {
    const supabase = enqueueSingleInvoice({
      ...makeInvoice({
        total: 12500,
        remaining_amount: 12500,
        status: 'sent',
        currency: null as unknown as Invoice['currency'],
        total_sek: 0,
      }),
      customer: makeCustomer({ name: 'Different' }),
    })

    const tx = makeTransaction({ amount: 12500, currency: 'SEK', description: 'Unrelated', merchant_name: null, reference: null })
    const result = await findInvoiceMatchCandidates(supabase as never, 'company-1', tx)

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].confidence).toBe(0.80)
    // NULL means SEK per the column default: never an FX exclusion.
    expect(result.unconvertedFxCount).toBe(0)
    expect(result.unconvertedFxInvoices).toEqual([])
  })

  it('compares currency codes case-insensitively', async () => {
    const supabase = enqueueSingleInvoice({
      ...makeInvoice({
        total: 12500,
        remaining_amount: 12500,
        status: 'sent',
        currency: 'sek' as unknown as Invoice['currency'],
      }),
      customer: makeCustomer({ name: 'Different' }),
    })

    const tx = makeTransaction({ amount: 12500, currency: 'SEK', description: 'Unrelated', merchant_name: null, reference: null })
    const result = await findInvoiceMatchCandidates(supabase as never, 'company-1', tx)

    expect(result.matches).toHaveLength(1)
    expect(result.unconvertedFxCount).toBe(0)
  })

  it('never reports a NULL-currency invoice as an unconverted FX exclusion', async () => {
    // Amounts deliberately do not line up: no match, but the miss is an
    // ordinary amount miss, not a swallowed FX exclusion.
    const supabase = enqueueSingleInvoice({
      ...makeInvoice({
        total: 999,
        remaining_amount: 999,
        status: 'sent',
        currency: null as unknown as Invoice['currency'],
        total_sek: 0,
      }),
      customer: makeCustomer({ name: 'Different' }),
    })

    const tx = makeTransaction({ amount: 12500, currency: 'SEK', description: 'Unrelated', merchant_name: null, reference: null })
    const result = await findInvoiceMatchCandidates(supabase as never, 'company-1', tx)

    expect(result.matches).toEqual([])
    expect(result.unconvertedFxCount).toBe(0)
    expect(result.unconvertedFxInvoices).toEqual([])
  })

  it('falls back to the stored exchange_rate when total_sek was never written', async () => {
    // Same SEK-resolution as duplicate-guard-currency.ts#invoiceAmountSek (one
    // definition): total_sek 0 means "not stored", the booked exchange_rate is
    // still a STORED conversion and makes the invoice comparable.
    const supabase = enqueueSingleInvoice({
      ...makeInvoice({
        total: 1000,
        remaining_amount: 1000,
        status: 'sent',
        currency: 'EUR',
        total_sek: 0,
        exchange_rate: 11.5,
      }),
      customer: makeCustomer({ name: 'Different' }),
    })

    const tx = makeTransaction({ amount: 11500, currency: 'SEK', description: 'Unrelated', merchant_name: null, reference: null })
    const result = await findInvoiceMatchCandidates(supabase as never, 'company-1', tx)

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].confidence).toBe(0.80)
    expect(result.unconvertedFxCount).toBe(0)
  })
})
