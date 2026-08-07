/**
 * The hunt's judgement: which pairing gets proposed, and every reason one does
 * not. Pure, so no database is involved; the reads and the staging write are
 * covered by the cron route test.
 */
import { describe, it, expect } from 'vitest'
import {
  AMBIGUITY_MARGIN,
  HUNT_MIN_CONFIDENCE,
  canHaveEmailReceipt,
  pairKey,
  selectProposals,
  type HuntPoolItem,
  type HuntTransaction,
} from '../select'

function tx(overrides: Partial<HuntTransaction> = {}): HuntTransaction {
  return {
    id: 'tx-1',
    company_id: 'co-1',
    date: '2026-05-02',
    description: 'CIRCLE K 421',
    merchant_name: 'Circle K',
    amount: -438.75,
    currency: 'SEK',
    amount_sek: -438.75,
    exchange_rate: null,
    ...overrides,
  }
}

function item(overrides: Partial<HuntPoolItem> = {}, extraction: Record<string, unknown> = {}): HuntPoolItem {
  return {
    id: 'item-1',
    document_id: 'doc-1',
    extracted_data: {
      supplier: { name: 'Circle K' },
      invoice: { invoiceDate: '2026-05-02', currency: 'SEK' },
      totals: { total: 438.75, vatAmount: 87.75 },
      ...extraction,
    },
    channel_context: null,
    ...overrides,
  }
}

const noSuppression = {
  claimedTransactionIds: new Set<string>(),
  rejectedPairs: new Set<string>(),
}

describe('selectProposals', () => {
  it('proposes an exact same-day match', () => {
    const result = selectProposals([tx()], [item()], noSuppression)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      transaction_id: 'tx-1',
      document_id: 'doc-1',
      inbox_item_id: 'item-1',
    })
    expect(result[0].confidence).toBeGreaterThanOrEqual(HUNT_MIN_CONFIDENCE)
  })

  it('returns nothing when the pool is empty', () => {
    expect(selectProposals([tx()], [], noSuppression)).toEqual([])
  })

  it('skips a transaction that already has a live proposal', () => {
    const result = selectProposals([tx()], [item()], {
      claimedTransactionIds: new Set(['tx-1']),
      rejectedPairs: new Set<string>(),
    })
    expect(result).toEqual([])
  })

  it('never re-proposes a pair a human rejected', () => {
    const result = selectProposals([tx()], [item()], {
      claimedTransactionIds: new Set<string>(),
      rejectedPairs: new Set([pairKey('tx-1', 'doc-1')]),
    })
    expect(result).toEqual([])
  })

  it('lets a rejection retire one receipt without retiring the purchase', () => {
    const other = item({ id: 'item-2', document_id: 'doc-2' })
    const result = selectProposals([tx()], [item(), other], {
      claimedTransactionIds: new Set<string>(),
      rejectedPairs: new Set([pairKey('tx-1', 'doc-1')]),
    })
    expect(result).toHaveLength(1)
    expect(result[0].document_id).toBe('doc-2')
  })

  it('drops a match that clears the shared floor but not the hunt floor', () => {
    // Right merchant, right day, wrong amount (>5% out) scores exactly 0.60:
    // good enough for the picker, where a human compares the two totals side
    // by side, and not good enough to propose unattended. This is the whole
    // reason HUNT_MIN_CONFIDENCE sits above CANDIDATE_MIN_CONFIDENCE, so the
    // case has to be exercised at that exact seam.
    const wrongAmount = item({}, {
      supplier: { name: 'Circle K' },
      invoice: { invoiceDate: '2026-05-02', currency: 'SEK' },
      totals: { total: 500, vatAmount: 0 },
    })
    const result = selectProposals([tx()], [wrongAmount], noSuppression)
    expect(result).toEqual([])
  })

  it('drops a match that fails even the shared floor', () => {
    const weak = item({}, {
      supplier: { name: 'Helt Annat Bolag AB' },
      invoice: { invoiceDate: '2026-01-02', currency: 'SEK' },
      totals: { total: 12_000, vatAmount: 0 },
    })
    expect(selectProposals([tx()], [weak], noSuppression)).toEqual([])
  })

  it('refuses to guess between two equally good receipts', () => {
    // Same merchant, same date, same amount: a duplicate or a split payment.
    // Picking one would be a coin flip presented as a finding.
    const twin = item({ id: 'item-2', document_id: 'doc-2' })
    const result = selectProposals([tx()], [item(), twin], noSuppression)
    expect(result).toEqual([])
  })

  it('proposes the winner when it is clear of the runner-up', () => {
    const weaker = item({ id: 'item-2', document_id: 'doc-2' }, {
      supplier: { name: 'Circle K' },
      invoice: { invoiceDate: '2026-05-05', currency: 'SEK' },
      totals: { total: 500, vatAmount: 0 },
    })
    const result = selectProposals([tx()], [item(), weaker], noSuppression)
    expect(result).toHaveLength(1)
    expect(result[0].document_id).toBe('doc-1')
  })

  it('never spends one receipt on two purchases', () => {
    const first = tx({ id: 'tx-1', amount: -438.75 })
    const second = tx({ id: 'tx-2', amount: -438.75, date: '2026-05-02' })
    const result = selectProposals([first, second], [item()], noSuppression)
    expect(result).toHaveLength(1)
  })

  it('caps a run and takes the largest amounts first', () => {
    const transactions = [
      tx({ id: 'small', amount: -100, description: 'A', merchant_name: 'A' }),
      tx({ id: 'large', amount: -9000, description: 'B', merchant_name: 'B' }),
    ]
    const pool = [
      item({ id: 'i-small', document_id: 'd-small' }, {
        supplier: { name: 'A' },
        invoice: { invoiceDate: '2026-05-02', currency: 'SEK' },
        totals: { total: 100, vatAmount: 0 },
      }),
      item({ id: 'i-large', document_id: 'd-large' }, {
        supplier: { name: 'B' },
        invoice: { invoiceDate: '2026-05-02', currency: 'SEK' },
        totals: { total: 9000, vatAmount: 0 },
      }),
    ]
    const result = selectProposals(transactions, pool, noSuppression, 1)
    expect(result).toHaveLength(1)
    expect(result[0].transaction_id).toBe('large')
  })

  it('ignores an item whose extraction carries no date and no total', () => {
    const blank = item({}, { invoice: { invoiceDate: null, currency: 'SEK' }, totals: { total: null, vatAmount: null } })
    expect(selectProposals([tx()], [blank], noSuppression)).toEqual([])
  })

  it('does not match across currencies on amount alone', () => {
    // 438.75 EUR is not 438.75 SEK. Without a comparable amount the pair must
    // not ride to a high score on merchant + date.
    const euro = item({}, {
      supplier: { name: 'Circle K' },
      invoice: { invoiceDate: '2026-05-02', currency: 'EUR' },
      totals: { total: 438.75, vatAmount: 0 },
    })
    expect(selectProposals([tx()], [euro], noSuppression)).toEqual([])
  })

  it('exposes the margin and floor it enforces', () => {
    expect(HUNT_MIN_CONFIDENCE).toBeGreaterThan(0.6)
    expect(AMBIGUITY_MARGIN).toBeGreaterThan(0)
  })
})

/**
 * Which purchases are worth a mailbox search. Drawn from a provkörning where
 * salary and tax rows, being the largest, consumed the entire search budget.
 */
describe('canHaveEmailReceipt', () => {
  it('skips salary, which no merchant confirms by mail', () => {
    expect(canHaveEmailReceipt('Lön Juli Jakob Överföring via internet')).toBe(false)
  })

  it('skips tax even when the bank has truncated the word', () => {
    // Real row: the statement cuts "skatt" to "skat" at 16 characters.
    expect(canHaveEmailReceipt('Inbetalning skat BG 0000050501055 Bg-bet. via internet')).toBe(false)
    expect(canHaveEmailReceipt('Skatt lön Juni   BG 0000050501055 Bg-bet. via internet')).toBe(false)
  })

  it('keeps a supplier invoice paid over bankgiro', () => {
    // This one matched a real emailed invoice; skipping the whole rail would
    // have thrown away the hunt's best hit.
    expect(canHaveEmailReceipt('Kontorsplatser j BG 0000059142596 Bg-bet. via internet')).toBe(true)
  })

  it('keeps an expense reimbursement, which has a receipt behind it', () => {
    expect(canHaveEmailReceipt('Utlägg Norwegian Överföring via internet')).toBe(true)
  })

  it('keeps ordinary card purchases', () => {
    expect(canHaveEmailReceipt('ANTHROPIC* CLAUDE SUB SAN FRANCISCO Kortköp/uttag')).toBe(true)
    expect(canHaveEmailReceipt('Elgiganten Aktiebolag K3667 Kortköp/uttag')).toBe(true)
  })

  it('hunts a transaction with no description rather than silently dropping it', () => {
    expect(canHaveEmailReceipt(null)).toBe(true)
  })
})
