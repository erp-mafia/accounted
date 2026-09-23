import { describe, it, expect } from 'vitest'
import {
  SIGN_RECLASSIFICATION_RULES,
  isInRanges,
  selectReclassifiedAccounts,
  type SignReclassificationId,
} from '../sign-reclassification'

function ruleFor(id: SignReclassificationId) {
  const rule = SIGN_RECLASSIFICATION_RULES.find((r) => r.id === id)
  if (!rule) throw new Error(`missing rule ${id}`)
  return rule
}

const TAX_ACCOUNT = ruleFor('tax_account_credit_to_liability')
const TAX_LIABILITY = ruleFor('tax_liability_debit_to_receivable')
const VAT_LIABILITY = ruleFor('vat_liability_debit_to_receivable')

/** Balances are debit-positive, exactly as the ledger stores them. */
function balances(entries: Record<string, number>): ReadonlyMap<string, number> {
  return new Map(Object.entries(entries))
}

describe('SIGN_RECLASSIFICATION_RULES', () => {
  it('has a unique id per rule', () => {
    const ids = SIGN_RECLASSIFICATION_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('carries a Swedish warning for every rule', () => {
    for (const rule of SIGN_RECLASSIFICATION_RULES) {
      expect(rule.warning.length).toBeGreaterThan(0)
    }
  })
})

describe('isInRanges', () => {
  it('compares account numbers as strings, not as quantities', () => {
    expect(isInRanges('1630', [{ start: '1630', end: '1659' }])).toBe(true)
    expect(isInRanges('1659', [{ start: '1630', end: '1659' }])).toBe(true)
    expect(isInRanges('1629', [{ start: '1630', end: '1659' }])).toBe(false)
    expect(isInRanges('1660', [{ start: '1630', end: '1659' }])).toBe(false)
  })
})

describe('selectReclassifiedAccounts: tax account (deviating_rows)', () => {
  it('reclassifies a skattekonto carrying a credit balance', () => {
    // 1630 with a credit balance is money owed to Skatteverket, not a fordran.
    expect(selectReclassifiedAccounts(TAX_ACCOUNT, balances({ '1630': -22_985 })))
      .toEqual(['1630'])
  })

  it('leaves a skattekonto with a normal debit balance alone', () => {
    expect(selectReclassifiedAccounts(TAX_ACCOUNT, balances({ '1630': 5_000 })))
      .toEqual([])
  })

  it('does not net a momsfordran against a skattekontoskuld', () => {
    // The two settle separately, so only the deviating row moves even though
    // the range nets to a debit.
    const result = selectReclassifiedAccounts(
      TAX_ACCOUNT,
      balances({ '1630': -20_000, '1650': 30_000 }),
    )
    expect(result).toEqual(['1630'])
  })

  it('ignores accounts outside the range', () => {
    expect(selectReclassifiedAccounts(TAX_ACCOUNT, balances({ '1510': -50_000 })))
      .toEqual([])
  })
})

describe('selectReclassifiedAccounts: tax liabilities (net)', () => {
  it('reclassifies when paid F-skatt exceeds the booked tax', () => {
    // 2518 debit 80 000 vs 2512 credit 60 000 nets to a receivable.
    const result = selectReclassifiedAccounts(
      TAX_LIABILITY,
      balances({ '2512': -60_000, '2518': 80_000 }),
    )
    expect(result.sort()).toEqual(['2512', '2518'])
  })

  it('leaves the post alone when the range nets to a liability', () => {
    expect(
      selectReclassifiedAccounts(
        TAX_LIABILITY,
        balances({ '2512': -123_180, '2518': 101_970 }),
      ),
    ).toEqual([])
  })

  it('moves every account in range so the moved rows equal the deviating net', () => {
    const rows = { '2512': -10_000, '2518': 25_000 }
    const moved = selectReclassifiedAccounts(TAX_LIABILITY, balances(rows))
    const movedNet = moved.reduce((sum, acc) => sum + rows[acc as keyof typeof rows], 0)
    // Debit-positive net of the moved rows is the receivable now presented.
    expect(movedNet).toBe(15_000)
  })
})

describe('selectReclassifiedAccounts: VAT accounts (net)', () => {
  it('reclassifies a net input-VAT receivable', () => {
    expect(selectReclassifiedAccounts(VAT_LIABILITY, balances({ '2641': 1_387.5 })))
      .toEqual(['2641'])
  })

  it('leaves a normal net VAT liability alone', () => {
    expect(
      selectReclassifiedAccounts(
        VAT_LIABILITY,
        balances({ '2611': -50_000, '2641': 12_000 }),
      ),
    ).toEqual([])
  })

  it('nets output against input VAT before deciding', () => {
    const result = selectReclassifiedAccounts(
      VAT_LIABILITY,
      balances({ '2611': -10_000, '2641': 12_000 }),
    )
    expect(result.sort()).toEqual(['2611', '2641'])
  })
})

describe('selectReclassifiedAccounts: float noise', () => {
  it('does not reclassify on sub-öre drift', () => {
    expect(selectReclassifiedAccounts(TAX_ACCOUNT, balances({ '1630': -0.001 })))
      .toEqual([])
    expect(selectReclassifiedAccounts(VAT_LIABILITY, balances({ '2641': 0.001 })))
      .toEqual([])
  })

  it('reclassifies a real one-öre deviation', () => {
    expect(selectReclassifiedAccounts(TAX_ACCOUNT, balances({ '1630': -0.01 })))
      .toEqual(['1630'])
  })
})
