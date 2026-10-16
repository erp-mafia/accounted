import { describe, expect, it, vi } from 'vitest'

// A pack that leaves roles out, as a country without a 12 % or 6 % rate
// will: the resolver must refuse those roles, never borrow another pack's.
vi.mock('@/lib/bookkeeping/account-roles/se-bas', () => ({
  SE_BAS_ACCOUNT_ROLES: Object.freeze({ bank: '1930', output_vat_25: '2611' }),
}))

import { AccountRoleError, resolveAccountRole } from '@/lib/bookkeeping/account-roles'

describe('a pack that does not answer every role', () => {
  it('answers the roles it has', () => {
    expect(resolveAccountRole({ jurisdiction: 'SE' }, 'bank')).toBe('1930')
    expect(resolveAccountRole({ jurisdiction: 'SE' }, 'output_vat_25')).toBe('2611')
  })

  it('throws ACCOUNT_ROLE_NOT_IN_PACK for a role it leaves out', () => {
    let error: unknown
    try {
      resolveAccountRole({ jurisdiction: 'SE' }, 'output_vat_12')
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(AccountRoleError)
    expect((error as AccountRoleError).code).toBe('ACCOUNT_ROLE_NOT_IN_PACK')
    expect((error as AccountRoleError).role).toBe('output_vat_12')
    expect((error as AccountRoleError).jurisdiction).toBe('SE')
  })
})
