import { describe, expect, it } from 'vitest'
import { k3CashFlowFromSummary, k3EquityFromClosingBalances } from '../k3-adapters'
import { runK3PreflightChecks } from '../validate/k3-rules'
import { runPreflightChecks } from '../validate/rules'
import { K3_EQUITY_PREVIOUS_YEAR, makeInput, makeK3Input } from './fixtures'

const codes = (input: ReturnType<typeof makeK3Input>) => runK3PreflightChecks(input).map((issue) => issue.code)

function setRow(input: ReturnType<typeof makeK3Input>, key: string, field: 'current' | 'previous', amount: number) {
  const row = input.k3!.cashFlow!.rows.find((candidate) => candidate.key === key)!
  row[field] = amount
}

describe('runK3PreflightChecks', () => {
  it('passes the fixture: sources real, equity and cash flow tie', () => {
    expect(runK3PreflightChecks(makeK3Input())).toEqual([])
  })

  it('adds nothing for a K2 input', () => {
    expect(runK3PreflightChecks(makeInput())).toEqual([])
  })

  it('leaves the K3 fixture with no error but the AGM date in the whole preflight', () => {
    const result = runPreflightChecks(makeK3Input(), '2026-03-20')
    expect(result.errors).toEqual([])
  })

  it('refuses to file the fallbacks: K2 mapping posts, equity from balances, summary cash flow', () => {
    const input = makeK3Input()
    input.k3!.balanceSheetSource = 'k2_mapping'
    input.k3!.equity = k3EquityFromClosingBalances(input.br)
    input.k3!.cashFlow = k3CashFlowFromSummary({
      lopande: { resultat_efter_finansiella_poster: 151_340, total: 151_340 },
      investerings: { total: 0 },
      finansierings: { delta_lan: -66_340, total: -66_340 },
      total_cash_flow: 85_000,
      reconciliation: { opening_cash_1xxx: 185_000, closing_cash_1xxx: 270_000, is_reconciled: true },
    })
    const issues = runK3PreflightChecks(input)
    expect(issues.map((issue) => issue.code)).toEqual(['ACC-K3-POSTS-SOURCE', 'ACC-K3-EQUITY-SOURCE', 'ACC-K3-KFA-SOURCE'])
    expect(issues.every((issue) => issue.severity === 'error')).toBe(true)
  })

  describe('equity specification', () => {
    it('flags a post whose movements do not reach its closing balance', () => {
      const input = makeK3Input()
      input.k3!.equity.posts[1].movements.resultatdisposition = 30_000
      expect(codes(input)).toEqual(['ACC-K3-EQUITY-TIE'])
    })

    it('flags a closing balance that differs from the balance sheet, and the total', () => {
      const input = makeK3Input()
      const post = input.k3!.equity.posts[1]
      post.closing = 90_000
      post.movements.resultatdisposition = 30_000
      expect(codes(input)).toEqual(['ACC-K3-EQUITY-TIE', 'ACC-K3-EQUITY-TOTAL'])
    })

    it('checks the jämförelseår of a statement of its own, and asks for it', () => {
      const input = makeK3Input()
      input.k3!.equity = { ...input.k3!.equity, placement: 'separate_statement', previous: structuredClone(K3_EQUITY_PREVIOUS_YEAR.posts) }
      expect(codes(input)).toEqual([])
      input.k3!.equity.previous![1].closing = 61_000
      const issues = runK3PreflightChecks(input)
      expect(issues.map((issue) => issue.code)).toEqual(['ACC-K3-EQUITY-TIE', 'ACC-K3-EQUITY-TIE'])
      expect(issues[0].message).toContain('(jämförelseåret)')
      input.k3!.equity.previous = null
      expect(codes(input)).toEqual(['ACC-K3-EQUITY-PREVIOUS'])
    })

    it('flags an opening that differs from last year’s eget kapital', () => {
      const input = makeK3Input()
      const post = input.k3!.equity.posts[0]
      post.opening = 20_000
      post.movements.nyemission = 5_000
      expect(codes(input)).toEqual(['ACC-K3-EQUITY-TOTAL'])
    })
  })

  describe('kassaflödesanalys', () => {
    it('flags a statement that does not reconcile to likvida medel', () => {
      const input = makeK3Input()
      input.k3!.cashFlow!.reconciled = false
      setRow(input, 'likvida_medel_ub', 'current', 271_000)
      expect(codes(input)).toEqual(['ACC-K3-KFA-TIE', 'ACC-K3-KFA-TIE'])
    })

    it('flags lines that do not add up to their subtotal and total', () => {
      const input = makeK3Input()
      setRow(input, 'justeringar_ej_kassaflode', 'current', 21_000)
      const issues = runK3PreflightChecks(input)
      expect(issues.map((issue) => issue.code)).toEqual(['ACC-K3-KFA-SUM'])
      expect(issues[0].message).toContain('Kassaflöde från den löpande verksamheten före förändringar av rörelsekapital')
    })

    it('flags section totals that do not add up to årets kassaflöde', () => {
      const input = makeK3Input()
      setRow(input, 'upptagna_lan', 'current', 1_000)
      setRow(input, 'kassaflode_finansiering', 'current', 1_000)
      const issues = runK3PreflightChecks(input)
      expect(issues.map((issue) => issue.code)).toEqual(['ACC-K3-KFA-SUM'])
      expect(issues[0].message).toContain('årets kassaflöde')
    })

    it('flags a result line that differs from the RR, which the document would tag over', () => {
      const input = makeK3Input()
      setRow(input, 'rorelseresultat', 'current', 150_000)
      setRow(input, 'justeringar_ej_kassaflode', 'current', 24_340)
      expect(codes(input)).toEqual(['ACC-K3-KFA-RESULT'])
    })

    it('checks the comparative year when the statement has one', () => {
      const input = makeK3Input()
      for (const row of input.k3!.cashFlow!.rows) row.previous = 0
      setRow(input, 'rorelseresultat', 'previous', 62_000)
      setRow(input, 'kassaflode_fore_rorelsekapital', 'previous', 62_000)
      setRow(input, 'kassaflode_lopande', 'previous', 62_000)
      setRow(input, 'arets_kassaflode', 'previous', 62_000)
      setRow(input, 'likvida_medel_ib', 'previous', 123_000)
      setRow(input, 'likvida_medel_ub', 'previous', 185_000)
      expect(codes(input)).toEqual([])
      setRow(input, 'kassaflode_lopande', 'previous', 60_000)
      expect(codes(input)).toEqual(['ACC-K3-KFA-SUM', 'ACC-K3-KFA-SUM'])
      setRow(input, 'kassaflode_lopande', 'previous', 62_000)
      setRow(input, 'likvida_medel_ub', 'previous', 184_000)
      expect(codes(input)).toEqual(['ACC-K3-KFA-TIE', 'ACC-K3-KFA-TIE'])
    })

    it('asks nothing of a report without a kassaflödesanalys', () => {
      const input = makeK3Input()
      input.k3!.cashFlow = null
      expect(codes(input)).toEqual([])
    })
  })

  it('requires the redovisningsprinciper and medelantal notes', () => {
    const input = makeK3Input()
    input.noter = input.noter.filter((note) => !/principer|medelantal/i.test(note.title))
    expect(codes(input)).toEqual(['ACC-K3-PRINCIPLES', 'ACC-K3-MEDELANTAL'])
  })
})
