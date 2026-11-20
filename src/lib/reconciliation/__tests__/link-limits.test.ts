import { describe, it, expect } from 'vitest'
import { BankLinkSchema, MatchBatchSchema } from '@/lib/api/schemas'
import { MAX_ROWS_PER_REQUEST } from '@/lib/lists/collect-pages'
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

describe('one Skatteverket transfer (crm#1297)', () => {
  /** Ärenden Skatteverket takes in one ROT/RUT begäran file (lib/invoices/rot-rut-file.ts). */
  const ARENDEN_PER_BEGARAN = 100
  const batch = (n: number) => ({
    allocations: ids(n).map((invoice_id) => ({ kind: 'customer_invoice' as const, invoice_id, amount: 500 })),
  })

  it('pays three bundled begäran, one invoice per buyer, in one batch match', () => {
    expect(MatchBatchSchema.safeParse(batch(3 * ARENDEN_PER_BEGARAN)).success).toBe(true)
  })

  it('keeps a full batch verifikat readable in one select: two lines per invoice and the bank line', () => {
    expect(2 * MAX_BANK_ROW_SPLIT + 1).toBeLessThanOrEqual(MAX_ROWS_PER_REQUEST)
    expect(2 * (MAX_BANK_ROW_SPLIT + 1) + 1).toBeGreaterThan(MAX_ROWS_PER_REQUEST)
  })

  it('holds one cap on every door: the batch match and the bank link', () => {
    expect(MatchBatchSchema.safeParse(batch(MAX_BANK_ROW_SPLIT)).success).toBe(true)
    expect(MatchBatchSchema.safeParse(batch(MAX_BANK_ROW_SPLIT + 1)).success).toBe(false)
    const link = (n: number) => ({
      transaction_id: crypto.randomUUID(),
      allocations: ids(n).map((journal_entry_id) => ({ journal_entry_id, amount: 500 })),
    })
    expect(BankLinkSchema.safeParse(link(MAX_BANK_ROW_SPLIT)).success).toBe(true)
    expect(BankLinkSchema.safeParse(link(MAX_BANK_ROW_SPLIT + 1)).success).toBe(false)
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
