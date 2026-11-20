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
  receiptIdentity,
  worthFetching,
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
  claimedDocumentIds: new Set<string>(),
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

  it('never proposes a refund receipt for the purchase it refunds (crm#1779)', () => {
    // The return receipt carries the purchase's amount below zero: money back, never this outflow.
    const refund = item({ id: 'item-refund', document_id: 'doc-refund' }, { documentKind: 'receipt', totals: { total: -438.75, vatAmount: -87.75 } })
    expect(selectProposals([tx()], [refund], noSuppression)).toEqual([])
    const purchase = item({}, { documentKind: 'receipt' })
    expect(selectProposals([tx()], [refund, purchase], noSuppression).map((p) => p.document_id)).toEqual(['doc-1'])
  })

  it('returns nothing when the pool is empty', () => {
    expect(selectProposals([tx()], [], noSuppression)).toEqual([])
  })

  it('never proposes on the prominent-amounts fallback', () => {
    // A bankintyg (documentKind "other", no invoice-style total) whose printed
    // "Insatt belopp" happens to equal a same-day outflow scores 0.85 on the
    // shared matcher, which would clear CERTAIN_CONFIDENCE and skip
    // adjudication, on a pairing that is wrong by construction: the hunt scans
    // outflows only, and "Insatt belopp" labels an inflow. Fallback-scored
    // candidates are for the picker and the agent, never the nightly hunt.
    const bankintyg = item(
      { id: 'item-intyg', document_id: 'doc-intyg' },
      {
        supplier: { name: null },
        totals: { total: null, vatAmount: null },
        documentKind: 'other',
        prominentAmounts: [{ amount: 438.75, label: 'Insatt belopp' }],
      },
    )
    expect(selectProposals([tx()], [bankintyg], noSuppression)).toEqual([])
  })

  it('never proposes on a PROMOTED total either (totalSource prominent)', () => {
    // promoteSingleProminentAmount copies a single prominent amount into
    // totals.total for the editable TOTALT field. That must not smuggle the
    // document past the hunt's fallback exclusion: the provenance stamp
    // demotes it back to fallback-grade in the shared scorer.
    const promoted = item(
      { id: 'item-promoted', document_id: 'doc-promoted' },
      {
        supplier: { name: null },
        totals: { total: 438.75, vatAmount: null },
        totalSource: 'prominent',
        documentKind: 'other',
        prominentAmounts: [{ amount: 438.75, label: 'Insatt belopp' }],
      },
    )
    expect(selectProposals([tx()], [promoted], noSuppression)).toEqual([])
  })

  it('skips a transaction that already has a live proposal', () => {
    const result = selectProposals([tx()], [item()], {
      claimedTransactionIds: new Set(['tx-1']),
      claimedDocumentIds: new Set<string>(),
      rejectedPairs: new Set<string>(),
    })
    expect(result).toEqual([])
  })

  it('never re-proposes a pair a human rejected', () => {
    const result = selectProposals([tx()], [item()], {
      claimedTransactionIds: new Set<string>(),
      claimedDocumentIds: new Set<string>(),
      rejectedPairs: new Set([pairKey('tx-1', 'doc-1')]),
    })
    expect(result).toEqual([])
  })

  it('lets a rejection retire one receipt without retiring the purchase', () => {
    const other = item({ id: 'item-2', document_id: 'doc-2' })
    const result = selectProposals([tx()], [item(), other], {
      claimedTransactionIds: new Set<string>(),
      claimedDocumentIds: new Set<string>(),
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

  // crm#1962: the same seller's other charge, a few kronor off and dated
  // nearer the purchase, outscored the document with the purchase's own sum.
  describe('a sum near the purchase\'s against its own', () => {
    const fee = tx({ id: 'tx-fee', date: '2026-10-19', description: 'EXEMPELBANKEN AVGIFT', merchant_name: 'Exempelbanken', amount: -182, amount_sek: -182 })
    const invoice = (id: string, date: string, total: number) =>
      item({ id, document_id: `doc-${id}` }, {
        supplier: { name: 'Exempelbanken AB' },
        invoice: { invoiceDate: date, currency: 'SEK' },
        totals: { total, vatAmount: 0 },
      })

    it.each([
      ['the near sum dated nearer the purchase', '2026-10-10', '2026-10-19'],
      ['the exact sum dated nearer the purchase', '2026-10-19', '2026-10-10'],
    ])('proposes the exact sum when %s', (_case, exactDate, nearDate) => {
      for (const pool of [
        [invoice('exact', exactDate, 182), invoice('near', nearDate, 185)],
        [invoice('near', nearDate, 185), invoice('exact', exactDate, 182)],
      ]) {
        const result = selectProposals([fee], pool, noSuppression)
        expect(result.map((p) => p.document_id)).toEqual(['doc-exact'])
      }
    })

    it('proposes nothing on a near sum alone, however well name and date agree', () => {
      expect(selectProposals([fee], [invoice('near', '2026-10-19', 185)], noSuppression)).toEqual([])
    })
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

  it('skips compounded salary and tax wording an imported ledger uses (feedback seq 956543)', () => {
    expect(canHaveEmailReceipt('Löneutbetalning: 2026.M.01 - anställd: 1')).toBe(false)
    expect(canHaveEmailReceipt('Lönespecifikation mars')).toBe(false)
    expect(canHaveEmailReceipt('Prel Vinstskatt')).toBe(false)
    expect(canHaveEmailReceipt('Preliminärskatt mars')).toBe(false)
    expect(canHaveEmailReceipt('Prel BG 0000050501055')).toBe(false)
    expect(canHaveEmailReceipt('Överföring till skattekonto')).toBe(false)
    expect(canHaveEmailReceipt('F-skatt september')).toBe(false)
  })

  it('does not mistake an English word starting with "lone" for salary', () => {
    expect(canHaveEmailReceipt('Lonely Planet Kortköp/uttag')).toBe(true)
  })

  it('keeps a supplier invoice paid over bankgiro', () => {
    // This one matched a real emailed invoice; skipping the whole rail would
    // have thrown away the hunt's best hit.
    expect(canHaveEmailReceipt('Kontorsplatser j BG 0000001234567 Bg-bet. via internet')).toBe(true)
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

  it('reads a note on the VAT of a purchase as a purchase, not as tax (trial run 2026-10-28)', () => {
    // Verifikat descriptions shaped like the trial run's: the bank row had no
    // merchant name, so the bookkeeper's note was all the classifier read.
    expect(canHaveEmailReceipt('ANTHROPIC* CLAUDE SUB SAN FRANCISCO · Anthropic Claude Max, prenumeration. Omvänd skattskyldighet.')).toBe(true)
    expect(canHaveEmailReceipt('Flyg SF KLM · KLM flyg Stockholm-USA, tjänsteresa. Utrikes flyg 0% moms. Kvitto saknas i Accounted.')).toBe(true)
    expect(canHaveEmailReceipt('Partners on Booking BV K3667 · Booking.com, logi. Utländsk logi, ingen avdragsgill moms.')).toBe(true)
    expect(canHaveEmailReceipt('OPENAI *CHATGPT SUBSCR K3667 · ChatGPT Pro. 0% debiterad moms: omvänd skattskyldighet.')).toBe(true)
    expect(canHaveEmailReceipt('sj.se K3667 · SJ, tågresa. Persontransport 6% moms.')).toBe(true)
    expect(canHaveEmailReceipt('Hotel at Booking.com K3667 · Hotell, svenskt boende, 12 % moms')).toBe(true)
    expect(canHaveEmailReceipt('VEVOR 2608110 - EU-varor, omvand moms, purchase')).toBe(true)
    expect(canHaveEmailReceipt('Stripe fee. Ej moms')).toBe(true)
    expect(canHaveEmailReceipt('Fortnox, 1 249 kr inkl. moms')).toBe(true)
  })

  it('still skips a payment of VAT or tax that also carries a VAT note', () => {
    expect(canHaveEmailReceipt('Betalning moms')).toBe(false)
    expect(canHaveEmailReceipt('Skattekonto: moms')).toBe(false)
    expect(canHaveEmailReceipt('Moms 2026-09')).toBe(false)
    expect(canHaveEmailReceipt('Skatteverket, omvänd skattskyldighet')).toBe(false)
  })
})

/**
 * The gate before a download. Not the match: the real amount comes out of the
 * PDF afterwards. What matters is that a stated amount is enough on its own,
 * that a vendor needs a plausible date, and that currencies are never
 * converted to make a number agree.
 */
describe('worthFetching', () => {
  const charge = (o: Partial<HuntTransaction> = {}): HuntTransaction =>
    tx({
      description: 'Elgiganten Aktiebolag K3667 Kortköp/uttag',
      // Bank rows usually carry no merchant_name; the descriptor is all there is.
      merchant_name: null,
      amount: -21639,
      currency: 'SEK',
      date: '2026-08-04',
      ...o,
    })

  const doc = (o: Partial<Parameters<typeof worthFetching>[0]> = {}) => ({
    vendor: 'Elgiganten',
    date: '2026-08-03',
    amount: null,
    currency: null,
    ...o,
  })

  it('fetches on a matching amount alone, whatever the date says', () => {
    // An amount that agrees is close to proof. Banks post days late and mail
    // gets forwarded months later, so the date must not be able to veto it.
    expect(
      worthFetching(
        doc({ vendor: null, date: '2025-01-01', amount: 21639, currency: 'SEK' }),
        [charge()],
      ),
    ).toBe(true)
  })

  it('fetches on vendor and a nearby date when the body states no amount', () => {
    // The common case: most receipts state their total only inside the PDF.
    expect(worthFetching(doc(), [charge()])).toBe(true)
  })

  it('does not fetch on a vendor whose date is months away', () => {
    expect(worthFetching(doc({ date: '2026-02-01' }), [charge()])).toBe(false)
  })

  it('fetches a matching vendor that gave no date at all', () => {
    // Missing evidence, not contrary evidence.
    expect(worthFetching(doc({ date: null }), [charge()])).toBe(true)
  })

  it('never converts currency to make an amount agree', () => {
    // 180 EUR really was this charge, but turning it into 2014 SEK is a guess.
    // The vendor path is what rescues this case, so the vendor is cleared too.
    expect(
      worthFetching(
        { vendor: null, date: '2026-06-15', amount: 180, currency: 'EUR' },
        [charge({ description: 'ANTHROPIC* CLAUDE SUB', amount: -2014.32, date: '2026-06-16' })],
      ),
    ).toBe(false)
  })

  it('ignores a document that matches nothing the company is missing', () => {
    expect(
      worthFetching({ vendor: 'Spotify', date: '2026-08-03', amount: 119, currency: 'SEK' }, [
        charge(),
      ]),
    ).toBe(false)
  })
})

describe('worthFetching, on the search that found it', () => {
  it('fetches when the purchase that found the mail is close in time', () => {
    // The bank calls the landlord "Kontorsplatser j BG"; the invoice says
    // "Nordisk Kontorshub AB". The names will never match, but the
    // search that produced this mail was that purchase's own.
    const landlord = tx({
      description: 'Kontorsplatser j BG 0000001234567 Bg-bet. via internet',
      merchant_name: null,
      amount: -15000,
      date: '2026-07-04',
    })
    const invoice = {
      vendor: 'Nordisk Kontorshub AB',
      date: '2026-07-02',
      amount: null,
      currency: null,
    }
    expect(worthFetching(invoice, [landlord])).toBe(false)
    expect(worthFetching(invoice, [landlord], [landlord])).toBe(true)
  })

  it('still refuses when the dates are nowhere near each other', () => {
    const landlord = tx({ description: 'Kontorsplatser j BG', merchant_name: null, amount: -15000, date: '2026-07-04' })
    const stale = { vendor: 'Nordisk Kontorshub AB', date: '2025-11-02', amount: null, currency: null }
    expect(worthFetching(stale, [landlord], [landlord])).toBe(false)
  })
})

describe('a receipt already offered elsewhere', () => {
  it('is not offered again to a second purchase', () => {
    // Caught on a real ledger: one H&M receipt was proposed against a -358
    // purchase, then against a -354 purchase on the next run. Approving both
    // would put the same underlag on two verifikat.
    const result = selectProposals([tx()], [item()], {
      claimedTransactionIds: new Set<string>(),
      claimedDocumentIds: new Set(['doc-1']),
      rejectedPairs: new Set<string>(),
    })
    expect(result).toEqual([])
  })
})

/**
 * What identifies one purchase's paperwork. A mail carries the invoice and the
 * receipt for the same purchase under different names, and the same receipt
 * reaches a second mailbox on another message, so fetching per file filled the
 * pool with identical candidates the matcher then refused to choose between.
 */
describe('receiptIdentity', () => {
  it('collapses the invoice and the receipt for one purchase', () => {
    const d = { vendor: 'Anthropic', amount: 180, currency: 'EUR', date: '2026-06-15', messageId: 'm1' }
    expect(receiptIdentity({ ...d, attachmentName: 'Invoice-E19DBF63-0021.pdf' })).toBe(
      receiptIdentity({ ...d, attachmentName: 'Receipt-2066-0204-8388.pdf' }),
    )
  })

  it('keeps a subscription billing the same amount every month apart', () => {
    // Without the date, July would look like a duplicate of June and be
    // suppressed forever: a permanent, silent loss.
    expect(
      receiptIdentity({ vendor: 'Anthropic', amount: 225, currency: 'EUR', date: '2026-06-15' }),
    ).not.toBe(
      receiptIdentity({ vendor: 'Anthropic', amount: 225, currency: 'EUR', date: '2026-07-15' }),
    )
  })

  it('reads equivalent totals as one amount', () => {
    expect(
      receiptIdentity({ vendor: 'Uber', amount: 0.1 + 0.2, currency: 'SEK', date: '2026-06-01' }),
    ).toBe(receiptIdentity({ vendor: 'Uber', amount: 0.3, currency: 'SEK', date: '2026-06-01' }))
  })

  it('ignores wrapping the matcher already folds away', () => {
    expect(receiptIdentity({ vendor: 'Loopia AB', amount: 388, currency: 'SEK', date: '2026-06-11' })).toBe(
      receiptIdentity({ vendor: 'LOOPIA', amount: 388, currency: 'SEK', date: '2026-06-11' }),
    )
  })

  it('keeps two suppliers apart', () => {
    expect(receiptIdentity({ vendor: 'Loopia', amount: 388, currency: 'SEK', date: '2026-06-11' })).not.toBe(
      receiptIdentity({ vendor: 'Hetzner', amount: 388, currency: 'SEK', date: '2026-06-11' }),
    )
  })

  it('never lets a missing vendor make two documents the same', () => {
    // "invoice.pdf" is what half the world's billing systems attach, so the
    // message has to be part of the identity when there is no vendor.
    expect(
      receiptIdentity({ vendor: null, amount: 500, currency: 'SEK', messageId: 'm1', attachmentName: 'invoice.pdf' }),
    ).not.toBe(
      receiptIdentity({ vendor: '', amount: 500, currency: 'SEK', messageId: 'm2', attachmentName: 'invoice.pdf' }),
    )
  })
})
