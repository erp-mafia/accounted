import { describe, expect, it } from 'vitest'
import { createPagedMockSupabase } from '@/tests/helpers'
import { getRegister } from '../register'

const party = (over: Record<string, unknown>) => ({
  org_number: null,
  kind: 'person',
  status: 'confirmed',
  alias_keys: [],
  suggested_reason: null,
  created_at: '2026-01-01',
  archived_at: null,
  origin: 'manual',
  ...over,
})

/**
 * Board members and shareholders entered in the Bolaget registers
 * (origin 'bolaget') are not counterparties: Motparter lists them only once
 * they are a customer or supplier too.
 */
describe('getRegister and the Bolaget registers', () => {
  it('leaves out a register-only person and keeps one who is also a customer', async () => {
    const { supabase } = createPagedMockSupabase({
      parties: [
        party({ id: 'p-board', display_name: 'Anna Ek', origin: 'bolaget' }),
        party({ id: 'p-both', display_name: 'Bo Ek', origin: 'bolaget' }),
        party({ id: 'p-manual', display_name: 'Cia Ek' }),
      ],
      customers: [{ id: 'c-1', party_id: 'p-both' }],
    })
    const register = await getRegister(supabase as never, 'company-1', { view: 'all' })
    expect(register.rows.map((r) => r.id).sort()).toEqual(['p-both', 'p-manual'])
  })
})
