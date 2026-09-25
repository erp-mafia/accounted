import { describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase, makeSupplierInvoice } from '@/tests/helpers'
import { resolveSupplierInvoicePaymentSek, supplierInvoicePaymentSek } from '../supplier-payment-amounts'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateJournalEntryInput, SupplierInvoiceItem } from '@/types'

vi.mock('../engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('period-1'),
  createJournalEntry: vi.fn(async (_db: unknown, _company: string, _user: string, input: CreateJournalEntryInput) => ({ id: 'registration', ...input })),
}))
import { createSupplierInvoiceRegistrationEntry } from '../supplier-invoice-entries'

const usd = makeSupplierInvoice({
  currency: 'USD', total: 37.5, total_sek: 361.55, exchange_rate: 9.6414, paid_amount: 0, remaining_amount: 37.5,
})

describe('supplierInvoicePaymentSek', () => {
  it('converts a USD payment and prefers the stored SEK total', () => {
    expect(supplierInvoicePaymentSek(usd, 37.5)).toBe(361.55)
    expect(supplierInvoicePaymentSek({ ...usd, exchange_rate: 10 }, 37.5)).toBe(361.55)
    expect(supplierInvoicePaymentSek({ ...usd, total_sek: null }, 37.5)).toBe(361.55)
  })

  it('allocates the final ore across partial payments instead of leaving a residual', () => {
    expect(supplierInvoicePaymentSek(usd, 18.75)).toBe(180.78)
    expect(supplierInvoicePaymentSek({ ...usd, paid_amount: 18.75 }, 18.75, {
      registeredSek: 361.55, settledSek: 180.78,
    })).toBe(180.77)
  })

  it('can settle a stored SEK value without fetching a replacement rate', () => {
    expect(supplierInvoicePaymentSek({ ...usd, exchange_rate: null }, 37.5)).toBe(361.55)
  })

  it.each([null, 0, -1, NaN, Infinity])('refuses an unusable FX rate: %s', (exchange_rate) => {
    expect(supplierInvoicePaymentSek({ ...usd, total_sek: null, exchange_rate }, 37.5)).toBeNull()
  })

  it('leaves SEK amounts unchanged even when stale FX fields exist', () => {
    expect(supplierInvoicePaymentSek({ ...usd, currency: 'SEK' }, 37.5)).toBe(37.5)
  })

  it('does not reconstruct SEK payment history from paid_amount', () => {
    expect(supplierInvoicePaymentSek({ ...usd, paid_amount: 18.75 }, 18.75)).toBeNull()
  })
})

describe('resolveSupplierInvoicePaymentSek', () => {
  const registered = { ...usd, registration_journal_entry_id: 'registration' }
  const entry = (id: string, status = 'posted', correction_of_id: string | null = null) => ({ id, status, correction_of_id })
  const payment = (id: string, amount: number) => ({ id, amount, currency: 'USD', journal_entry_id: id })
  const line = (journal_entry_id: string, debit_amount: number, credit_amount = 0) => ({ journal_entry_id, debit_amount, credit_amount })

  function fixture(paid: number[] = [], settled: number[] = [], registeredSek = 361.55) {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: paid.map((amount, i) => payment(`p${i}`, amount)), error: null })
    mock.enqueue({ data: [entry('registration'), ...paid.map((_, i) => entry(`p${i}`))], error: null })
    mock.enqueue({ data: [], error: null }) // other invoices' payments
    mock.enqueue({ data: [], error: null }) // other invoices' registrations
    mock.enqueue({ data: [line('registration', 0, registeredSek), ...settled.map((amount, i) => line(`p${i}`, amount))], error: null })
    return mock
  }
  const resolve = (mock: ReturnType<typeof createQueuedMockSupabase>, paid = 0, amount = 37.5 - paid) =>
    resolveSupplierInvoicePaymentSek(mock.supabase as unknown as SupabaseClient, 'company-1', {
      ...registered, paid_amount: paid, remaining_amount: 37.5 - paid,
    }, amount)

  it('clears the liability produced by separately rounded registration lines', async () => {
    const items = [1, 2].map(n => ({
      id: String(n), supplier_invoice_id: usd.id, sort_order: n,
      description: 'Service', quantity: 1, unit: 'st', unit_price: 18.75,
      line_total: 18.75, account_number: '6540', vat_code: null, vat_rate: 0, vat_amount: 0,
      reverse_charge_rate: null, created_at: '2026-09-15',
    })) as SupplierInvoiceItem[]
    const voucher = await createSupplierInvoiceRegistrationEntry({} as SupabaseClient, 'company-1', 'user-1', {
      ...registered, reverse_charge: false, vat_treatment: 'exempt',
    }, items, 'non_eu_business')
    const actualLiability = voucher!.lines!.find(l => l.account_number === '2440')!.credit_amount
    expect(actualLiability).toBe(361.56)
    expect(await resolve(fixture([], [], actualLiability))).toBe(actualLiability)
  })

  it('consumes the actual remainder after the first partial payment is reversed', async () => {
    // The 180.78 first half was reversed and removed from payment history;
    // the 180.77 second half survives. Its invoice-currency amount is 18.75.
    expect(await resolve(fixture([18.75], [180.77]), 18.75)).toBe(180.78)
  })

  it('clears the remainder after two bank-matched payments rounded independently', async () => {
    expect(await resolve(fixture([12.5, 12.5], [120.52, 120.52]), 25)).toBe(120.51)
  })

  it('allocates a partial from the actual remaining liability', async () => {
    expect(await resolve(fixture([12.5], [120.52]), 12.5, 12.5)).toBe(120.52)
  })

  it('can settle a posted liability without invoice conversion fields', async () => {
    const mock = fixture()
    expect(await resolveSupplierInvoicePaymentSek(mock.supabase as unknown as SupabaseClient, 'company-1', {
      ...registered, total_sek: null, exchange_rate: null,
    }, 37.5)).toBe(361.55)
  })

  it('scopes every read to the company and payment history to the invoice', async () => {
    const mock = fixture([18.75], [180.78])
    await resolve(mock, 18.75)
    for (const table of ['journal_entries', 'supplier_invoice_payments', 'supplier_invoices']) {
      expect(mock.findCalls(table, 'eq')).toContainEqual(['company_id', 'company-1'])
    }
    expect(mock.findCalls('supplier_invoice_payments', 'eq')).toContainEqual(['supplier_invoice_id', usd.id])
    expect(mock.findCalls('journal_entry_lines', 'eq')).toContainEqual(['journal_entries.company_id', 'company-1'])
    expect(mock.findCalls('journal_entry_lines', 'eq')).toContainEqual(['account_number', '2440'])
  })

  it('follows a storno correction to the currently posted registration', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [], error: null })
    mock.enqueue({ data: [entry('registration', 'reversed')], error: null })
    mock.enqueue({ data: [entry('corrected', 'posted', 'registration')], error: null })
    mock.enqueue({ data: [], error: null })
    mock.enqueue({ data: [], error: null })
    mock.enqueue({ data: [line('corrected', 0, 361.56)], error: null })
    expect(await resolve(mock)).toBe(361.56)
    expect(mock.findCalls('journal_entry_lines', 'in')).toContainEqual(['journal_entry_id', ['corrected']])
  })

  it('refuses to guess when a linked payment is missing', async () => {
    await expect(resolve(fixture(), 18.75)).rejects.toThrow('Payment history does not explain')
  })

  it('refuses inconsistent invoice-currency totals before reading vouchers', async () => {
    const mock = createQueuedMockSupabase()
    await expect(resolveSupplierInvoicePaymentSek(mock.supabase as unknown as SupabaseClient, 'company-1', {
      ...registered, remaining_amount: 20,
    }, 20)).rejects.toThrow('remaining amount does not agree')
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('uses the corrected payment voucher instead of its reversed original', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [payment('p0', 18.75)], error: null })
    mock.enqueue({ data: [entry('registration'), entry('p0', 'reversed')], error: null })
    mock.enqueue({ data: [entry('corrected-payment', 'posted', 'p0')], error: null })
    mock.enqueue({ data: [], error: null })
    mock.enqueue({ data: [], error: null })
    mock.enqueue({ data: [line('registration', 0, 361.55), line('corrected-payment', 180.77)], error: null })
    expect(await resolve(mock, 18.75)).toBe(180.78)
  })

  it('refuses vouchers with no payable lines instead of using the invoice FX total', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [], error: null })
    mock.enqueue({ data: [entry('registration')], error: null })
    mock.enqueue({ data: [], error: null })
    mock.enqueue({ data: [], error: null })
    mock.enqueue({ data: [], error: null })
    await expect(resolve(mock)).rejects.toThrow('no 2440 lines')
  })

  it('refuses overlapping correction chains instead of counting one voucher twice', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [payment('corrected', 18.75)], error: null })
    mock.enqueue({ data: [entry('registration', 'reversed'), entry('corrected', 'posted', 'registration')], error: null })
    mock.enqueue({ data: [entry('corrected', 'posted', 'registration')], error: null })
    await expect(resolve(mock, 18.75)).rejects.toThrow('same corrected voucher more than once')
  })

  it('propagates a payment-history read error rather than assuming nothing was paid', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: null, error: { message: 'read failed', code: '57014' } })
    await expect(resolve(mock)).rejects.toMatchObject({ code: '57014' })
  })

  it.each(['draft', 'cancelled'])('refuses a %s registration', async status => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [], error: null })
    mock.enqueue({ data: [entry('registration', status)], error: null })
    await expect(resolve(mock)).rejects.toThrow('not posted')
  })

  it('refuses a reversed registration with no replacement', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [], error: null })
    mock.enqueue({ data: [entry('registration', 'reversed')], error: null })
    mock.enqueue({ data: [], error: null })
    await expect(resolve(mock)).rejects.toThrow('no unambiguous correction')
  })

  it.each(['payment', 'registration'])('refuses a voucher shared through another invoice %s', async kind => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [], error: null })
    mock.enqueue({ data: [entry('registration')], error: null })
    mock.enqueue({ data: kind === 'payment' ? [{ id: 'other' }] : [], error: null })
    mock.enqueue({ data: kind === 'registration' ? [{ id: 'other' }] : [], error: null })
    await expect(resolve(mock)).rejects.toThrow('shared with another invoice')
  })

  it('reads every 2440 line beyond the PostgREST page limit', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [], error: null })
    mock.enqueue({ data: [entry('registration')], error: null })
    mock.enqueue({ data: [], error: null })
    mock.enqueue({ data: [], error: null })
    mock.enqueue({ data: Array.from({ length: 1000 }, () => line('registration', 0, 0.01)), error: null })
    mock.enqueue({ data: [line('registration', 0, 351.55)], error: null })
    expect(await resolve(mock)).toBe(361.55)
    expect(mock.findCalls('journal_entry_lines', 'range')).toEqual([[0, 999], [1000, 1999]])
    expect(mock.findCalls('journal_entry_lines', 'order')).toEqual([['id'], ['id']])
  })
})
