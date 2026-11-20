/**
 * The two reads of the paying account (../payment-accounts.ts for the list
 * every surface shows, ../debtor.ts loadDebtor for every prepare) read the
 * connection's BIC and decide by the same rule, so an account the list calls
 * payable also prepares (crm#1314).
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { loadDebtor } from '../debtor'
import { readPaymentAccounts } from '../payment-accounts'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const OPEN_PAYMENTS_ACCOUNT = 'a0000000-0000-4000-8000-000000000001'
const ENABLE_BANKING_ACCOUNT = 'a0000000-0000-4000-8000-000000000002'
// 971: a Swedish IBAN at a bank outside the clearing and bank-name tables.
const IBAN = 'SE5497100000012345678901'

const rows = [
  {
    id: OPEN_PAYMENTS_ACCOUNT,
    name: 'Företagskonto',
    ledger_account: '1930',
    iban: IBAN,
    currency: 'SEK',
    enabled: true,
    bank_connection: { bank_name: 'Lunar', bic: 'LUNADK2B', affiliated_aspsp_id: null, psu_type: 'business' },
  },
  {
    id: ENABLE_BANKING_ACCOUNT,
    name: 'Sparkonto',
    ledger_account: '1931',
    iban: IBAN,
    currency: 'SEK',
    enabled: true,
    bank_connection: { bank_name: 'Lunar', bic: null, affiliated_aspsp_id: null, psu_type: null },
  },
]

describe('readPaymentAccounts', () => {
  it("lists an account payable by its connection's BIC, and one whose connection stores none as bank_unknown", async () => {
    const mock = createTableMockSupabase({ cash_accounts: { data: rows } })

    const accounts = await readPaymentAccounts(mock.supabase as unknown as SupabaseClient, COMPANY)

    expect(mock.findCall('cash_accounts', 'select')?.[0]).toContain('bank_connections(bank_name, bic, affiliated_aspsp_id, psu_type)')
    expect(accounts.map((a) => ({ id: a.id, payable: a.payable, reason: a.reason }))).toEqual([
      { id: OPEN_PAYMENTS_ACCOUNT, payable: true, reason: null },
      { id: ENABLE_BANKING_ACCOUNT, payable: false, reason: 'bank_unknown' },
    ])
  })
})

describe('readPaymentAccounts: the primary bank account', () => {
  it('reads is_primary and answers it on every account, false where the row says nothing', async () => {
    const mock = createTableMockSupabase({
      cash_accounts: { data: [{ ...rows[0], is_primary: true }, { ...rows[1], is_primary: null }] },
    })

    const accounts = await readPaymentAccounts(mock.supabase as unknown as SupabaseClient, COMPANY)

    expect(mock.findCall('cash_accounts', 'select')?.[0]).toContain('is_primary')
    expect(accounts.map((a) => ({ id: a.id, is_primary: a.is_primary }))).toEqual([
      { id: OPEN_PAYMENTS_ACCOUNT, is_primary: true },
      { id: ENABLE_BANKING_ACCOUNT, is_primary: false },
    ])
  })
})

describe('readPaymentAccounts at a bank the provider does not pay from', () => {
  it('lists the account as not payable with bank_not_supported, which the dialogs name (crm#1424)', async () => {
    const svea = { ...rows[0], iban: 'SE4496600000000012345678', bank_connection: { bank_name: 'Svea Bank', bic: 'SVEASESS', affiliated_aspsp_id: null, psu_type: 'business' } }
    const mock = createTableMockSupabase({ cash_accounts: { data: [svea] } })

    const accounts = await readPaymentAccounts(mock.supabase as unknown as SupabaseClient, COMPANY)

    expect(accounts).toEqual([expect.objectContaining({ bank_name: 'Svea Bank', payable: false, reason: 'bank_not_supported' })])
  })
})

describe('loadDebtor', () => {
  it("prepares from the account the list calls payable, with the connection's BIC on the snapshot", async () => {
    const mock = createTableMockSupabase({ cash_accounts: { data: rows[0] } })

    const debtor = await loadDebtor(mock.supabase as unknown as SupabaseClient, COMPANY, OPEN_PAYMENTS_ACCOUNT)

    expect(mock.findCall('cash_accounts', 'select')?.[0]).toContain('bank_connections(bank_name, bic, affiliated_aspsp_id, psu_type)')
    expect(debtor).toMatchObject({ ok: true, debtor: { iban: IBAN, bic: 'LUNADK2B', bank_name: 'Lunar', psu_type: 'business' } })
  })

  it('refuses the same IBAN on a connection that stores no BIC', async () => {
    const mock = createTableMockSupabase({ cash_accounts: { data: rows[1] } })

    expect(await loadDebtor(mock.supabase as unknown as SupabaseClient, COMPANY, ENABLE_BANKING_ACCOUNT)).toEqual({ ok: false, reason: 'bank_unknown' })
  })

  it('refuses an account at Svea Bank before any order exists, so no prepare starts', async () => {
    const svea = { ...rows[0], iban: 'SE4496600000000012345678', bank_connection: { bank_name: 'Svea Bank', bic: 'SVEASESS', affiliated_aspsp_id: null, psu_type: 'business' } }
    const mock = createTableMockSupabase({ cash_accounts: { data: svea } })

    expect(await loadDebtor(mock.supabase as unknown as SupabaseClient, COMPANY, OPEN_PAYMENTS_ACCOUNT)).toEqual({ ok: false, reason: 'bank_not_supported' })
  })

  it('answers not_found for an account the company does not have', async () => {
    const mock = createTableMockSupabase({ cash_accounts: { data: null } })

    expect(await loadDebtor(mock.supabase as unknown as SupabaseClient, COMPANY, OPEN_PAYMENTS_ACCOUNT)).toEqual({ ok: false, reason: 'not_found' })
  })
})
