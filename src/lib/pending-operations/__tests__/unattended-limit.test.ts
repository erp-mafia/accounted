import { describe, expect, it } from 'vitest'
import { lineBalance } from '@/lib/bookkeeping/line-balance'
import { generateReverseChargePurchaseLines } from '@/lib/bookkeeping/vat-entries'
import { buildBatchAllocationPreview } from '@/lib/invoices/batch-allocation-preview'
import { exceedsUnattendedLimit, priceOperation } from '../unattended-limit'

/**
 * A staged match_batch_allocate preview carrying the lines the real preview
 * builder computes (expected_lines), and the debit side those lines post.
 */
function stagedBatch(input: Parameters<typeof buildBatchAllocationPreview>[0]) {
  const { lines } = buildBatchAllocationPreview(input)
  const totalAllocated = input.allocations.reduce((sum, allocation) => sum + allocation.amount, 0)
  const posted = lineBalance(lines.map((line) => ({ debit_amount: line.debit, credit_amount: line.credit })))
  return {
    previewData: { total_allocated: totalAllocated, transaction_amount: input.transaction.amount, expected_lines: lines },
    posted: posted.totalDebit,
  }
}

/** A EUR invoice the ledger carries at 110 000 kr (10 000 EUR at 11). */
const EUR_INVOICE = { currency: 'EUR', exchange_rate: 11, remaining_amount: 10000, total: 10000 }

describe('priceOperation', () => {
  it('prices the three operation types that carry an amount before dispatch', () => {
    expect(priceOperation('create_voucher', { total_debit: 1250.5 })).toBe(1250.5)
    expect(priceOperation('categorize_transaction', { amount: 800 })).toBe(800)
    expect(priceOperation('create_supplier_invoice_from_inbox', { total: 4000 })).toBe(4000)
  })

  it('reads jsonb numerics that arrive as strings', () => {
    // preview_data is jsonb; numeric-typed values round-trip as strings often
    // enough that a bare `> limit` comparison would silently compare text.
    expect(priceOperation('create_voucher', { total_debit: '99999.99' })).toBe(99999.99)
  })

  it('uses the magnitude, so a credit-side negative cannot slip under the ceiling', () => {
    expect(priceOperation('categorize_transaction', { amount: -25000 })).toBe(25000)
  })

  it('prices every settlement and batch path that posts money', () => {
    // These were left unpriced in the first cut, on the assumption their
    // totals only existed inside SQL at dispatch. Production says otherwise:
    // each field below is present and numeric on 100% of that type's staged
    // rows, because it is the number a human is shown when approving. Leaving
    // them unpriced let a key with a ceiling post any amount through the four
    // largest settlement paths.
    expect(priceOperation('link_transaction_journal_entry', { transaction_amount: 12500 })).toBe(12500)
    expect(priceOperation('bulk_book_transactions', { tx_sum: 88000 })).toBe(88000)
    expect(priceOperation('link_supplier_invoice_voucher', { payment_amount: 4300 })).toBe(4300)
    expect(priceOperation('match_batch_allocate', { total_allocated: 99000 })).toBe(99000)
    expect(priceOperation('mark_invoice_paid', { total: 6250 })).toBe(6250)
  })

  it('prices a batch allocation staged without lines on its bank amount or its invoices, whichever is larger', () => {
    // Supplier payment: allocations + fees + supplier debts = |transaction_amount|.
    // The debt row (244x, no invoice) is far larger than the invoice.
    expect(
      priceOperation('match_batch_allocate', {
        total_allocated: 1000,
        total_fees: 25,
        total_debts: 50000,
        transaction_amount: -51025,
      }),
    ).toBe(51025)
    // Customer payment net of a fee: the invoices' total is the larger side.
    expect(
      priceOperation('match_batch_allocate', { total_allocated: 1250, total_fees: 50, transaction_amount: 1200 }),
    ).toBe(1250)
    // A row staged without transaction_amount is priced on total_allocated.
    expect(priceOperation('match_batch_allocate', { total_allocated: 99000 })).toBe(99000)
    expect(priceOperation('match_batch_allocate', { transaction_amount: '-4300' })).toBe(4300)
    expect(priceOperation('match_batch_allocate', { total_allocated: null })).toBeNull()
  })

  it('prices a batch allocation on the debit side of the lines it posts, where that is more than both sums', () => {
    // Supplier, kursvinst: the invoice carried at 110 000 kr on 2440, paid
    // with 100 000 kr. D 2440 110 000, C 3960 10 000, C 1930 100 000.
    const supplierGain = stagedBatch({
      transaction: { amount: -100000, date: '2026-11-02' },
      bankAccount: '1930',
      allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: 'si-1', amount: 100000 }],
      invoices: { 'si-1': EUR_INVOICE },
    })
    expect(supplierGain.posted).toBe(110000)
    expect(priceOperation('match_batch_allocate', supplierGain.previewData)).toBe(110000)

    // Customer, kursförlust: carried at 110 000 kr on 1510, 100 000 kr received.
    // D 1930 100 000, D 7960 10 000, C 1510 110 000.
    const customerLoss = stagedBatch({
      transaction: { amount: 100000, date: '2026-11-02' },
      bankAccount: '1930',
      allocations: [{ kind: 'customer_invoice', invoice_id: 'inv-1', amount: 100000 }],
      invoices: { 'inv-1': EUR_INVOICE },
    })
    expect(customerLoss.posted).toBe(110000)
    expect(priceOperation('match_batch_allocate', customerLoss.previewData)).toBe(110000)

    // Öresavrundning: 1 000,40 kr owed, 1 000 kr paid. D 2440 1 000,40, C 3740 0,40.
    const ore = stagedBatch({
      transaction: { amount: -1000, date: '2026-11-02' },
      bankAccount: '1930',
      allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: 'si-2', amount: 1000 }],
      invoices: { 'si-2': { currency: 'SEK', remaining_amount: 1000.4, total: 1000.4 } },
    })
    expect(ore.posted).toBe(1000.4)
    expect(priceOperation('match_batch_allocate', ore.previewData)).toBe(1000.4)

    // Kontantmetoden, one supplier invoice with omvänd betalningsskyldighet:
    // its cost and moms rows post at payment (batch-cash-single-supplier.ts).
    const reverseCharge = [
      { account_number: '4010', debit_amount: 80000, credit_amount: 0 },
      ...generateReverseChargePurchaseLines({ base: 80000, kind: 'domestic_services', basisBase: 0 }),
      { account_number: '1930', debit_amount: 0, credit_amount: 80000 },
    ]
    expect(lineBalance(reverseCharge)).toMatchObject({ totalDebit: 100000, balanced: true })
    expect(
      priceOperation('match_batch_allocate', {
        total_allocated: 80000,
        transaction_amount: -80000,
        expected_lines: reverseCharge.map((line) => ({
          account_number: line.account_number,
          debit: line.debit_amount,
          credit: line.credit_amount,
        })),
      }),
    ).toBe(100000)
  })

  it('prices a batch allocation on its sums when the lines cannot be read', () => {
    // The sums sit below every number a misread of these lines could give (the
    // 7, the 1 500 credit, the figures in the text), so a misread shows in the
    // price instead of hiding under the floor.
    const sums = { total_allocated: 4, total_debts: 1, transaction_amount: -5 }
    for (const expected_lines of [undefined, null, 'D 2440 1500', [], [null, 7, { debit: 'n/a' }], [{ debit: 0, credit: 1500 }]]) {
      expect(priceOperation('match_batch_allocate', { ...sums, expected_lines })).toBe(5)
      // With no sums to fall back on, the row stays unpriced: not priced at 0.
      expect(priceOperation('match_batch_allocate', { expected_lines })).toBeNull()
    }
    // Lines stored with jsonb string numerics are read as numbers.
    expect(
      priceOperation('match_batch_allocate', { ...sums, expected_lines: [{ debit: '1500.25' }, { debit: '0' }] }),
    ).toBe(1500.25)
  })

  it('leaves genuinely unpriceable types unpriced rather than inventing a number', () => {
    // pair_count is a COUNT. Pricing reconciliation_match off it would compare
    // pairs against kronor, which is worse than not enforcing.
    expect(priceOperation('reconciliation_match', { pair_count: 7 })).toBeNull()
    // These attach räkenskapsinformation to something already booked; the
    // transaction_amount they carry is context, not a posting.
    expect(priceOperation('link_document_to_voucher', {})).toBeNull()
    expect(priceOperation('attach_document_to_transaction', { transaction_amount: 999999 })).toBeNull()
  })

  it('has no priceable type whose field is missing from the allowlist', () => {
    // Guards the shape of the allowlist itself: a typo'd field name would make
    // that type silently unpriceable, which is exactly the hole this closes.
    for (const [op, fields] of Object.entries({
      create_voucher: { total_debit: 1 },
      categorize_transaction: { amount: 1 },
      create_supplier_invoice_from_inbox: { total: 1 },
      link_transaction_journal_entry: { transaction_amount: 1 },
      bulk_book_transactions: { tx_sum: 1 },
      link_supplier_invoice_voucher: { payment_amount: 1 },
      match_batch_allocate: { total_allocated: 1 },
      mark_invoice_paid: { total: 1 },
    })) {
      expect(priceOperation(op, fields)).toBe(1)
    }
  })

  it('returns null rather than throwing on malformed preview_data', () => {
    expect(priceOperation('create_voucher', null)).toBeNull()
    expect(priceOperation('create_voucher', undefined)).toBeNull()
    expect(priceOperation('create_voucher', 'not an object')).toBeNull()
    expect(priceOperation('create_voucher', {})).toBeNull()
    expect(priceOperation('create_voucher', { total_debit: 'kr 1 000' })).toBeNull()
    expect(priceOperation('create_voucher', { total_debit: null })).toBeNull()
    expect(priceOperation('create_voucher', { total_debit: Infinity })).toBeNull()
  })
})

describe('exceedsUnattendedLimit', () => {
  const over = {
    actorType: 'api_key',
    limit: 1000,
    operationType: 'create_voucher',
    previewData: { total_debit: 1000.01 },
  }

  it('blocks an api_key commit above its ceiling', () => {
    expect(exceedsUnattendedLimit(over)).toEqual({
      exceeded: true,
      attempted: 1000.01,
      limit: 1000,
    })
  })

  it('allows an amount exactly at the ceiling', () => {
    // The ceiling is inclusive: "may commit up to 1 000 kr" must permit
    // 1 000,00 kr, or every limit is off by one öre in the surprising
    // direction.
    const result = exceedsUnattendedLimit({ ...over, previewData: { total_debit: 1000 } })
    expect(result.exceeded).toBe(false)
  })

  it('blocks an OAuth connector key above its ceiling the same way', () => {
    // The OAuth access token is a minted API key; its commits are labelled
    // mcp_oauth, and the label must not lift the key's ceiling.
    expect(exceedsUnattendedLimit({ ...over, actorType: 'mcp_oauth' }).exceeded).toBe(true)
  })

  it("blocks a service account's key above its ceiling the same way", () => {
    // A service account acts through its own minted keys; being labelled
    // service_account must not lift the key's ceiling either.
    expect(exceedsUnattendedLimit({ ...over, actorType: 'service_account' }).exceeded).toBe(true)
  })

  it('never fires for a human, cron or unattributed commit', () => {
    for (const actorType of ['user', 'cron', 'agent_chat', 'system', undefined]) {
      expect(
        exceedsUnattendedLimit({ ...over, actorType: actorType as string | undefined }).exceeded,
      ).toBe(false)
    }
  })

  it('treats an absent ceiling as unlimited', () => {
    // Every key created before the column existed reads back null here, so
    // this is the default behaviour of the entire installed base.
    for (const limit of [null, undefined]) {
      expect(exceedsUnattendedLimit({ ...over, limit }).exceeded).toBe(false)
    }
  })

  it('treats a nonsensical stored ceiling as unlimited rather than blocking everything', () => {
    // The DB CHECK makes 0 and negatives unstorable, so reaching this branch
    // means something upstream is already wrong. Failing open keeps that bug
    // from presenting as "the agent can no longer book anything".
    for (const limit of [0, -5, Number.NaN]) {
      expect(exceedsUnattendedLimit({ ...over, limit }).exceeded).toBe(false)
    }
  })

  it('fails open when the operation genuinely cannot be priced', () => {
    const result = exceedsUnattendedLimit({
      ...over,
      operationType: 'reconciliation_match',
      previewData: { pair_count: 7 },
    })
    expect(result.exceeded).toBe(false)
    expect(result.attempted).toBeNull()
  })

  it('blocks an over-ceiling batch allocation, the path that used to fail open', () => {
    const result = exceedsUnattendedLimit({
      ...over,
      operationType: 'match_batch_allocate',
      previewData: { total_allocated: 10_000_000 },
    })
    expect(result.exceeded).toBe(true)
    expect(result.attempted).toBe(10_000_000)
  })

  it('blocks a supplier batch whose debt row takes the verifikat over the ceiling', () => {
    const result = exceedsUnattendedLimit({
      ...over,
      operationType: 'match_batch_allocate',
      previewData: { total_allocated: 500, total_debts: 20000, transaction_amount: -20500 },
    })
    expect(result.exceeded).toBe(true)
    expect(result.attempted).toBe(20500)
  })

  it('blocks a batch whose kursdifferens takes the verifikat over the ceiling, both sums under it', () => {
    const { previewData } = stagedBatch({
      transaction: { amount: -100000, date: '2026-11-02' },
      bankAccount: '1930',
      allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: 'si-1', amount: 100000 }],
      invoices: { 'si-1': EUR_INVOICE },
    })
    const result = exceedsUnattendedLimit({ ...over, limit: 105000, operationType: 'match_batch_allocate', previewData })
    expect(result).toEqual({ exceeded: true, attempted: 110000, limit: 105000 })
  })
})

describe('priceOperation: operation-registry writes that move money', () => {
  it('reads a nested preview field by dotted path (a booking verifikat)', () => {
    expect(priceOperation('book_invoice', { journal_entry: { total_debit: 12500 } })).toBe(12500)
    expect(priceOperation('book_supplier_invoice', { journal_entry: { total_debit: 800 } })).toBe(800)
  })

  it('prices a payment file, a bulk booking and utlägg by their totals', () => {
    expect(priceOperation('create_supplier_payment_batch', { total_amount: 45000 })).toBe(45000)
    expect(priceOperation('bulk_book_invoices', { total_debit: 90000 })).toBe(90000)
    expect(priceOperation('create_expense_claim', { amount_sek: 350 })).toBe(350)
    expect(priceOperation('record_expense_payout', { total_sek: 1200 })).toBe(1200)
    expect(priceOperation('match_expense_payout', { total_sek: 1200 })).toBe(1200)
  })

  it('stays unpriced (not enforced) when the nested path is missing', () => {
    expect(priceOperation('book_invoice', { journal_entry: null })).toBeNull()
  })

  it('prices the IB split per project like the inline rättelse it is (#3313)', () => {
    expect(priceOperation('split_opening_balances_per_project', { changed_amount_sek: 182500 })).toBe(182500)
    expect(priceOperation('correct_entry_lines_inline', { changed_amount_sek: 182500 })).toBe(182500)
    expect(
      exceedsUnattendedLimit({
        actorType: 'api_key',
        limit: 10000,
        operationType: 'split_opening_balances_per_project',
        previewData: { changed_amount_sek: 182500 },
      }),
    ).toEqual({ exceeded: true, attempted: 182500, limit: 10000 })
  })
})

describe('priceOperation: attest of a supplier invoice (#124)', () => {
  it('prices the attest by the invoice total in SEK, which releases it for payment', () => {
    // A EUR invoice: total_sek, not the EUR total, is what the ceiling compares.
    const preview = { supplier_invoice_number: 'F-1', total: 1000, currency: 'EUR', total_sek: 11250 }
    expect(priceOperation('approve_supplier_invoice', preview)).toBe(11250)
    expect(
      exceedsUnattendedLimit({ actorType: 'api_key', limit: 10000, operationType: 'approve_supplier_invoice', previewData: preview }),
    ).toEqual({ exceeded: true, attempted: 11250, limit: 10000 })
  })

  it('falls back to total for an attest staged before total_sek, or when no SEK total exists', () => {
    expect(priceOperation('approve_supplier_invoice', { total: 25000, currency: 'SEK' })).toBe(25000)
    expect(priceOperation('approve_supplier_invoice', { total: 25000, currency: 'USD', total_sek: null })).toBe(25000)
  })

  it('never stops a person approving it in the app', () => {
    const previewData = { total: 25000, currency: 'SEK', total_sek: 25000 }
    expect(exceedsUnattendedLimit({ actorType: 'user', limit: 1000, operationType: 'approve_supplier_invoice', previewData }).exceeded).toBe(false)
  })
})
