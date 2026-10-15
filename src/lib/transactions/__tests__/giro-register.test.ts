import { describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { loadGiroRegister } from '../giro-register'

describe('loadGiroRegister', () => {
  it('reads the own giro from settings and cash accounts, and the supplier cards with a giro', async () => {
    const { supabase, findCalls } = createTableMockSupabase({
      company_settings: { data: { bankgiro: '123-4566', plusgiro: null } },
      cash_accounts: { data: [{ bankgiro: null, plusgiro: '12345-5' }] },
      suppliers: { data: [{ id: 's1', name: 'Leverantör AB', bankgiro: '999-0003', plusgiro: null }] },
    })
    const register = await loadGiroRegister(supabase as never, 'company-1')
    expect([...register.own.entries()]).toEqual([
      ['1234566', 'bankgiro'],
      ['123455', 'plusgiro'],
    ])
    expect(register.suppliers.get('9990003')).toEqual({ scheme: 'bankgiro', names: ['Leverantör AB'] })
    for (const table of ['company_settings', 'cash_accounts', 'suppliers']) {
      expect(findCalls(table, 'eq')).toEqual([['company_id', 'company-1']])
    }
  })

  it('leaves a part empty when its read fails: no reading is never an error', async () => {
    const denied = { data: null, error: { message: 'denied' } }
    const { supabase } = createTableMockSupabase({ company_settings: denied, cash_accounts: denied, suppliers: denied })
    const register = await loadGiroRegister(supabase as never, 'company-1')
    expect(register.own.size).toBe(0)
    expect(register.suppliers.size).toBe(0)
  })
})
