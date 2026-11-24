import { describe, it, expect } from 'vitest'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { getAccountName } from '@/lib/bookkeeping/client-account-names'

describe('client account display names', () => {
  // 6211 was labelled "Mobiltelefon", which is BAS 2026's name for 6212, so a
  // mobile plan booked on the landline account looked right on screen. An
  // account is shown with its BAS name or as the bare number, never with
  // another account's name.
  it('names the telephony accounts as BAS 2026 does', () => {
    for (const account of ['6211', '6212']) {
      expect([account, getBASReference(account)?.account_name], account).toContain(getAccountName(account))
    }
    expect(getAccountName('6212')).toBe('Mobiltelefon')
  })
})
