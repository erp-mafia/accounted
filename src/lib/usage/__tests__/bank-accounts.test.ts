import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { countLiveBankAccountsByCompany, liveAccountKeys } from '../bank-accounts'

describe('liveAccountKeys', () => {
  it('keeps only accounts switched on for the company, keyed by IBAN, else BBAN, else uid', () => {
    const keys = liveAccountKeys(
      [
        { uid: 'a', iban: 'se11 0000 1111', enabled: true },
        { uid: 'b', bban: '1234-5', enabled: true },
        { uid: 'c', enabled: true },
        { uid: 'd', iban: 'SE44', enabled: false },
        { uid: 'e', iban: 'SE55' },
        { uid: 'f', iban: 'SE66', enabled: true, mirror_card_account: true },
        { uid: 'g', iban: 'SE77', enabled: true, claimed_by_company_id: 'other' },
        { uid: 'h', iban: 'SE88', enabled: true, claimed_by_company_id: 'c1' },
      ],
      'c1',
    )
    expect([...keys].sort()).toEqual(['1234-5', 'C', 'SE1100001111', 'SE88'].sort())
  })

  it('reads nothing from a row without accounts', () => {
    expect(liveAccountKeys(null, 'c1').size).toBe(0)
    expect(liveAccountKeys({ not: 'an array' }, 'c1').size).toBe(0)
  })
})

describe('countLiveBankAccountsByCompany', () => {
  it('counts each company\'s accounts once across its connections, and leaves out companies with none', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'k1', company_id: 'c1', accounts_data: [{ uid: 'a', iban: 'SE11', enabled: true }] },
        { id: 'k2', company_id: 'c1', accounts_data: [{ uid: 'a2', iban: 'SE11', enabled: true }, { uid: 'b', iban: 'SE22', enabled: true }] },
        { id: 'k3', company_id: 'c2', accounts_data: [{ uid: 'x', iban: 'SE99', enabled: false }] },
        { id: 'k4', company_id: null, accounts_data: [{ uid: 'y', iban: 'SE98', enabled: true }] },
      ],
    })
    expect(await countLiveBankAccountsByCompany(supabase as unknown as SupabaseClient)).toEqual(new Map([['c1', 2]]))
  })
})
