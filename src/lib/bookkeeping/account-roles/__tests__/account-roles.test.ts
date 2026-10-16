import { describe, expect, it } from 'vitest'
import { BAS_ACCOUNT_NUMBERS } from '@/lib/bookkeeping/bas-account-numbers'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import {
  ACCOUNT_ROLES,
  AccountRoleError,
  PINNED_JURISDICTION,
  isAccountRole,
  resolveAccountRole,
  type AccountRole,
} from '@/lib/bookkeeping/account-roles'
import { SE_BAS_ACCOUNT_ROLES } from '@/lib/bookkeeping/account-roles/se-bas'

const SE = { jurisdiction: 'SE' }

/**
 * The SE pack, spelled out. Each value is the literal the call sites wrote
 * before they asked for the role, with the BAS 2026 name it carries in
 * lib/bookkeeping/bas-data. Changing one changes bookings: it needs its own
 * decision, never a drive-by edit.
 */
const SE_EXPECTED: Record<AccountRole, { account: string; name: string }> = {
  bank: { account: '1930', name: 'Företagskonto' },
  accounts_receivable: { account: '1510', name: 'Kundfordringar' },
  accounts_payable: { account: '2440', name: 'Leverantörsskulder' },
  output_vat_25: { account: '2611', name: 'Utgående moms på försäljning inom Sverige, 25 %' },
  output_vat_12: { account: '2621', name: 'Utgående moms på försäljning inom Sverige, 12 %' },
  output_vat_6: { account: '2631', name: 'Utgående moms på försäljning inom Sverige, 6 %' },
  input_vat: { account: '2641', name: 'Debiterad ingående moms' },
  vat_settlement: { account: '2650', name: 'Redovisningskonto för moms' },
  vat_receivable: { account: '1650', name: 'Momsfordran' },
  rounding: { account: '3740', name: 'Öres- och kronutjämning' },
}

function caught(fn: () => unknown): AccountRoleError {
  try {
    fn()
  } catch (err) {
    if (err instanceof AccountRoleError) return err
    throw err
  }
  throw new Error('expected an AccountRoleError')
}

describe('SE pack', () => {
  it('answers every role, and only the roles', () => {
    expect(Object.keys(SE_BAS_ACCOUNT_ROLES).sort()).toEqual([...ACCOUNT_ROLES].sort())
  })

  it.each(ACCOUNT_ROLES)('%s resolves to its pinned BAS account', (role) => {
    expect(resolveAccountRole(SE, role)).toBe(SE_EXPECTED[role].account)
  })

  it.each(ACCOUNT_ROLES)('%s is a BAS 2026 account with the expected name', (role) => {
    const account = SE_EXPECTED[role].account
    expect(BAS_ACCOUNT_NUMBERS).toContain(account)
    expect(BAS_REFERENCE.find((a) => a.account_number === account)?.account_name).toBe(SE_EXPECTED[role].name)
  })

  it('returns strings, never numbers', () => {
    for (const role of ACCOUNT_ROLES) expect(typeof resolveAccountRole(SE, role)).toBe('string')
  })

  it('is frozen', () => {
    expect(Object.isFrozen(SE_BAS_ACCOUNT_ROLES)).toBe(true)
    expect(Object.isFrozen(PINNED_JURISDICTION)).toBe(true)
  })
})

describe('PINNED_JURISDICTION', () => {
  it('is the jurisdiction companies.jurisdiction is CHECK-pinned to', () => {
    expect(PINNED_JURISDICTION).toEqual({ jurisdiction: 'SE' })
  })

  it('resolves exactly like a company row in that jurisdiction', () => {
    for (const role of ACCOUNT_ROLES) {
      expect(resolveAccountRole(PINNED_JURISDICTION, role)).toBe(resolveAccountRole(SE, role))
    }
  })
})

describe('resolveAccountRole refusals', () => {
  it('throws for a jurisdiction without a pack instead of falling back to Sweden', () => {
    const err = caught(() => resolveAccountRole({ jurisdiction: 'NO' }, 'bank'))
    expect(err.code).toBe('ACCOUNT_ROLE_UNKNOWN_JURISDICTION')
    expect(err.jurisdiction).toBe('NO')
    expect(err.role).toBe('bank')
    expect(err.name).toBe('AccountRoleError')
    expect(err.message).toContain('"NO"')
  })

  it.each(['', 'se', 'toString', '__proto__', 'constructor'])('throws for jurisdiction %j', (jurisdiction) => {
    expect(caught(() => resolveAccountRole({ jurisdiction }, 'bank')).code).toBe('ACCOUNT_ROLE_UNKNOWN_JURISDICTION')
  })

  it('throws for a string that is not a role', () => {
    const err = caught(() => resolveAccountRole(SE, 'cash' as AccountRole))
    expect(err.code).toBe('ACCOUNT_ROLE_UNKNOWN_ROLE')
    expect(err.role).toBe('cash')
  })

  it.each(['toString', '__proto__', 'hasOwnProperty'])('throws for prototype key %j as a role', (role) => {
    expect(caught(() => resolveAccountRole(SE, role as AccountRole)).code).toBe('ACCOUNT_ROLE_UNKNOWN_ROLE')
  })
})

describe('isAccountRole', () => {
  it('accepts every role and nothing else', () => {
    for (const role of ACCOUNT_ROLES) expect(isAccountRole(role)).toBe(true)
    for (const value of ['', 'Bank', 'toString', 1930, null, undefined, {}]) expect(isAccountRole(value)).toBe(false)
  })
})
