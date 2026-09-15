import { describe, expect, it } from 'vitest'
import { toPickerAccounts, type StoredPickerAccount } from '../picker-accounts'

const labels = { account: 'Bankkonto', otherCompany: 'ett annat bolag' }

describe('toPickerAccounts', () => {
  it('keeps an account another company books, and names that company', () => {
    const stored: StoredPickerAccount[] = [
      {
        uid: 'a',
        name: 'ARCIM TECHNOLOGY AB',
        iban: 'SE6380000832798443379915',
        bban: '832798443379915',
        currency: 'SEK',
        enabled: false,
        claimed_by_company_id: 'ed461bc1-dbb5-4568-ae20-9337515878e2',
        claimed_by_company_name: 'Arcim Technology AB',
      },
    ]
    expect(toPickerAccounts(stored, labels)).toEqual([
      {
        uid: 'a',
        name: 'ARCIM TECHNOLOGY AB',
        nr: '832798443379915',
        currency: 'SEK',
        ledger: null,
        balance: null,
        claimedBy: 'Arcim Technology AB',
      },
    ])
  })

  it('a consent where every account is claimed still yields every account (issue #2647)', () => {
    const stored: StoredPickerAccount[] = [
      { uid: 'a', currency: 'SEK', enabled: false, claimed_by_company_id: 'c1', claimed_by_company_name: 'Bolag Ett' },
      { uid: 'b', currency: 'SEK', enabled: false, claimed_by_company_id: 'c2' },
    ]
    const out = toPickerAccounts(stored, labels)
    expect(out).toHaveLength(2)
    expect(out.map((a) => a.claimedBy)).toEqual(['Bolag Ett', 'ett annat bolag'])
    // No name and no product: the fallback label, never an empty pill.
    expect(out.map((a) => a.name)).toEqual(['Bankkonto', 'Bankkonto'])
  })

  it('a flagged account that is enabled here is not labelled as another company\'s', () => {
    // partitionByClaim keeps the same conjunction load-bearing: an account
    // syncing in THIS company must never read as belonging elsewhere, however
    // the flag survived (support SQL, a future writer).
    const stored: StoredPickerAccount[] = [
      { uid: 'a', currency: 'SEK', enabled: true, claimed_by_company_id: 'c1', claimed_by_company_name: 'Bolag Ett' },
    ]
    expect(toPickerAccounts(stored, labels)[0].claimedBy).toBeNull()
  })

  it('free accounts come first, and the bank order holds inside each group', () => {
    const stored: StoredPickerAccount[] = [
      { uid: 'claimed-1', currency: 'SEK', enabled: false, claimed_by_company_id: 'c1' },
      { uid: 'free-1', currency: 'SEK' },
      { uid: 'claimed-2', currency: 'SEK', enabled: false, claimed_by_company_id: 'c2' },
      { uid: 'free-2', currency: 'EUR' },
    ]
    expect(toPickerAccounts(stored, labels).map((a) => a.uid)).toEqual([
      'free-1',
      'free-2',
      'claimed-1',
      'claimed-2',
    ])
  })

  it('reads name, number, currency, ledger and balance the way the pill shows them', () => {
    const stored: StoredPickerAccount[] = [
      { uid: 'a', product: 'Företagskonto', iban: 'SE1234', currency: 'eur', ledger_account: '1932', balance: 12.5 },
      { uid: 'b', name: 'Sparkonto', bban: '999', iban: 'SE9999', currency: 'SEK' },
    ]
    const out = toPickerAccounts(stored, labels)
    expect(out[0]).toMatchObject({ name: 'Företagskonto', nr: 'SE1234', currency: 'EUR', ledger: '1932', balance: 12.5 })
    // BBAN wins over IBAN, and an absent balance stays null rather than 0.
    expect(out[1]).toMatchObject({ nr: '999', ledger: null, balance: null })
  })
})
