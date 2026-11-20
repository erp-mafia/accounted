import { describe, expect, it } from 'vitest'
import { deferredTaxPosting } from '@/lib/bokslut/tax-provision/deferred-tax'
import { validateBalance } from '@/lib/bookkeeping/engine'
import { adjustmentErrors, K3_RELIEF_RULE_CODES, K3_RELIEF_RULES, transitionLines } from '../transition'

/**
 * The transition voucher (K3 35.11): every adjustment and the opening
 * deferred tax against equity, never through the income statement, and
 * only on balance sheet accounts.
 */

describe('adjustmentErrors', () => {
  it('takes balance sheet accounts outside equity and deferred tax, with an amount and a description', () => {
    expect(adjustmentErrors([{ account_number: '1790', amount: 12_500, description: 'Förutbetald kostnad' }])).toEqual([])
    const errors = adjustmentErrors([
      { account_number: '5010', amount: 1, description: 'Hyra' },
      { account_number: '2091', amount: 1, description: 'Eget kapital' },
      { account_number: '2240', amount: 1, description: 'Skatt' },
      { account_number: '1510', amount: 0, description: ' ' },
    ])
    expect(errors).toHaveLength(5)
    expect(errors[0]).toMatch(/klass 1 och 2/)
    expect(errors[1]).toMatch(/motkontot/)
    expect(errors[2]).toMatch(/beräknas här/)
  })

  // F5: 1010 against 2091 passed, capitalising development that earlier
  // financial reports expensed.
  it('refuses own development on 1010-1019, which K3 35.16 never capitalises at the transition', () => {
    for (const account of ['1010', '1012', '1019']) {
      const errors = adjustmentErrors([{ account_number: account, amount: 300_000, description: 'Utvecklingsutgifter' }])
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatch(/35\.16/)
    }
    expect(adjustmentErrors([{ account_number: '1090', amount: 30_000, description: 'Förvärvad licens' }])).toEqual([])
  })
})

describe('K3_RELIEF_RULES', () => {
  // BFNAR 2012:1 (konsoliderad 2025-12-15), punkt 35.25: "Kapitel 26 behöver
  // inte tillämpas på egetkapitalinstrument som företaget tilldelat före
  // tidpunkten för övergång." The development rule is 35.16, a mandatory
  // exception, not a relief a company picks.
  it('words 35.25 as the share-based payment relief of chapter 26', () => {
    const rule = K3_RELIEF_RULES.find((candidate) => candidate.code === '35.25')
    expect(rule?.label).toMatch(/Kapitel 26/)
    expect(K3_RELIEF_RULE_CODES).not.toContain('35.16')
  })
})

describe('transitionLines', () => {
  it('books the opening deferred tax and each adjustment against equity, balanced', () => {
    const deferred = deferredTaxPosting({ liability: 0, asset: 0 }, 20_600)
    const lines = transitionLines({
      equityAccount: '2091',
      adjustments: [
        { account_number: '1790', amount: 12_500, description: 'Förutbetald hyra' },
        { account_number: '2990', amount: -4_000, description: 'Upplupen kostnad' },
      ],
      deferredTaxLines: deferred.lines,
    })
    expect(lines).toEqual([
      { account_number: '2091', debit_amount: 20_600, credit_amount: 0, line_description: 'Uppskjuten skatt vid övergången till K3' },
      { account_number: '2240', debit_amount: 0, credit_amount: 20_600, line_description: 'Avsättning för uppskjuten skatt' },
      { account_number: '1790', debit_amount: 12_500, credit_amount: 0, line_description: 'Förutbetald hyra' },
      { account_number: '2091', debit_amount: 0, credit_amount: 12_500, line_description: 'Förutbetald hyra' },
      { account_number: '2990', debit_amount: 0, credit_amount: 4_000, line_description: 'Upplupen kostnad' },
      { account_number: '2091', debit_amount: 4_000, credit_amount: 0, line_description: 'Upplupen kostnad' },
    ])
    expect(lines.some((line) => line.account_number === '8940')).toBe(false)
    expect(validateBalance(lines).valid).toBe(true)
  })

  it('lists the relief rules the database accepts', () => {
    expect(K3_RELIEF_RULE_CODES).toEqual(['35.21', '35.22', '35.23', '35.24', '35.25', '35.26', '35.28', '35.29', '35.34'])
  })
})
