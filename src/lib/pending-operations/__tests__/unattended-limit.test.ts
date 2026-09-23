import { describe, expect, it } from 'vitest'
import { exceedsUnattendedLimit, priceOperation } from '../unattended-limit'

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

  it('never fires for a human, cron or unattributed commit', () => {
    for (const actorType of ['user', 'cron', 'mcp_oauth', 'system', undefined]) {
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
})
