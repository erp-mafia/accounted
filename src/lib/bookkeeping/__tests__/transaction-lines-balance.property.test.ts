/**
 * Property: whatever kontering a categorize door builds for a bank row, the
 * lines buildTransactionEntryLines returns balance, or it refuses with a
 * typed error before anyone previews or posts them. The engine's balance
 * check stays the floor; this is what keeps a request from reaching it with
 * lines it must refuse.
 *
 * The grid covers every builder a door uses (category, catalog template,
 * learned single pair, learned line pattern) over amounts in both
 * directions, VAT treatments, the underlag's moms, foreign rows with a
 * stored SEK value or a rate, and VAT registration.
 */
import { describe, expect, it } from 'vitest'
import { makeCategorizationTemplate, makeTransaction } from '@/tests/helpers'
import { buildMappingResultFromCategory } from '../category-mapping'
import { BOOKING_TEMPLATES, buildMappingResultFromTemplate } from '../booking-templates'
import { applyVatAmountOverride } from '../vat-amount-override'
import { buildMappingResultFromCounterpartyTemplate } from '../counterparty-templates'
import { buildTransactionEntryLines } from '../transaction-entries'
import { assertLinesWellFormed, validateBalance } from '../engine'
import {
  InvalidMappingResultError,
  TransactionLinesNotBalancedError,
  TransactionMissingSekValueError,
} from '../errors'
import type {
  CreateJournalEntryLineInput,
  EntityType,
  LinePatternEntry,
  MappingResult,
  Transaction,
  TransactionCategory,
  VatTreatment,
} from '@/types'

type Verdict = 'balanced' | 'unbalanced_refused' | 'other_refusal'

/**
 * The property itself: the lines are ones the engine takes (well formed and
 * balanced), or the builder refused. Lines the engine would refuse for their
 * balance fail the test, which is the bug this file pins.
 */
function verdictOf(transaction: Transaction, mapping: MappingResult): Verdict {
  let lines: CreateJournalEntryLineInput[]
  try {
    lines = buildTransactionEntryLines(transaction, mapping)
  } catch (err) {
    if (err instanceof TransactionLinesNotBalancedError) {
      expect(err.totalDebit).not.toBe(err.totalCredit)
      return 'unbalanced_refused'
    }
    if (err instanceof TransactionMissingSekValueError || err instanceof InvalidMappingResultError) {
      return 'other_refusal'
    }
    throw err
  }
  const balance = validateBalance(lines)
  if (!balance.valid) {
    throw new Error(
      `unbalanced lines were returned: debit ${balance.totalDebit}, credit ${balance.totalCredit}, ` +
      `amount ${transaction.amount} ${transaction.currency}, mapping ${JSON.stringify(mapping)}`,
    )
  }
  return 'balanced'
}

const MAGNITUDES = [0.01, 0.5, 1, 9.99, 99.99, 100, 299, 1250, 1559.84, 7992.16, 11111.84, 12345.67, 999999.99]
const AMOUNTS = MAGNITUDES.flatMap((m) => [m, -m])

/** A row of this amount as each currency shape a bank feed stores. */
function rowsOf(amount: number): Transaction[] {
  return [
    makeTransaction({ amount }),
    // The bank's own settlement amount, at a rate no round number gives.
    makeTransaction({ amount, currency: 'EUR', amount_sek: Math.round(amount * 11.3907 * 100) / 100, exchange_rate: 11.3907 }),
    // A stored SEK value that disagrees with the stored rate: amount_sek wins.
    makeTransaction({ amount, currency: 'USD', amount_sek: Math.round(amount * 10.61 * 100) / 100, exchange_rate: 9.9 }),
    // A rate alone.
    makeTransaction({ amount, currency: 'DKK', amount_sek: null, exchange_rate: 1.4937 }),
    // No SEK value at all: refused, never booked as kronor.
    makeTransaction({ amount, currency: 'CAD', amount_sek: null, exchange_rate: null }),
  ]
}

const ROWS = AMOUNTS.flatMap(rowsOf)

const CATEGORIES: TransactionCategory[] = [
  'income_services', 'income_products', 'income_other',
  'expense_equipment', 'expense_software', 'expense_travel', 'expense_representation',
  'expense_bank_fees', 'expense_currency_exchange', 'expense_other', 'expense_education',
  'private', 'uncategorized',
]
const TREATMENTS: (VatTreatment | undefined)[] = [
  undefined, 'standard_25', 'reduced_12', 'reduced_6', 'reverse_charge', 'reverse_charge_domestic', 'export', 'exempt',
]
const ENTITY_TYPES: EntityType[] = ['enskild_firma', 'aktiebolag', 'ideell_forening']
const REGISTRATIONS = [true, false, undefined] as const

/** The underlag's moms as shares of the row: none, small, the 25 % share, too much. */
const VAT_SHARES = [undefined, 0.01, 0.107, 0.2, 0.5]

describe('categorize line builders: balanced lines or a refusal', () => {
  it('a category booking balances on every row, treatment, registration and underlag moms', () => {
    let built = 0
    for (const row of ROWS) {
      for (const category of CATEGORIES) {
        for (const treatment of TREATMENTS) {
          for (const registered of REGISTRATIONS) {
            for (const share of VAT_SHARES) {
              for (const isBusiness of [true, false]) {
                const vatAmount = share === undefined ? undefined : Math.round(Math.abs(row.amount) * share * 100) / 100
                let mapping: MappingResult
                try {
                  mapping = buildMappingResultFromCategory(
                    category, row, isBusiness, 'aktiebolag', treatment, vatAmount, registered,
                    treatment === 'reverse_charge' ? 'eu_goods' : undefined,
                  )
                } catch {
                  // The builder refused the underlag's moms (TX_CATEGORIZE_INVALID_VAT_AMOUNT).
                  continue
                }
                // A single pair nets its moms against the bank line: it never
                // needs the balance refusal.
                expect(verdictOf(row, mapping)).not.toBe('unbalanced_refused')
                built += 1
              }
            }
          }
        }
      }
    }
    expect(built).toBeGreaterThan(10_000)
  // Tens of thousands of builds in one test: past the default 5 s on a loaded CI runner.
  }, 30_000)

  it('every catalog template balances on every row, with and without the underlag moms', () => {
    let built = 0
    for (const row of ROWS) {
      for (const template of BOOKING_TEMPLATES) {
        for (const entityType of ENTITY_TYPES) {
          for (const registered of REGISTRATIONS) {
            const mapping = buildMappingResultFromTemplate(template, row, entityType, registered)
            expect(verdictOf(row, mapping)).not.toBe('unbalanced_refused')
            built += 1
            try {
              const withVat = applyVatAmountOverride(
                mapping, row, template.vat_treatment, Math.round(Math.abs(row.amount) * 0.11 * 100) / 100,
              )
              expect(verdictOf(row, withVat)).not.toBe('unbalanced_refused')
            } catch {
              // No rate-based moms line to replace on this template and row.
            }
          }
        }
      }
    }
    expect(built).toBeGreaterThan(10_000)
  }, 30_000)

  it('a learned single pair balances in the learned direction and mirrored', () => {
    const pairs = [
      { debit_account: '6200', credit_account: '1930', vat_account: '2641' },
      { debit_account: '1930', credit_account: '3001', vat_account: '2611' },
      { debit_account: '3001', credit_account: '1930', vat_account: '2611' },
      { debit_account: '4010', credit_account: '2440', vat_account: null },
      { debit_account: '1930', credit_account: '1940', vat_account: null },
      { debit_account: '2013', credit_account: '1930', vat_account: null },
      { debit_account: '5420', credit_account: '1930', vat_account: '2645' },
    ]
    for (const row of ROWS) {
      for (const pair of pairs) {
        for (const treatment of ['standard_25', 'reduced_12', 'reduced_6', 'reverse_charge', 'exempt', null] as (VatTreatment | null)[]) {
          for (const registered of REGISTRATIONS) {
            const template = makeCategorizationTemplate({ ...pair, vat_treatment: treatment })
            const mapping = buildMappingResultFromCounterpartyTemplate(
              { template, matchMethod: 'exact_alias', confidence: 0.9 }, row, 'aktiebolag', registered,
            )
            expect(verdictOf(row, mapping)).not.toBe('unbalanced_refused')
          }
        }
      }
    }
  })
})

// ── Learned line patterns ────────────────────────────────────────────────

const match = (pattern: LinePatternEntry[], settles: 'credit' | 'debit' = 'credit') => ({
  template: makeCategorizationTemplate({
    line_pattern: pattern,
    debit_account: settles === 'credit' ? '5010' : '1930',
    credit_account: settles === 'credit' ? '1930' : '3001',
    vat_treatment: null,
    vat_account: null,
  }),
  matchMethod: 'exact_alias' as const,
  confidence: 0.9,
})

const patternVerdict = (pattern: LinePatternEntry[], row: Transaction, registered: boolean | undefined = true) =>
  verdictOf(row, buildMappingResultFromCounterpartyTemplate(match(pattern), row, 'aktiebolag', registered))

/** Patterns as the learners store them from real verifikat: cost and moms on one side. */
const LEARNED_PATTERNS: Record<string, LinePatternEntry[]> = {
  'two cost lines and moms': [
    { account: '5010', type: 'business', side: 'debit', ratio: 0.7 },
    { account: '5020', type: 'business', side: 'debit', ratio: 0.3 },
    { account: '2641', type: 'vat', side: 'debit', vat_rate: 0.25 },
  ],
  'three even cost lines (over-allocating ratios)': [
    { account: '5010', type: 'business', side: 'debit', ratio: 0.3334 },
    { account: '5020', type: 'business', side: 'debit', ratio: 0.3334 },
    { account: '5030', type: 'business', side: 'debit', ratio: 0.3334 },
  ],
  'a sale with moms at two rates': [
    { account: '3001', type: 'business', side: 'credit', ratio: 0.6 },
    { account: '3002', type: 'business', side: 'credit', ratio: 0.4 },
    { account: '2611', type: 'vat', side: 'credit', vat_rate: 0.25 },
    { account: '2621', type: 'vat', side: 'credit', vat_rate: 0.12 },
  ],
  'a cost with a reverse-charge basis pair': [
    { account: '5420', type: 'business', side: 'debit', ratio: 0.3334 },
    { account: '4535', type: 'business', side: 'debit', ratio: 0.3333 },
    { account: '4598', type: 'business', side: 'credit', ratio: 0.3333 },
  ],
  'a cost and a tax line': [
    { account: '4010', type: 'business', side: 'debit', ratio: 0.9 },
    { account: '2490', type: 'tax', side: 'debit', ratio: 0.1 },
    { account: '2641', type: 'vat', side: 'debit', vat_rate: 0.12 },
  ],
}

describe('learned line patterns: balanced lines or a refusal', () => {
  it.each(Object.keys(LEARNED_PATTERNS))('%s: books balanced in both directions on every row', (name) => {
    for (const row of ROWS) {
      for (const registered of REGISTRATIONS) {
        expect(patternVerdict(LEARNED_PATTERNS[name], row, registered)).not.toBe('unbalanced_refused')
      }
    }
  })

  it('a two-sided pattern books balanced on every row of the sign it was learned on', () => {
    // Tjänstepension with its särskild löneskatt against 2514 (crm#1746): the
    // lines net on debit, so the pattern books money out.
    const pension: LinePatternEntry[] = [
      { account: '7412', type: 'business', side: 'debit', ratio: 0.6731 },
      { account: '7533', type: 'business', side: 'debit', ratio: 0.1634 },
      { account: '2514', type: 'business', side: 'credit', ratio: 0.1635 },
    ]
    for (const row of ROWS.filter((r) => r.amount < 0)) {
      expect(patternVerdict(pension, row)).not.toBe('unbalanced_refused')
    }
    // Money in has no direction to mirror by: refused, never unbalanced lines.
    expect(patternVerdict(pension, makeTransaction({ amount: 5000 }))).toBe('unbalanced_refused')
  })

  it('refuses a two-sided pattern on a row that runs against the side its lines net on', () => {
    // Learned from money in: a sale net of what the counterparty kept. The
    // business lines sit on both sides, so the pattern has no direction to
    // mirror by, and on money out its lines net on the bank's own side.
    const payout: LinePatternEntry[] = [
      { account: '3001', type: 'business', side: 'credit', ratio: 0.86 },
      { account: '6570', type: 'business', side: 'debit', ratio: 0.14 },
    ]
    expect(patternVerdict(payout, makeTransaction({ amount: 1000 }))).toBe('balanced')
    expect(patternVerdict(payout, makeTransaction({ amount: -1000 }))).toBe('unbalanced_refused')
  })

  it('refuses a pattern whose moms line sits opposite its cost lines', () => {
    const pattern: LinePatternEntry[] = [
      { account: '5010', type: 'business', side: 'debit', ratio: 1 },
      { account: '2611', type: 'vat', side: 'credit', vat_rate: 0.25 },
    ]
    expect(patternVerdict(pattern, makeTransaction({ amount: -1000 }))).toBe('unbalanced_refused')
    // The same pattern for a company with no moms lines has nothing opposite.
    expect(patternVerdict(pattern, makeTransaction({ amount: -1000 }), false)).toBe('balanced')
  })

  it('refuses a pattern whose tax line outweighs the cost lines its direction is read from', () => {
    const pattern: LinePatternEntry[] = [
      { account: '6991', type: 'business', side: 'debit', ratio: 0.3 },
      { account: '2420', type: 'tax', side: 'credit', ratio: 0.7 },
    ]
    expect(patternVerdict(pattern, makeTransaction({ amount: -1000 }))).toBe('unbalanced_refused')
  })

  it('refuses a pattern of tax lines alone when its ratios leave a remainder', () => {
    // No business line says which side the remainder belongs on, so the
    // "rounding" line lands opposite the lines it should fill up.
    const pattern: LinePatternEntry[] = [
      { account: '2420', type: 'tax', side: 'debit', ratio: 0.8367 },
    ]
    expect(patternVerdict(pattern, makeTransaction({ amount: -1000 }))).toBe('unbalanced_refused')
    expect(patternVerdict([{ ...pattern[0], ratio: 1 }], makeTransaction({ amount: -1000 }))).toBe('balanced')
  })

  it('names both totals and that the lines came from a line pattern', () => {
    const pattern: LinePatternEntry[] = [
      { account: '3001', type: 'business', side: 'credit', ratio: 0.86 },
      { account: '6570', type: 'business', side: 'debit', ratio: 0.14 },
    ]
    const row = makeTransaction({ amount: -720 })
    const mapping = buildMappingResultFromCounterpartyTemplate(match(pattern), row, 'aktiebolag', true)
    let thrown: unknown
    try {
      buildTransactionEntryLines(row, mapping)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(TransactionLinesNotBalancedError)
    const err = thrown as TransactionLinesNotBalancedError
    expect(err.code).toBe('TX_LINES_NOT_BALANCED')
    expect(err.fromLinePattern).toBe(true)
    expect(err.transactionId).toBe(row.id)
    // The lines net 720 on the credit side, beside a bank credit of 720.
    expect(Math.round((err.totalCredit - err.totalDebit) * 100) / 100).toBe(1440)
  })

  it('any pattern at all, on any row: balanced lines or a refusal, never unbalanced lines', () => {
    // A small deterministic generator (no dependency): the same patterns on
    // every run, wide enough to reach every side, type and rate combination.
    let state = 20261113
    const next = () => {
      state = (state * 1664525 + 1013904223) % 4294967296
      return state / 4294967296
    }
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]
    const business = ['4010', '5010', '5420', '6570', '7010', '7412', '7533', '3001', '3740', '2514', '4535', '4598', '6991']
    const tax = ['2420', '2490']
    const vat = ['2641', '2611', '2621', '2631']
    const seen: Record<Verdict, number> = { balanced: 0, unbalanced_refused: 0, other_refusal: 0 }

    for (let i = 0; i < 6000; i += 1) {
      const count = 1 + Math.floor(next() * 4)
      const weights = Array.from({ length: count }, () => 0.05 + next())
      const total = weights.reduce((sum, w) => sum + w, 0)
      const pattern: LinePatternEntry[] = weights.map((w) => {
        const isTax = next() < 0.15
        return {
          account: pick(isTax ? tax : business),
          type: isTax ? 'tax' : 'business',
          side: next() < 0.7 ? 'debit' : 'credit',
          ratio: Math.round((w / total) * 10000) / 10000,
        }
      })
      const vatLines = Math.floor(next() * 3)
      for (let v = 0; v < vatLines; v += 1) {
        pattern.push({ account: pick(vat), type: 'vat', side: next() < 0.7 ? 'debit' : 'credit', vat_rate: pick([0.25, 0.12, 0.06]) })
      }
      const row = pick(ROWS)
      const settles = next() < 0.5 ? 'credit' : 'debit'
      const mapping = buildMappingResultFromCounterpartyTemplate(
        match(pattern, settles), row, 'aktiebolag', pick(REGISTRATIONS),
      )
      seen[verdictOf(row, mapping)] += 1
    }
    // The generator reaches all three outcomes; none of them is unbalanced lines.
    expect(seen.balanced).toBeGreaterThan(1000)
    expect(seen.unbalanced_refused).toBeGreaterThan(100)
    expect(seen.other_refusal).toBeGreaterThan(100)
  })

  it('returns only lines the engine takes as they are', () => {
    for (const row of ROWS.filter((r) => r.currency !== 'CAD')) {
      const mapping = buildMappingResultFromCounterpartyTemplate(
        match(LEARNED_PATTERNS['two cost lines and moms']), row, 'aktiebolag', true,
      )
      const lines = buildTransactionEntryLines(row, mapping)
      expect(validateBalance(lines).valid).toBe(true)
      // 0,01 kr shares no moms and no second cost line: a zero line is the
      // engine's to refuse, not a balance question.
      if (Math.abs(row.amount) >= 1) expect(() => assertLinesWellFormed(lines)).not.toThrow()
    }
  })
})
