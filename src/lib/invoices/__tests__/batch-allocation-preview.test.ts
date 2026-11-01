import { describe, it, expect } from 'vitest'
import { buildBatchAllocationPreview } from '@/lib/invoices/batch-allocation-preview'

// The projection of the verifikat match_batch_allocate posts
// (supabase/migrations/20260824120000_match_batch_allocate_ore_settlement.sql).
// Expected rows below are read off that function, not off the helper.

const INV_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const INV_B = 'bbbbbbbb-0000-4000-8000-000000000002'

describe('buildBatchAllocationPreview', () => {
  it('says when the lines it projects do not balance', () => {
    const preview = buildBatchAllocationPreview({
      transaction: { amount: 1000, date: '2026-07-31' },
      bankAccount: '1930',
      allocations: [{ kind: 'customer_invoice', invoice_id: INV_A, amount: 1000 }],
      invoices: { [INV_A]: { currency: 'SEK', exchange_rate: null, remaining_amount: 1000, total: 1000 } },
      cashLines: { [INV_A]: [{ account_number: '3001', debit_amount: 0, credit_amount: 900 }] },
    })
    expect(preview.balanced).toBe(false)
  })

  it('same-currency customer batch: Cr 1510 per invoice in id order, Dr 1930 for the whole receipt', () => {
    const preview = buildBatchAllocationPreview({
      transaction: { amount: 88250, date: '2026-07-31T00:00:00+00:00' },
      bankAccount: '1930',
      // Deliberately out of id order: the RPC sorts by the id text.
      allocations: [
        { kind: 'customer_invoice', invoice_id: INV_B, amount: 25750 },
        { kind: 'customer_invoice', invoice_id: INV_A, amount: 62500 },
      ],
      invoices: {
        [INV_A]: { currency: 'SEK', exchange_rate: null, remaining_amount: 62500, total: 62500 },
        [INV_B]: { currency: 'SEK', exchange_rate: null, remaining_amount: 25750, total: 25750 },
      },
    })
    expect(preview).toEqual({
      entry_date: '2026-07-31',
      description: 'Samlingsinbetalning 2026-07-31',
      balanced: true,
      fx: 'none',
      lines: [
        { account_number: '1510', description: 'Kundfaktura 1 av 2', debit: 0, credit: 62500 },
        { account_number: '1510', description: 'Kundfaktura 2 av 2', debit: 0, credit: 25750 },
        { account_number: '1930', description: 'Inbetalning 2026-07-31', debit: 88250, credit: 0 },
      ],
    })
  })

  it('same-currency supplier batch: Dr 2440 per invoice, Cr 1930 for the whole payment', () => {
    const preview = buildBatchAllocationPreview({
      transaction: { amount: -3000, date: '2026-08-05' },
      bankAccount: '1930',
      allocations: [
        { kind: 'supplier_invoice', supplier_invoice_id: INV_A, amount: 1000 },
        { kind: 'supplier_invoice', supplier_invoice_id: INV_B, amount: 2000 },
      ],
      invoices: {
        [INV_A]: { currency: 'SEK', remaining_amount: 1000, total: 1000 },
        [INV_B]: { currency: 'SEK', remaining_amount: 2000, total: 2000 },
      },
    })
    expect(preview.description).toBe('Samlingsbetalning 2026-08-05')
    expect(preview.lines).toEqual([
      { account_number: '2440', description: 'Leverantörsfaktura 1 av 2', debit: 1000, credit: 0 },
      { account_number: '2440', description: 'Leverantörsfaktura 2 av 2', debit: 2000, credit: 0 },
      { account_number: '1930', description: 'Utbetalning 2026-08-05', debit: 0, credit: 3000 },
    ])
    expect(preview.balanced).toBe(true)
    expect(preview.fx).toBe('none')
  })

  // Feedback 708521: a batch of ONE invoice is not a samlingsbetalning. The RPC
  // (20260929015251) names it like the single-invoice match routes; the
  // preview states that wording without the invoice number and counterparty.
  it('one invoice: the single-invoice wording, without number and counterparty', () => {
    const supplier = buildBatchAllocationPreview({
      transaction: { amount: -1250, date: '2026-01-16' },
      bankAccount: '1930',
      allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: INV_A, amount: 1250 }],
      invoices: { [INV_A]: { currency: 'SEK', remaining_amount: 1250, total: 1250 } },
    })
    expect(supplier.description).toBe('Utbetalning leverantörsfaktura')

    const customer = buildBatchAllocationPreview({
      transaction: { amount: 500, date: '2026-06-05' },
      bankAccount: '1930',
      allocations: [{ kind: 'customer_invoice', invoice_id: INV_A, amount: 500 }],
      invoices: { [INV_A]: { currency: 'SEK', remaining_amount: 500, total: 500 } },
    })
    expect(customer.description).toBe('Inbetalning kundfaktura')
  })

  it('sub-krona öresavrundning: clears the full remaining and lands the residual on 3740 (#1717)', () => {
    // Customer paid 1 250 kr on a 1 250,40 kr invoice: short by 40 öre = Dr 3740.
    const short = buildBatchAllocationPreview({
      transaction: { amount: 1250, date: '2026-08-05' },
      bankAccount: '1930',
      allocations: [{ kind: 'customer_invoice', invoice_id: INV_A, amount: 1250 }],
      invoices: { [INV_A]: { currency: 'SEK', remaining_amount: 1250.4, total: 1250.4 } },
    })
    expect(short.lines).toEqual([
      { account_number: '1510', description: 'Kundfaktura 1 av 1', debit: 0, credit: 1250.4 },
      { account_number: '3740', description: 'Öresavrundning', debit: 0.4, credit: 0 },
      { account_number: '1930', description: 'Inbetalning 2026-08-05', debit: 1250, credit: 0 },
    ])
    expect(short.balanced).toBe(true)

    // Supplier paid 1 250 kr on a 1 249,60 kr bill: 40 öre more than owed = Dr 3740.
    const over = buildBatchAllocationPreview({
      transaction: { amount: -1250, date: '2026-08-05' },
      bankAccount: '1930',
      allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: INV_A, amount: 1250 }],
      invoices: { [INV_A]: { currency: 'SEK', remaining_amount: 1249.6, total: 1249.6 } },
    })
    expect(over.lines).toEqual([
      { account_number: '2440', description: 'Leverantörsfaktura 1 av 1', debit: 1249.6, credit: 0 },
      { account_number: '3740', description: 'Öresavrundning', debit: 0.4, credit: 0 },
      { account_number: '1930', description: 'Utbetalning 2026-08-05', debit: 0, credit: 1250 },
    ])
    expect(over.balanced).toBe(true)
  })

  it('cross-currency customer batch with a booked rate: Cr 1510 at booked SEK, the difference on 7960 or 3960', () => {
    // Booked 1 000 EUR at 11,20 = 11 200 kr; bank credited 11 000 kr: loss 200 kr.
    const loss = buildBatchAllocationPreview({
      transaction: { amount: 11000, date: '2026-08-05' },
      bankAccount: '1930',
      allocations: [{ kind: 'customer_invoice', invoice_id: INV_A, amount: 11000 }],
      invoices: { [INV_A]: { currency: 'EUR', exchange_rate: 11.2, remaining_amount: 1000, total: 1000 } },
    })
    expect(loss.fx).toBe('included')
    expect(loss.lines).toEqual([
      { account_number: '1510', description: 'Kundfaktura 1 av 1 (EUR)', debit: 0, credit: 11200 },
      { account_number: '7960', description: 'Valutakursförlust', debit: 200, credit: 0 },
      { account_number: '1930', description: 'Inbetalning 2026-08-05', debit: 11000, credit: 0 },
    ])
    expect(loss.balanced).toBe(true)

    // Bank credited 11 350 kr on the same booking: gain 150 kr.
    const gain = buildBatchAllocationPreview({
      transaction: { amount: 11350, date: '2026-08-05' },
      bankAccount: '1930',
      allocations: [{ kind: 'customer_invoice', invoice_id: INV_A, amount: 11350 }],
      invoices: { [INV_A]: { currency: 'EUR', exchange_rate: 11.2, remaining_amount: 1000, total: 1000 } },
    })
    expect(gain.lines[1]).toEqual({ account_number: '3960', description: 'Valutakursvinst', debit: 0, credit: 150 })
    expect(gain.balanced).toBe(true)
  })

  it('a foreign invoice clears what the ledger carries, not the remainder at the rate', () => {
    // 176.70 EUR at 11.123 is 1965.43; the registration left 1965.44 on 1510.
    const preview = buildBatchAllocationPreview({
      transaction: { amount: 1970, date: '2026-08-05' },
      bankAccount: '1930',
      allocations: [{ kind: 'customer_invoice', invoice_id: INV_A, amount: 1970 }],
      invoices: { [INV_A]: { currency: 'EUR', exchange_rate: 11.123, remaining_amount: 176.7, total: 176.7, carried_sek: 1965.44 } },
    })
    expect(preview.lines.map((l) => [l.account_number, l.debit, l.credit])).toEqual([
      ['1510', 0, 1965.44],
      ['3960', 0, 4.56],
      ['1930', 1970, 0],
    ])
  })

  it('rounds a foreign invoice the way the RPC does: 30 EUR at 10.9455 is 328.37', () => {
    const preview = buildBatchAllocationPreview({
      transaction: { amount: 328, date: '2026-08-05' },
      bankAccount: '1930',
      allocations: [{ kind: 'customer_invoice', invoice_id: INV_A, amount: 328 }],
      invoices: { [INV_A]: { currency: 'EUR', exchange_rate: 10.9455, remaining_amount: 30, total: 30 } },
    })
    expect(preview.lines[0]).toMatchObject({ account_number: '1510', credit: 328.37 })
  })

  it('cross-currency supplier batch mirrors the polarity: paying less than booked is a gain', () => {
    const preview = buildBatchAllocationPreview({
      transaction: { amount: -11000, date: '2026-08-05' },
      bankAccount: '1930',
      allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: INV_A, amount: 11000 }],
      invoices: { [INV_A]: { currency: 'EUR', exchange_rate: 11.2, remaining_amount: 1000, total: 1000 } },
    })
    expect(preview.lines).toEqual([
      { account_number: '2440', description: 'Leverantörsfaktura 1 av 1 (EUR)', debit: 11200, credit: 0 },
      { account_number: '3960', description: 'Valutakursvinst', debit: 0, credit: 200 },
      { account_number: '1930', description: 'Utbetalning 2026-08-05', debit: 0, credit: 11000 },
    ])
    expect(preview.balanced).toBe(true)
  })

  it('cross-currency invoice without a usable rate: shows the allocation and defers the FX leg to commit', () => {
    const preview = buildBatchAllocationPreview({
      transaction: { amount: 11000, date: '2026-08-05' },
      bankAccount: '1930',
      allocations: [{ kind: 'customer_invoice', invoice_id: INV_A, amount: 11000 }],
      invoices: { [INV_A]: { currency: 'EUR', exchange_rate: null, remaining_amount: 1000, total: 1000 } },
    })
    expect(preview.fx).toBe('computed_at_commit')
    expect(preview.lines[0]).toEqual({ account_number: '1510', description: 'Kundfaktura 1 av 1 (EUR)', debit: 0, credit: 11000 })
  })

  it('an invoice row the caller did not fetch falls back to the allocation amount', () => {
    const preview = buildBatchAllocationPreview({
      transaction: { amount: 500, date: '2026-08-05' },
      bankAccount: '1930',
      allocations: [{ kind: 'customer_invoice', invoice_id: INV_A, amount: 500 }],
      invoices: {},
    })
    expect(preview.lines[0]).toEqual({ account_number: '1510', description: 'Kundfaktura 1 av 1', debit: 0, credit: 500 })
    expect(preview.balanced).toBe(true)
  })

  it('rejects allocations that do not sum to the transaction, like the RPC does', () => {
    expect(() =>
      buildBatchAllocationPreview({
        transaction: { amount: 1000, date: '2026-08-05' },
        bankAccount: '1930',
        allocations: [{ kind: 'customer_invoice', invoice_id: INV_A, amount: 900 }],
        invoices: { [INV_A]: { currency: 'SEK', remaining_amount: 900, total: 900 } },
      }),
    ).toThrow(/must equal the transaction amount/)
  })

  it('rejects a batch that mixes kinds or is empty', () => {
    expect(() =>
      buildBatchAllocationPreview({
        transaction: { amount: 1000, date: '2026-08-05' },
        bankAccount: '1930',
        allocations: [
          { kind: 'customer_invoice', invoice_id: INV_A, amount: 500 },
          { kind: 'supplier_invoice', supplier_invoice_id: INV_B, amount: 500 },
        ],
        invoices: {},
      }),
    ).toThrow(/one kind/)
    expect(() =>
      buildBatchAllocationPreview({ transaction: { amount: 1000, date: '2026-08-05' }, bankAccount: '1930', allocations: [], invoices: {} }),
    ).toThrow(/must not be empty/)
  })

  // Issue #3097: the RPC books the bank leg on the row's own cash account
  // (capture_bank_booking_context, 20260921180432); the preview used to show
  // 1930 regardless. tests/pg/match-batch-preview-parity.pg.test.ts pins the
  // two against the real function.
  it('books the bank leg on the account the caller resolved, never a hardcoded 1930', () => {
    const supplier = buildBatchAllocationPreview({
      transaction: { amount: -3000, date: '2026-09-25' },
      bankAccount: '1931',
      allocations: [
        { kind: 'supplier_invoice', supplier_invoice_id: INV_A, amount: 1000 },
        { kind: 'supplier_invoice', supplier_invoice_id: INV_B, amount: 2000 },
      ],
      invoices: {
        [INV_A]: { currency: 'SEK', remaining_amount: 1000, total: 1000 },
        [INV_B]: { currency: 'SEK', remaining_amount: 2000, total: 2000 },
      },
    })
    expect(supplier.lines.at(-1)).toEqual({ account_number: '1931', description: 'Utbetalning 2026-09-25', debit: 0, credit: 3000 })
    expect(supplier.lines.some((l) => l.account_number === '1930')).toBe(false)
    expect(supplier.balanced).toBe(true)

    const customer = buildBatchAllocationPreview({
      transaction: { amount: 500, date: '2026-09-25' },
      bankAccount: '1931',
      allocations: [{ kind: 'customer_invoice', invoice_id: INV_A, amount: 500 }],
      invoices: { [INV_A]: { currency: 'SEK', remaining_amount: 500, total: 500 } },
    })
    expect(customer.lines.at(-1)).toEqual({ account_number: '1931', description: 'Inbetalning 2026-09-25', debit: 500, credit: 0 })
  })

  // Issue #131 (migration 20261028231700): fee rows follow the invoices'
  // lines as debits, before the bank leg, on both sides.
  describe('fee rows', () => {
    const invoices = {
      [INV_A]: { currency: 'SEK', remaining_amount: 6000, total: 6000 },
      [INV_B]: { currency: 'SEK', remaining_amount: 4000, total: 4000 },
    }

    it('a payout net of the fee: every invoice in full on 1510, the fee on 6570, the bank leg what arrived', () => {
      const preview = buildBatchAllocationPreview({
        transaction: { amount: 8500, date: '2026-06-30' },
        bankAccount: '1930',
        allocations: [
          { kind: 'customer_invoice', invoice_id: INV_A, amount: 6000 },
          { kind: 'customer_invoice', invoice_id: INV_B, amount: 4000 },
        ],
        invoices,
        fees: [{ account: '6570', amount: 1500, description: ' Booking-avgift juni ' }],
      })
      expect(preview.lines).toEqual([
        { account_number: '1510', description: 'Kundfaktura 1 av 2', debit: 0, credit: 6000 },
        { account_number: '1510', description: 'Kundfaktura 2 av 2', debit: 0, credit: 4000 },
        { account_number: '6570', description: 'Booking-avgift juni', debit: 1500, credit: 0 },
        { account_number: '1930', description: 'Inbetalning 2026-06-30', debit: 8500, credit: 0 },
      ])
      expect(preview.balanced).toBe(true)
    })

    it('a payment the bank added a fee to: Dr 2440, Dr the fee, Cr the bank for both; the default text', () => {
      const preview = buildBatchAllocationPreview({
        transaction: { amount: -10050, date: '2026-06-30' },
        bankAccount: '1930',
        allocations: [
          { kind: 'supplier_invoice', supplier_invoice_id: INV_A, amount: 6000 },
          { kind: 'supplier_invoice', supplier_invoice_id: INV_B, amount: 4000 },
        ],
        invoices,
        fees: [
          { account: '6570', amount: 30 },
          { account: '6570', amount: 20.004 },
        ],
      })
      expect(preview.lines.slice(2)).toEqual([
        { account_number: '6570', description: 'Avgift betaltjänst', debit: 30, credit: 0 },
        { account_number: '6570', description: 'Avgift betaltjänst', debit: 20, credit: 0 },
        { account_number: '1930', description: 'Utbetalning 2026-06-30', debit: 0, credit: 10050 },
      ])
      expect(preview.balanced).toBe(true)
    })

    it('refuses invoices that do not meet the row once the fees are counted, like the RPC does', () => {
      const build = (amount: number) => () =>
        buildBatchAllocationPreview({
          transaction: { amount, date: '2026-06-30' },
          bankAccount: '1930',
          allocations: [{ kind: 'customer_invoice', invoice_id: INV_A, amount: 6000 }],
          invoices,
          fees: [{ account: '6570', amount: 100 }],
        })
      expect(build(5900)).not.toThrow()
      // The fee withheld from a payout never adds to it.
      expect(build(6000)).toThrow(/must equal the transaction amount/)
      expect(build(6100)).toThrow(/must equal the transaction amount/)
    })
  })
})

describe('buildBatchAllocationPreview: kontantmetoden cash lines (crm#1539, migration 20261031100700)', () => {
  it('books each unbooked invoice\'s revenue, moms and öresavrundning in place of 1510, and the one bank leg', () => {
    const preview = buildBatchAllocationPreview({
      transaction: { amount: 1063, date: '2026-10-28' },
      bankAccount: '1930',
      allocations: [
        { kind: 'customer_invoice', invoice_id: INV_B, amount: 563 },
        { kind: 'customer_invoice', invoice_id: INV_A, amount: 500 },
      ],
      invoices: {
        [INV_A]: { currency: 'SEK', remaining_amount: 500, total: 1000 },
        [INV_B]: { currency: 'SEK', remaining_amount: 562.5, total: 1125 },
      },
      cashLines: {
        [INV_A]: [
          { account_number: '3001', debit_amount: 0, credit_amount: 400 },
          { account_number: '2611', debit_amount: 0, credit_amount: 100 },
        ],
        [INV_B]: [
          { account_number: '3001', debit_amount: 0, credit_amount: 450 },
          { account_number: '2611', debit_amount: 0, credit_amount: 112.5 },
          { account_number: '3740', debit_amount: 0, credit_amount: 0.5 },
        ],
      },
    })
    // Sorted by invoice id as the RPC sorts; no 1510 line at all.
    expect(preview.lines).toEqual([
      { account_number: '3001', description: 'Kundfaktura 1 av 2', debit: 0, credit: 400 },
      { account_number: '2611', description: 'Kundfaktura 1 av 2', debit: 0, credit: 100 },
      { account_number: '3001', description: 'Kundfaktura 2 av 2', debit: 0, credit: 450 },
      { account_number: '2611', description: 'Kundfaktura 2 av 2', debit: 0, credit: 112.5 },
      { account_number: '3740', description: 'Kundfaktura 2 av 2', debit: 0, credit: 0.5 },
      { account_number: '1930', description: 'Inbetalning 2026-10-28', debit: 1063, credit: 0 },
    ])
    expect(preview.balanced).toBe(true)
    expect(preview.description).toBe('Samlingsinbetalning 2026-10-28')
  })
})
