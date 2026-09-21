import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readBankConfiguration, saveBankAccountSelection } from '../configuration'

function client(data: unknown, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error })
  return { rpc, supabase: { rpc } as unknown as SupabaseClient }
}

describe('checked bank configuration calls', () => {
  it('reads the company-scoped snapshot', async () => {
    const receipt = { token: 'token', connection: { id: 'connection', status: 'active', session_id: 'session', bank_name: 'Bank', accounts_data: [] } }
    const { rpc, supabase } = client(receipt)
    expect(await readBankConfiguration(supabase, 'company', 'connection')).toEqual(receipt)
    expect(rpc).toHaveBeenCalledWith('read_bank_configuration', { p_company_id: 'company', p_connection_id: 'connection' })
  })

  it('creates chart metadata and saves every selection through one checked RPC', async () => {
    const receipt = { status: 'active', accounts: [{ uid: 'a', balance: 50 }] }
    const { rpc, supabase } = client(receipt)
    const selections = [{ uid: 'a', currency: 'SEK', enabled: true, ledger_account: '1930' },
      { uid: 'b', currency: 'EUR', enabled: true, ledger_account: '1932' }, { uid: 'c', currency: 'SEK', enabled: false }]
    expect(await saveBankAccountSelection(supabase, 'company', 'user', 'connection', 'token', selections)).toEqual(receipt)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('save_bank_account_selection', expect.objectContaining({
      p_company_id: 'company', p_user_id: 'user', p_connection_id: 'connection', p_expected_token: 'token', p_selections: selections,
      p_chart_accounts: [
        expect.objectContaining({ account_number: '1930', account_name: 'Företagskonto', company_id: 'company', user_id: 'user', account_type: 'asset' }),
        expect.objectContaining({ account_number: '1932', account_name: 'Bankkonto EUR', normal_balance: 'debit' }),
      ],
    }))
  })

  it.each(['P0002', 'PT409', '42501'])('preserves database error code %s', async code => {
    const { supabase } = client(null, { code, message: 'Database refusal' })
    await expect(readBankConfiguration(supabase, 'company', 'connection')).rejects.toMatchObject({ code })
    await expect(saveBankAccountSelection(supabase, 'company', 'user', 'connection', 'token', [])).rejects.toMatchObject({ code })
  })

  it('refuses absent read and write receipts', async () => {
    const { supabase } = client(null)
    await expect(readBankConfiguration(supabase, 'company', 'connection')).rejects.toThrow('snapshot missing')
    await expect(saveBankAccountSelection(supabase, 'company', 'user', 'connection', 'token', [])).rejects.toThrow('receipt missing')
  })
})
