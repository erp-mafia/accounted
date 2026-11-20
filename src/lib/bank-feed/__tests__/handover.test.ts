import { describe, expect, it } from 'vitest'
import { enableBankingRowsTakenOver } from '../handover'

const NAMED = '9f6c1a2b-9c0d-4e8f-8a1b-2c3d4e5f6a7b'
const SAME = '8e6c1a2b-9c0d-4e8f-8a1b-2c3d4e5f6a7b'
const IBAN_A = 'SE8050000000052131234567'
const IBAN_B = 'SE4550000000058398257466'

const eb = (id: string, accounts: Array<{ iban?: string | null; currency?: string; enabled: boolean }>) => ({
  id,
  aggregator: 'enable_banking',
  accounts_data: accounts.map((a, i) => ({ uid: `${id}-${i}`, currency: a.currency ?? 'SEK', iban: a.iban ?? null, enabled: a.enabled })),
})

describe('enableBankingRowsTakenOver', () => {
  it('takes over the row a switch named, whatever it reads', () => {
    expect(enableBankingRowsTakenOver({ reads: [{ iban: IBAN_A, currency: 'SEK' }], replaced: NAMED, live: [eb(NAMED, [{ iban: IBAN_B, enabled: true }])] })).toEqual([NAMED])
    expect(enableBankingRowsTakenOver({ reads: [{ iban: IBAN_A, currency: 'SEK' }], replaced: NAMED, live: [eb(NAMED, [{ iban: null, enabled: true }])] })).toEqual([NAMED])
  })

  it('takes over an Enable Banking row whose every account it reads is now read, the IBAN spaced or cased either way and the currency SEK when unnamed', () => {
    const live = [eb(SAME, [{ iban: 'se80 5000 0000 0521 3123 4567', currency: '', enabled: true }, { iban: IBAN_B, enabled: false }])]
    expect(enableBankingRowsTakenOver({ reads: [{ iban: IBAN_A, currency: 'SEK' }], replaced: null, live })).toEqual([SAME])
  })

  it('keeps a row still reading an account the new connection does not, or one without an IBAN, or in another currency', () => {
    const reads = [{ iban: IBAN_A, currency: 'SEK' }]
    expect(enableBankingRowsTakenOver({ reads, replaced: null, live: [eb(SAME, [{ iban: IBAN_A, enabled: true }, { iban: IBAN_B, enabled: true }])] })).toEqual([])
    expect(enableBankingRowsTakenOver({ reads, replaced: null, live: [eb(SAME, [{ iban: IBAN_A, enabled: true }, { iban: null, enabled: true }])] })).toEqual([])
    expect(enableBankingRowsTakenOver({ reads, replaced: null, live: [eb(SAME, [{ iban: IBAN_A, currency: 'EUR', enabled: true }])] })).toEqual([])
  })

  it('keeps a row that reads nothing, never takes over an Open Payments row, and takes nothing when the new connection reads no IBAN', () => {
    expect(enableBankingRowsTakenOver({ reads: [{ iban: IBAN_A, currency: 'SEK' }], replaced: null, live: [eb(SAME, [{ iban: IBAN_A, enabled: false }])] })).toEqual([])
    const openPayments = { ...eb(SAME, [{ iban: IBAN_A, enabled: true }]), aggregator: 'open_payments' }
    expect(enableBankingRowsTakenOver({ reads: [{ iban: IBAN_A, currency: 'SEK' }], replaced: SAME, live: [openPayments] })).toEqual([])
    expect(enableBankingRowsTakenOver({ reads: [{ iban: null, currency: 'SEK' }], replaced: null, live: [eb(SAME, [{ iban: null, enabled: true }])] })).toEqual([])
  })

  it('names the switch\'s row only when it is still live, and each row once', () => {
    expect(enableBankingRowsTakenOver({ reads: [{ iban: IBAN_A, currency: 'SEK' }], replaced: NAMED, live: [] })).toEqual([])
    expect(enableBankingRowsTakenOver({ reads: [{ iban: IBAN_A, currency: 'SEK' }], replaced: NAMED, live: [eb(NAMED, [{ iban: IBAN_A, enabled: true }])] })).toEqual([NAMED])
  })
})
