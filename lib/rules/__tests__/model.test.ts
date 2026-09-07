import { describe, it, expect } from 'vitest'
import {
  aliasPatterns,
  hitsUntilAuto,
  ruleCategoryAccount,
  ruleDirection,
  ruleOrigin,
  ruleStep,
  ruleThen,
  ruleWhen,
} from '../model'

describe('rules model', () => {
  it('maps template sources to origins the user understands', () => {
    expect(ruleOrigin('user_approved')).toBe('confirmation')
    expect(ruleOrigin('auto_learned')).toBe('repetition')
    expect(ruleOrigin('sie_import')).toBe('import')
    expect(ruleOrigin('sni_default')).toBe('system')
  })

  it('reads the direction from the cash side', () => {
    expect(ruleDirection('6540', '1930')).toBe('out')
    expect(ruleDirection('1930', '3001')).toBe('in')
    expect(ruleDirection('1930', '1940')).toBe('transfer')
    expect(ruleDirection('2440', '6540')).toBe('unknown')
  })

  it('categorises to the non-cash account', () => {
    expect(ruleCategoryAccount({ debit_account: '6540', credit_account: '1930' })).toBe('6540')
    expect(ruleCategoryAccount({ debit_account: '1930', credit_account: '3001' })).toBe('3001')
  })

  it('builds when and then tokens', () => {
    const row = {
      counterparty_name: 'google cloud emea',
      debit_account: '6540',
      credit_account: '1930',
      vat_treatment: 'reverse_charge' as const,
      category: 'expense_software',
    }
    expect(ruleWhen(row)).toEqual([
      { kind: 'counterparty', value: 'google cloud emea' },
      { kind: 'direction', value: 'out' },
    ])
    expect(ruleThen(row)).toEqual([
      { kind: 'account', value: '6540' },
      { kind: 'vat', value: 'reverse_charge' },
      { kind: 'settlement', value: '1930' },
    ])
  })

  it('places modes on the ladder and counts clean hits to auto', () => {
    expect(ruleStep('proposed')).toBe(0)
    expect(ruleStep('propose')).toBe(1)
    expect(ruleStep('paused')).toBe(1)
    expect(ruleStep('auto')).toBe(2)
    expect(hitsUntilAuto({ occurrence_count: 3, corrections: 0 })).toBe(2)
    expect(hitsUntilAuto({ occurrence_count: 8, corrections: 1 })).toBe(0)
    expect(hitsUntilAuto({ occurrence_count: 2, corrections: 3 })).toBe(6)
  })

  it('turns aliases into safe ilike patterns, deduplicated and capped', () => {
    const patterns = aliasPatterns({
      counterparty_name: 'google cloud emea',
      counterparty_aliases: ['GOOGLE CLOUD EMEA', 'google*cloud,(emea)', 'g', 'Google Cloud EMEA Ltd'],
    })
    // ilike is case-insensitive, so the first spelling of each alias survives as written.
    expect(patterns).toEqual(['google cloud emea', 'Google Cloud EMEA Ltd'])
    expect(patterns.every((p) => !/[(),*%]/.test(p))).toBe(true)
  })
})
