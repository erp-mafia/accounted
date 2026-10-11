import { describe, it, expect } from 'vitest'
import { ReconciliationPairSchema, reconciliationLinksBodyFields } from '../schemas'
import { MAX_BANK_ROW_SPLIT, MAX_LINK_REQUEST_ENTRIES } from '../limits'

const ids = (n: number) => Array.from({ length: n }, () => crypto.randomUUID())

/** One bank row split over `n` verifikat. */
const split = (n: number) => ({ external_ids: ids(1), journal_entry_ids: ids(n) })

describe('ReconciliationPairSchema limits', () => {
  it('accepts one bank row split over MAX_BANK_ROW_SPLIT verifikat, with explicit allocations too (crm#1144)', () => {
    const pair = split(MAX_BANK_ROW_SPLIT)
    expect(ReconciliationPairSchema.safeParse(pair).success).toBe(true)
    const allocations = pair.journal_entry_ids.map((id) => ({ journal_entry_id: id, amount: 500 }))
    expect(ReconciliationPairSchema.safeParse({ ...pair, allocations }).success).toBe(true)
  })

  it('refuses a split over one verifikat more', () => {
    expect(ReconciliationPairSchema.safeParse(split(MAX_BANK_ROW_SPLIT + 1)).success).toBe(false)
  })

  it('keeps the outside side of an N:1 pair at 50 rows: only the split was raised', () => {
    expect(ReconciliationPairSchema.safeParse({ external_ids: ids(50), journal_entry_ids: ids(1) }).success).toBe(true)
    expect(ReconciliationPairSchema.safeParse({ external_ids: ids(51), journal_entry_ids: ids(1) }).success).toBe(false)
  })
})

describe('links request total', () => {
  const pairsOf = (count: number) => Array.from({ length: count }, () => split(MAX_BANK_ROW_SPLIT))

  it('accepts MAX_LINK_REQUEST_ENTRIES verifikat across the pairs of one request', () => {
    const count = MAX_LINK_REQUEST_ENTRIES / MAX_BANK_ROW_SPLIT
    expect(reconciliationLinksBodyFields.pairs.safeParse(pairsOf(count)).success).toBe(true)
  })

  it('refuses a request whose pairs name more verifikat than that in all', () => {
    const count = MAX_LINK_REQUEST_ENTRIES / MAX_BANK_ROW_SPLIT + 1
    const result = reconciliationLinksBodyFields.pairs.safeParse(pairsOf(count))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].message).toBe(
      `Högst ${MAX_LINK_REQUEST_ENTRIES} verifikat per anrop, sammanlagt över alla par.`,
    )
  })
})
