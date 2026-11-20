/**
 * The BAS catalog's "Dölj K2-undantagna" default follows the framework the
 * company reports under. It used to read companySettings.plan_type, a
 * chart_of_accounts column the settings never carry, so it never applied.
 */
import { describe, expect, it } from 'vitest'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-reference'
import {
  currentAccountingFramework,
  hideNotForK2AccountsByDefault,
} from '../not-for-k2-accounts'

describe('currentAccountingFramework', () => {
  it('reads the company framework', () => {
    expect(currentAccountingFramework({ accounting_framework: 'k2' })).toBe('k2')
    expect(currentAccountingFramework({ accounting_framework: 'k3' })).toBe('k3')
  })

  it('is null without a company or with an unknown value', () => {
    expect(currentAccountingFramework(null)).toBeNull()
    expect(currentAccountingFramework(undefined)).toBeNull()
    expect(currentAccountingFramework({ accounting_framework: 'ifrs' as never })).toBeNull()
  })
})

describe('hideNotForK2AccountsByDefault', () => {
  it('hides them for K2 (also the årsbokslut forms, which store k2) and shows them for K3', () => {
    expect(hideNotForK2AccountsByDefault('k2')).toBe(true)
    expect(hideNotForK2AccountsByDefault('k3')).toBe(false)
  })

  it('keeps them visible when the framework is unknown', () => {
    expect(hideNotForK2AccountsByDefault(null)).toBe(false)
  })

  it('hides the K3-only accounts and nothing a K2 company books every day', () => {
    const hidden = new Set(BAS_REFERENCE.filter((a) => a.k2_excluded).map((a) => a.account_number))
    for (const account of ['1010', '1370', '2089', '2096', '2240', '8940']) expect(hidden.has(account)).toBe(true)
    for (const account of ['1930', '2440', '2510', '8910', '1220', '1229']) expect(hidden.has(account)).toBe(false)
  })
})
