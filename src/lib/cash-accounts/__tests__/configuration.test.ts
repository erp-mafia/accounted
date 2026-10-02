import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readBankConfiguration, saveBankAccountSelection, readBankCallbackConfiguration, finalizeBankCallback } from '../configuration'

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

  it('carries a registered refusal name as the code and keeps unknown names on the SQLSTATE', async () => {
    const save = (error: { code: string; message: string }) =>
      saveBankAccountSelection(client(null, error).supabase, 'company', 'user', 'connection', 'token', [])
    await expect(save({ code: '23514', message: 'CASH_ACCOUNT_KEEPER_IDENTITY_CONFLICT' }))
      .rejects.toMatchObject({ code: 'CASH_ACCOUNT_KEEPER_IDENTITY_CONFLICT', pgCode: '23514' })
    await expect(save({ code: 'PT409', message: 'BANK_CONFIGURATION_CHANGED' }))
      .rejects.toMatchObject({ code: 'BANK_CONFIGURATION_CHANGED', pgCode: 'PT409' })
    await expect(save({ code: '23514', message: 'some_check_constraint' })).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses absent read and write receipts', async () => {
    const { supabase } = client(null)
    await expect(readBankConfiguration(supabase, 'company', 'connection')).rejects.toThrow('snapshot missing')
    await expect(saveBankAccountSelection(supabase, 'company', 'user', 'connection', 'token', [])).rejects.toThrow('receipt missing')
  })
})


describe('checked bank callback calls', () => {
  const input = { companyId: 'company', userId: 'user', connectionId: 'connection', oauthState: 'oauth',
    expectedToken: 'token', sessionId: 'new-session', consentExpires: null, noIbanPairs: {},
    accounts: [{ uid: 'a', currency: 'SEK', enabled: true }, { uid: 'b', currency: 'EUR', enabled: true }],
    mirrors: [{ uid: 'a', ledger_account: '1930', reuse_cash_account_id: null },
      { uid: 'b', ledger_account: '1932', reuse_cash_account_id: 'existing-cash' }] }
  const receipt = { connection: { id: 'connection', company_id: 'company', user_id: 'user', bank_name: 'Bank' },
    old_session_id: 'old-session', accounts: input.accounts, superseded: [{ id: 'old-connection', session_id: 'superseded-session' }] }
  it('reads the exact initiating OAuth attempt and normalizes fresh null metadata', async () => {
    const { rpc, supabase } = client({ token: 'token', connection: { id: 'connection', accounts_data: null } })
    expect((await readBankCallbackConfiguration(supabase, 'company', 'user', 'connection', 'oauth')).connection.accounts_data).toEqual([])
    expect(rpc).toHaveBeenCalledWith('read_bank_callback_configuration', { p_company_id: 'company', p_user_id: 'user', p_connection_id: 'connection', p_oauth_state: 'oauth' })
  })
  it('sends the snapshot, mirrors and shared chart metadata through one finalizer', async () => {
    const { rpc, supabase } = client(receipt)
    expect(await finalizeBankCallback(supabase, input)).toEqual(receipt)
    expect(rpc).toHaveBeenCalledExactlyOnceWith('finalize_bank_callback', expect.objectContaining({
      p_company_id: 'company', p_user_id: 'user', p_connection_id: 'connection', p_oauth_state: 'oauth',
      p_expected_token: 'token', p_session_id: 'new-session', p_consent_expires: null,
      p_accounts: input.accounts, p_mirrors: input.mirrors, p_no_iban_pairs: {},
      p_chart_accounts: [expect.objectContaining({ account_number: '1930', account_name: 'Företagskonto' }),
        expect.objectContaining({ account_number: '1932', account_name: 'Bankkonto EUR' })],
    }))
  })
  it.each(['PT409', 'P0002', '42501', '22023'])('preserves %s database refusals', async code => {
    const { supabase } = client(null, { message: 'Refused', code })
    await expect(readBankCallbackConfiguration(supabase, 'company', 'user', 'connection', 'oauth')).rejects.toMatchObject({ code })
    await expect(finalizeBankCallback(supabase, input)).rejects.toMatchObject({ code })
  })
  it.each([null, { ...receipt, old_session_id: undefined }, { ...receipt, connection: { ...receipt.connection, company_id: 'other' } },
    { ...receipt, superseded: [{}] }])('refuses malformed finalization receipt %j', async invalid => {
    const { supabase } = client(invalid)
    await expect(finalizeBankCallback(supabase, input)).rejects.toThrow('receipt missing')
  })
  it('refuses a mirror for an unknown account before invoking the database', async () => {
    const { rpc, supabase } = client(receipt)
    await expect(finalizeBankCallback(supabase, { ...input, mirrors: [{ ...input.mirrors[0], uid: 'missing' }] })).rejects.toThrow('mirror account missing')
    expect(rpc).not.toHaveBeenCalled()
  })
  it.each([null, { token: 'token', connection: { id: 'wrong', accounts_data: [] } },
    { token: 'token', connection: { id: 'connection', accounts_data: {} } }])('refuses malformed snapshot %j', async invalid => {
    const { supabase } = client(invalid)
    await expect(readBankCallbackConfiguration(supabase, 'company', 'user', 'connection', 'oauth')).rejects.toThrow('snapshot missing')
  })
})
