import { describe, expect, it } from 'vitest'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import {
  FORM_SEEDED_ACCOUNTS,
  getFormSeededAccount,
  getSeedableAccountReference,
} from '@/lib/bookkeeping/form-accounts'

describe('form-seeded accounts', () => {
  it('lists only accounts that BAS 2026 does not define', () => {
    for (const number of Object.keys(FORM_SEEDED_ACCOUNTS)) {
      expect(getBASReference(number), number).toBeUndefined()
      expect(FORM_SEEDED_ACCOUNTS[number].account_number).toBe(number)
    }
  })

  it('keeps 3901 Medlemsavgifter under BAS group 39 with the INK2R SRU code for övriga rörelseintäkter', () => {
    expect(getFormSeededAccount('3901')).toMatchObject({
      account_name: 'Medlemsavgifter',
      account_class: 3,
      account_group: '39',
      account_type: 'revenue',
      normal_balance: 'credit',
      sru_code: getBASReference('3900')?.sru_code ?? '7413',
    })
  })

  it('prefers BAS 2026 and falls back to the form-seeded list', () => {
    expect(getSeedableAccountReference('1930')?.account_name).toBe(getBASReference('1930')?.account_name)
    expect(getSeedableAccountReference('3901')?.account_name).toBe('Medlemsavgifter')
    expect(getSeedableAccountReference('3902')).toBeUndefined()
  })
})
