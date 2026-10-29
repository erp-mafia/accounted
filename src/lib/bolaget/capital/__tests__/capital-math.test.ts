import { describe, expect, it } from 'vitest'
import { dividendExceedsFreeEquity } from '@/lib/bokslut/arsredovisning/dividend-equity'
import { splitDividend, type DividendHolder } from '../dividend-math'
import { deriveFamansforetag } from '../famans'
import {
  contributionLines,
  contributionRepaymentLines,
  dividendDecisionLines,
  dividendPayoutLines,
  fondemissionLines,
  linesBalance,
  minskningLines,
  nyemissionPaymentLines,
  nyemissionRegistrationLines,
} from '../postings'
import { minskningTargetAccount } from '../types'

const A = 'class-a'
const B = 'class-b'
const holder = (party_id: string, a: number, b = 0): DividendHolder => ({
  party_id,
  by_class: [
    { share_class_id: A, code: 'A', shares: a },
    ...(b > 0 ? [{ share_class_id: B, code: 'B', shares: b }] : []),
  ],
})

describe('splitDividend', () => {
  it('pays amount per share times shares, and the total is the sum to the öre', () => {
    const split = splitDividend([holder('p1', 600), holder('p2', 400)], { kind: 'per_share', amount_per_share: 12.345 }, null)
    expect(split.rows).toEqual([
      { party_id: 'p1', share_count: 600, amount: 7407, by_class: [{ share_class_id: A, code: 'A', shares: 600 }] },
      { party_id: 'p2', share_count: 400, amount: 4938, by_class: [{ share_class_id: A, code: 'A', shares: 400 }] },
    ])
    expect(split.total).toBe(12345)
    expect(split.total_shares).toBe(1000)
  })

  it('splits a total by largest remainder so the parts always sum to the total', () => {
    const split = splitDividend([holder('p1', 1), holder('p2', 1), holder('p3', 1)], { kind: 'total', total: 100 }, null)
    expect(split.rows.map((r) => r.amount)).toEqual([33.34, 33.33, 33.33])
    expect(split.rows.reduce((n, r) => n + r.amount * 100, 0)).toBe(10000)
    expect(split.total).toBe(100)
  })

  it('gives the leftover öre to the largest fractions, ties to the larger holding then party id', () => {
    // 10 öre over 3 holders of 1, 1 and 2 shares: exact parts 2.5, 2.5 and 5 öre.
    const split = splitDividend([holder('p2', 1), holder('p1', 1), holder('p3', 2)], { kind: 'total', total: 0.1 }, null)
    const byParty = Object.fromEntries(split.rows.map((r) => [r.party_id, r.amount]))
    expect(byParty).toEqual({ p1: 0.03, p2: 0.02, p3: 0.05 })
  })

  it('counts only the classes the dividend covers', () => {
    const split = splitDividend([holder('p1', 100, 900), holder('p2', 0, 100)], { kind: 'per_share', amount_per_share: 1 }, [A])
    expect(split.rows).toEqual([{ party_id: 'p1', share_count: 100, amount: 100, by_class: [{ share_class_id: A, code: 'A', shares: 100 }] }])
  })

  it('answers nothing for an empty register', () => {
    expect(splitDividend([], { kind: 'total', total: 1000 }, null)).toEqual({ total: 0, total_shares: 0, amount_per_share: null, rows: [] })
  })

  it('keeps large totals exact', () => {
    const split = splitDividend([holder('p1', 333_333), holder('p2', 666_667)], { kind: 'total', total: 9_999_999.99 }, null)
    expect(Math.round(split.rows.reduce((n, r) => n + r.amount, 0) * 100)).toBe(999_999_999)
  })
})

describe('dividendExceedsFreeEquity (shared with AR-DIVIDEND-EXCEEDS-EQUITY)', () => {
  it('compares in whole öre', () => {
    expect(dividendExceedsFreeEquity(100_000, 100_000)).toBe(false)
    expect(dividendExceedsFreeEquity(100_000.01, 100_000)).toBe(true)
    expect(dividendExceedsFreeEquity(0.1 + 0.2, 0.3)).toBe(false)
    expect(dividendExceedsFreeEquity(0, -5)).toBe(false)
    expect(dividendExceedsFreeEquity(1, -5)).toBe(true)
  })
})

describe('deriveFamansforetag', () => {
  it('is a fåmansföretag when four or fewer holders have more than half of the votes', () => {
    expect(deriveFamansforetag([{ party_id: 'a', votes: 1000 }]).derived).toBe(true)
    const many = Array.from({ length: 10 }, (_, i) => ({ party_id: `p${i}`, votes: 100 }))
    const derivation = deriveFamansforetag(many)
    expect(derivation).toEqual({ derived: false, top_four_votes_pct: 40, holders: 10 })
    expect(deriveFamansforetag([...many, { party_id: 'big', votes: 2000 }]).derived).toBe(true)
  })

  it('is not one at exactly half', () => {
    expect(deriveFamansforetag([...Array.from({ length: 4 }, (_, i) => ({ party_id: `a${i}`, votes: 25 })), ...Array.from({ length: 4 }, (_, i) => ({ party_id: `b${i}`, votes: 25 }))]).derived).toBe(false)
  })

  it('answers no for an empty register', () => {
    expect(deriveFamansforetag([]).derived).toBe(false)
  })
})

describe('capital postings', () => {
  const cases = {
    'dividend decision from 2098': dividendDecisionLines('2098', 12345.67),
    'dividend decision from 2091': dividendDecisionLines('2091', 0.01),
    'dividend payout': dividendPayoutLines('1930', 12345.67),
    'ovillkorat tillskott': contributionLines('1930', 50_000, false),
    'villkorat tillskott promised': contributionLines('1685', 50_000, true),
    'repayment of a villkorat tillskott': contributionRepaymentLines('1930', 10_000),
    'nyemission payment with överkurs': nyemissionPaymentLines('1930', 2_500, 97_500),
    'nyemission payment at kvotvärde': nyemissionPaymentLines('1930', 2_500, 0),
    'nyemission registration': nyemissionRegistrationLines(2_500),
    fondemission: fondemissionLines('2091', 25_000),
    'minskning to a free fund': minskningLines(minskningTargetAccount('fri_fond'), 10_000),
    'minskning repaid to holders': minskningLines(minskningTargetAccount('aterbetalning'), 10_000),
  }

  for (const [name, lines] of Object.entries(cases)) {
    it(`${name}: balances, both sides above zero, account numbers as strings`, () => {
      expect(linesBalance(lines)).toBe(true)
      for (const line of lines) {
        expect(typeof line.account_number).toBe('string')
        expect(line.account_number).toMatch(/^\d{4}$/)
        expect(line.debit_amount === 0 || line.credit_amount === 0).toBe(true)
      }
    })
  }

  it('books the decision D source / K 2898 and the payout D 2898 / K bank', () => {
    expect(dividendDecisionLines('2098', 500).map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['2098', 500, 0],
      ['2898', 0, 500],
    ])
    expect(dividendPayoutLines('1940', 500).map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['2898', 500, 0],
      ['1940', 0, 500],
    ])
  })

  it('books a nyemission on 2082 and 2097, and moves 2082 to 2081 on registration', () => {
    expect(nyemissionPaymentLines('1930', 2_500, 97_500).map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1930', 100_000, 0],
      ['2082', 0, 2_500],
      ['2097', 0, 97_500],
    ])
    expect(nyemissionRegistrationLines(2_500).map((l) => l.account_number)).toEqual(['2082', '2081'])
  })

  it('books a tillskott to 2093 and a minskning out of 2081', () => {
    expect(contributionLines('1930', 1, true).map((l) => l.account_number)).toEqual(['1930', '2093'])
    expect(minskningLines('2091', 1).map((l) => l.account_number)).toEqual(['2081', '2091'])
    expect(minskningTargetAccount('forlusttackning')).toBe('2091')
    expect(minskningTargetAccount('aterbetalning')).toBe('2890')
  })

  it('refuses an empty posting as unbalanced', () => {
    expect(linesBalance(dividendDecisionLines('2098', 0))).toBe(false)
  })
})
