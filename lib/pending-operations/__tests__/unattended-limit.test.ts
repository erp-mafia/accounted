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

  it('returns null for operation types whose amount is only known during dispatch', () => {
    // These compute their totals inside SQL. Pricing them here would be a
    // guess, and a wrong guess blocks a legitimate commit.
    expect(priceOperation('match_batch_allocate', { amount: 999999 })).toBeNull()
    expect(priceOperation('link_document_to_voucher', {})).toBeNull()
    expect(priceOperation('bulk_book_transactions', { amount: 500000 })).toBeNull()
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

  it('fails open when the operation cannot be priced before dispatch', () => {
    const result = exceedsUnattendedLimit({
      ...over,
      operationType: 'match_batch_allocate',
      previewData: { amount: 10_000_000 },
    })
    expect(result.exceeded).toBe(false)
    expect(result.attempted).toBeNull()
  })
})
