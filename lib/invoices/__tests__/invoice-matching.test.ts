import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  amountsMatchExact,
  amountsMatchFuzzy,
  customerNameMatches,
  calculateMatchScore,
  findMatchingInvoices,
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
// findMatchingInvoices (integration — mock Supabase)
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

  it('returns immediately on OCR match without further scoring', async () => {
    const tx = makeTransaction({ amount: 12500, reference: 'F-2024001' })
    mockResult({
      data: [
        { ...makeInvoice({ invoice_number: 'F-2024001', total: 12500, status: 'sent', remaining_amount: 12500, currency: 'SEK' }) },
        // Second invoice with exact amount — should not be scored
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
// findMatchingInvoices — paid-voucher status-leak guard
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

describe('findMatchingInvoices — status-leak guard', () => {
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
