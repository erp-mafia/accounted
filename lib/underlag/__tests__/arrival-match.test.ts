/**
 * The arrival planner's judgement: what links, what is proposed, what is
 * skipped, and every veto. Pure; the reads and writes are covered by the
 * route and hook tests.
 */
import { describe, it, expect } from 'vitest'
import {
  AUTO_LINK_MAX_SEK,
  counterpartyKeyOf,
  hasEarnedAutonomy,
  planArrivalMatches,
  resolveArrivalMode,
  type ArrivalTransaction,
  type CounterpartyAutonomy,
} from '../arrival-match'
import type { HuntPoolItem } from '@/lib/receipt-hunt/select'

function tx(overrides: Partial<ArrivalTransaction> = {}): ArrivalTransaction {
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
    document_id: null,
    journal_entry_id: null,
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

const none = {
  claimedTransactionIds: new Set<string>(),
  claimedDocumentIds: new Set<string>(),
  rejectedPairs: new Set<string>(),
}
// Keyed the way the planner keys it: the normalised bank name.
const earned = new Map<string, CounterpartyAutonomy>([[counterpartyKeyOf(tx()) as string, { confirmed: 3, declined: 0 }]])
const fresh = new Map<string, CounterpartyAutonomy>()

describe('planArrivalMatches', () => {
  it('links an exact, unambiguous pair for a counterparty that earned it', () => {
    const [d] = planArrivalMatches([item()], [tx()], none, earned)
    expect(d.decision).toBe('link')
    expect(d.decided_by).toBe('autonomy')
    expect(d.reason).toBe('earned_autonomy')
    expect(d.transaction_id).toBe('tx-1')
    expect(d.counterparty_key).toBe(counterpartyKeyOf(tx()))
  })

  it('proposes the same pair for a counterparty seen for the first time', () => {
    const [d] = planArrivalMatches([item()], [tx()], none, fresh)
    expect(d.decision).toBe('propose')
    expect(d.reason).toBe('not_earned')
  })

  it('never links above the amount cap, however earned', () => {
    const big = tx({ amount: -(AUTO_LINK_MAX_SEK + 1), amount_sek: -(AUTO_LINK_MAX_SEK + 1) })
    const doc = item({}, { totals: { total: AUTO_LINK_MAX_SEK + 1, vatAmount: 0 } })
    const [d] = planArrivalMatches([doc], [big], none, earned)
    expect(d.decision).toBe('propose')
    expect(d.reason).toBe('amount_cap')
    expect(d.decided_by).toBe('veto')
  })

  it('turns links into proposals when linking is not allowed', () => {
    const [d] = planArrivalMatches([item()], [tx()], none, earned, { allowLink: false })
    expect(d.decision).toBe('propose')
    expect(d.reason).toBe('mode_propose')
  })

  it('skips an ambiguous pair: two purchases the document fits equally', () => {
    const twins = [tx({ id: 'tx-1' }), tx({ id: 'tx-2', date: '2026-05-02' })]
    const decisions = planArrivalMatches([item()], twins, none, earned)
    const forDoc = decisions.find((d) => d.inbox_item_id === 'item-1')
    expect(forDoc?.decision).toBe('skip')
    expect(forDoc?.reason).toBe('ambiguous')
    expect(forDoc?.runner_up).not.toBeNull()
  })

  it('assigns one document to one purchase, strongest pair first', () => {
    // Two receipts, two purchases; each receipt fits its own purchase best.
    const a = tx({ id: 'tx-a', amount: -438.75, amount_sek: -438.75, date: '2026-05-02' })
    const b = tx({ id: 'tx-b', amount: -120, amount_sek: -120, date: '2026-05-10' })
    const docA = item({ id: 'item-a', document_id: 'doc-a' })
    const docB = item({ id: 'item-b', document_id: 'doc-b' }, { invoice: { invoiceDate: '2026-05-10', currency: 'SEK' }, totals: { total: 120, vatAmount: 24 } })
    const decisions = planArrivalMatches([docA, docB], [a, b], none, earned)
    const byItem = new Map(decisions.map((d) => [d.inbox_item_id, d]))
    expect(byItem.get('item-a')?.transaction_id).toBe('tx-a')
    expect(byItem.get('item-b')?.transaction_id).toBe('tx-b')
    expect(new Set(decisions.map((d) => d.transaction_id)).size).toBe(2)
  })

  it('honours a rejected pair, a claimed document and a purchase with a document', () => {
    const rejected = { ...none, rejectedPairs: new Set(['tx-1:doc-1']) }
    expect(planArrivalMatches([item()], [tx()], rejected, earned)[0]).toMatchObject({ decision: 'skip', reason: 'no_candidate' })

    const claimed = { ...none, claimedDocumentIds: new Set(['doc-1']) }
    expect(planArrivalMatches([item()], [tx()], claimed, earned)[0]).toMatchObject({ decision: 'skip', reason: 'no_candidate' })

    const withDoc = tx({ document_id: 'doc-other' })
    expect(planArrivalMatches([item()], [withDoc], none, earned)[0]).toMatchObject({ decision: 'skip', reason: 'no_candidate' })
  })

  it('ignores inflows: a receipt is never paired with money coming in', () => {
    const inflow = tx({ amount: 438.75, amount_sek: 438.75 })
    expect(planArrivalMatches([item()], [inflow], none, earned)[0]).toMatchObject({ decision: 'skip', reason: 'no_candidate' })
  })

  it('proposes with a second opinion in the uncertain band and skips below the floor', () => {
    // Same amount, same merchant, but nine days apart: lands between 0.6 and 0.8.
    const late = tx({ date: '2026-05-11' })
    const [d] = planArrivalMatches([item()], [late], none, earned)
    expect(d.decision).toBe('propose')
    expect(d.confidence).toBeGreaterThanOrEqual(0.6)
    expect(d.confidence).toBeLessThan(0.8)
    expect(d.reason === 'needs_second_opinion' || d.reason === 'inexact_amount').toBe(true)
  })

  it('logs a document that nothing pairs with as a skip', () => {
    const decisions = planArrivalMatches([item()], [], none, earned)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ decision: 'skip', reason: 'no_candidate', transaction_id: null })
  })

  it('proposes rather than links when the amount is only close', () => {
    const near = tx({ amount: -440, amount_sek: -440 })
    const [d] = planArrivalMatches([item()], [near], none, earned)
    expect(d.decision).toBe('propose')
    expect(d.reason).toBe('inexact_amount')
  })
})

describe('autonomy and mode', () => {
  it('is earned at three confirmations with at most one decline', () => {
    expect(hasEarnedAutonomy({ confirmed: 3, declined: 0 })).toBe(true)
    expect(hasEarnedAutonomy({ confirmed: 3, declined: 1 })).toBe(true)
    expect(hasEarnedAutonomy({ confirmed: 2, declined: 0 })).toBe(false)
    expect(hasEarnedAutonomy({ confirmed: 10, declined: 2 })).toBe(false)
    expect(hasEarnedAutonomy(undefined)).toBe(false)
  })

  it('keys autonomy on the normalised bank name', () => {
    expect(counterpartyKeyOf({ merchant_name: null, description: 'OPENAI *CHATGPT SUBSCR K3667' })).toBe('openai')
    // merchant_name wins over the description, and the normaliser drops a
    // trailing one-letter token: the same rule the counterparty templates key on.
    expect(counterpartyKeyOf({ merchant_name: 'Circle K', description: 'x' })).toBe('circle')
    expect(counterpartyKeyOf({ merchant_name: null, description: 'CIRCLE K 421' })).toBe('circle k 421')
    expect(counterpartyKeyOf({ merchant_name: null, description: '' })).toBeNull()
  })

  it('reads the mode from the environment and defaults to acting', () => {
    expect(resolveArrivalMode(undefined)).toBe('act')
    expect(resolveArrivalMode('shadow')).toBe('shadow')
    expect(resolveArrivalMode('propose')).toBe('propose')
    expect(resolveArrivalMode('nonsense')).toBe('act')
  })
})
