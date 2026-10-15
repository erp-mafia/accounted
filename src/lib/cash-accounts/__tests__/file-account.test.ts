import { describe, it, expect } from 'vitest'
import {
  fileAccountLabel,
  isFileAccount,
  loadFileAccountMatch,
  matchFileAccount,
  type FileAccountCandidate,
} from '../file-account'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { BankFileAccountIdentity } from '@/lib/import/bank-file/types'

// Invented numbers throughout. Swedish IBAN = SE + 2 check digits + 3-digit
// bank code + a 17-digit account part, which ends with the BBAN (on prod every
// stored Swedish IBAN ends with its stored BBAN). The matcher never checks the
// check digits, so they are arbitrary here.
// Swedbank 8327-9, account 123 456 789-0: BBAN 83279 1234567890.
const SWEDBANK_IBAN = 'SE1280000832791234567890'
// Another account at the same Swedbank clearing.
const SWEDBANK_OTHER_IBAN = 'SE5580000832799876543210'
// Handelsbanken leaves the clearing out of the IBAN: 6789, 123 456 789.
const HANDELSBANKEN_IBAN = 'SE4160000000000123456789'

function row(overrides: Partial<FileAccountCandidate> = {}): FileAccountCandidate {
  return {
    ledger_account: '1930',
    iban: null,
    bban: null,
    clearing_number: null,
    account_number: null,
    currency: 'SEK',
    enabled: true,
    is_primary: false,
    bank_connection_id: null,
    ...overrides,
  }
}

function printed(clearing: string | null, account: string): BankFileAccountIdentity {
  return { iban: null, clearing, account_number: account }
}

describe('isFileAccount', () => {
  it('fixtures are well-formed Swedish IBANs', () => {
    for (const iban of [SWEDBANK_IBAN, SWEDBANK_OTHER_IBAN, HANDELSBANKEN_IBAN]) {
      expect(iban).toMatch(/^SE\d{22}$/)
    }
  })

  it('decides on the IBAN alone when both sides carry one', () => {
    const identity = { iban: SWEDBANK_IBAN, clearing: null, account_number: null }
    expect(isFileAccount(identity, row({ iban: SWEDBANK_IBAN }))).toBe(true)
    expect(isFileAccount(identity, row({ iban: SWEDBANK_OTHER_IBAN }))).toBe(false)
  })

  it('compares IBANs without spaces and case', () => {
    const spaced = SWEDBANK_IBAN.toLowerCase().replace(/(.{4})/g, '$1 ')
    expect(isFileAccount({ iban: SWEDBANK_IBAN, clearing: null, account_number: null }, row({ iban: spaced }))).toBe(true)
  })

  it('matches the clearing and account columns of a Swedbank export to the bank feed IBAN', () => {
    expect(isFileAccount(printed('8327-9', '123 456 789-0'), row({ iban: SWEDBANK_IBAN }))).toBe(true)
  })

  it('accepts a Swedbank clearing printed without its check digit', () => {
    expect(isFileAccount(printed('8327', '1234567890'), row({ iban: SWEDBANK_IBAN }))).toBe(true)
  })

  it('accepts an account number printed without the zero padding the IBAN carries', () => {
    // 83279 + 0012345678 in the IBAN, 12 345 678 on the statement.
    const iban = 'SE9980000832790012345678'
    expect(iban).toMatch(/^SE\d{22}$/)
    expect(isFileAccount(printed('8327-9', '12 345 678'), row({ iban }))).toBe(true)
  })

  it('accepts an account number printed with the clearing in front', () => {
    expect(isFileAccount(printed('8327-9', '8327-9, 123 456 789-0'), row({ iban: SWEDBANK_IBAN }))).toBe(true)
  })

  it('never matches another account at the same clearing', () => {
    expect(isFileAccount(printed('8327-9', '123 456 789-0'), row({ iban: SWEDBANK_OTHER_IBAN }))).toBe(false)
  })

  it('never matches the same account number at another clearing', () => {
    const elsewhere = 'SE1180000810591234567890'
    expect(elsewhere).toMatch(/^SE\d{22}$/)
    expect(isFileAccount(printed('8327-9', '123 456 789-0'), row({ iban: elsewhere }))).toBe(false)
  })

  it('never matches when one digit differs', () => {
    expect(isFileAccount(printed('8327-9', '123 456 789-1'), row({ iban: SWEDBANK_IBAN }))).toBe(false)
  })

  it('reads a one-string number whose clearing the IBAN leaves out (Handelsbanken)', () => {
    expect(isFileAccount(printed(null, '6789 123 456 789'), row({ iban: HANDELSBANKEN_IBAN }))).toBe(true)
  })

  it('matches the BBAN a bank feed stored when the row has no IBAN', () => {
    const identity = { iban: SWEDBANK_IBAN, clearing: null, account_number: null }
    expect(isFileAccount(identity, row({ bban: '832791234567890' }))).toBe(true)
    expect(isFileAccount(printed('8327-9', '123 456 789-0'), row({ bban: '832791234567890' }))).toBe(true)
  })

  it('matches the clearing and account number typed in for invoices', () => {
    const typed = row({ clearing_number: '8327-9', account_number: '123 456 789-0' })
    expect(isFileAccount(printed('8327-9', '1234567890'), typed)).toBe(true)
    expect(isFileAccount({ iban: SWEDBANK_IBAN, clearing: null, account_number: null }, typed)).toBe(true)
  })

  it('never matches a row that carries no number at all (manual, kassa)', () => {
    expect(isFileAccount(printed('8327-9', '123 456 789-0'), row())).toBe(false)
  })

  it('never reads a foreign IBAN as a Swedish number', () => {
    expect(isFileAccount(printed(null, '1234567890'), row({ iban: 'LT121000011234567890' }))).toBe(false)
  })

  it('needs at least seven account digits before the number alone counts', () => {
    // 6789 + 123456 could be anyone's padding; it does not stand for an account.
    const short = 'SE4160000000000000123456'
    expect(isFileAccount(printed(null, '6789 123 456'), row({ iban: short }))).toBe(false)
  })
})

describe('matchFileAccount', () => {
  const identity = printed('8327-9', '123 456 789-0')

  it('returns null without an identity or a matching row', () => {
    expect(matchFileAccount(null, [row({ iban: SWEDBANK_IBAN })])).toBeNull()
    expect(matchFileAccount(identity, [row({ iban: SWEDBANK_OTHER_IBAN })])).toBeNull()
  })

  it('picks the cash account that is the file account, not the 1930 next to it (crm#1204)', () => {
    const rows = [
      row({ ledger_account: '1930', iban: SWEDBANK_OTHER_IBAN, bank_connection_id: 'conn-1' }),
      row({ ledger_account: '1931', iban: SWEDBANK_IBAN, bank_connection_id: 'conn-1', is_primary: true }),
    ]
    expect(matchFileAccount(identity, rows, 'SEK')).toEqual({ ledger_account: '1931', ledger_accounts: ['1931'] })
  })

  it('prefers the bank-fed enabled twin and still allows every twin', () => {
    const rows = [
      row({ ledger_account: '1930', iban: SWEDBANK_IBAN, enabled: false }),
      row({ ledger_account: '1935', iban: SWEDBANK_IBAN, bank_connection_id: 'conn-2' }),
    ]
    expect(matchFileAccount(identity, rows, 'SEK')).toEqual({
      ledger_account: '1935',
      ledger_accounts: ['1935', '1930'],
    })
  })

  it('keeps the other currency pockets of a multi-currency IBAN out', () => {
    const iban = 'LT121000011234567890'
    const rows = [
      row({ ledger_account: '1940', iban, currency: 'EUR', bank_connection_id: 'c' }),
      row({ ledger_account: '1941', iban, currency: 'USD', bank_connection_id: 'c' }),
    ]
    const file = { iban, clearing: null, account_number: null }
    expect(matchFileAccount(file, rows, 'usd')).toEqual({ ledger_account: '1941', ledger_accounts: ['1941'] })
    expect(matchFileAccount(file, rows, 'SEK')).toBeNull()
  })
})

describe('fileAccountLabel', () => {
  it('groups an IBAN by four and prints a domestic number as the file did', () => {
    expect(fileAccountLabel({ iban: 'SE1280000832791234567890', clearing: null, account_number: null }))
      .toBe('SE12 8000 0832 7912 3456 7890')
    expect(fileAccountLabel(printed('8327-9', '123 456 789-0'))).toBe('8327-9, 123 456 789-0')
  })
})

describe('loadFileAccountMatch', () => {
  it('reads the company cash accounts and matches them', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [row({ ledger_account: '1931', iban: SWEDBANK_IBAN })] })

    const match = await loadFileAccountMatch(supabase as never, 'company-1', printed('8327-9', '1234567890'), 'SEK')

    expect(match?.ledger_account).toBe('1931')
    expect(findCall('cash_accounts', 'eq')).toEqual(['company_id', 'company-1'])
  })

  it('reads nothing without an identity and throws on a failed read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    expect(await loadFileAccountMatch(supabase as never, 'company-1', null)).toBeNull()
    expect(supabase.from).not.toHaveBeenCalled()

    enqueue({ error: { message: 'boom' } })
    await expect(
      loadFileAccountMatch(supabase as never, 'company-1', printed('8327-9', '1234567890')),
    ).rejects.toThrow('boom')
  })
})
