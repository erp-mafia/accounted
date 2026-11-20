import { describe, it, expect } from 'vitest'
import { describeEmptySync, describeOtherCurrency, emptySyncKind } from '../empty-sync-text'

describe('emptySyncKind (PH 221)', () => {
  it('names entries the bank sent but has not booked', () => {
    expect(emptySyncKind({ imported: 0, duplicates: 0, notBooked: 2 })).toBe('not_booked')
  })

  it('names a bank that sent nothing for the window', () => {
    expect(emptySyncKind({ imported: 0, duplicates: 0 })).toBe('nothing')
    expect(emptySyncKind({ imported: 0, duplicates: 0, notBooked: 0 })).toBe('nothing')
  })

  it('names booked entries set aside as another currency first: the person has to act on them (crm#1767)', () => {
    expect(emptySyncKind({ imported: 0, duplicates: 0, otherCurrency: 3 })).toBe('other_currency')
    expect(emptySyncKind({ imported: 0, duplicates: 0, otherCurrency: 3, notBooked: 2 })).toBe('other_currency')
    expect(emptySyncKind({ imported: 1, duplicates: 0, otherCurrency: 3 })).toBeNull()
  })

  it('says nothing extra when rows came in, were already here, or failed', () => {
    expect(emptySyncKind({ imported: 3, duplicates: 0, notBooked: 2 })).toBeNull()
    expect(emptySyncKind({ imported: 0, duplicates: 5 })).toBeNull()
    expect(emptySyncKind({ imported: 0, duplicates: 0, errors: 1 })).toBeNull()
  })
})

describe('describeEmptySync', () => {
  it('counts the unbooked entries and says when they come in', () => {
    expect(describeEmptySync({ imported: 0, duplicates: 0, notBooked: 2 })).toBe(
      'Banken skickade 2 transaktioner som den inte har bokfört än. De kommer in här när banken har bokfört dem.',
    )
    expect(describeEmptySync({ imported: 0, duplicates: 0, notBooked: 1 })).toMatch(/^Banken skickade 1 transaktion som/)
  })

  it('says the other-currency entries were not imported and where they go', () => {
    expect(describeEmptySync({ imported: 0, duplicates: 0, otherCurrency: 2 })).toBe(
      'Banken skickade 2 transaktioner i en annan valuta än kontots, och de har inte importerats. Importera dem som bankfil till ett konto i den valutan.',
    )
    expect(describeEmptySync({ imported: 0, duplicates: 0, otherCurrency: 1 })).toMatch(/^Banken skickade 1 transaktion i en annan valuta.*den har inte/)
  })

  it('points an empty answer at the bank file import', () => {
    expect(describeEmptySync({ imported: 0, duplicates: 0 })).toMatch(/inga transaktioner.*bankfil/)
  })

  it('names the other-currency entries on their own for a sync that imported rows too', () => {
    expect(describeOtherCurrency(3)).toBe(describeEmptySync({ imported: 0, duplicates: 0, otherCurrency: 3 }))
    expect(describeOtherCurrency(0)).toBeNull()
    expect(describeOtherCurrency(undefined)).toBeNull()
  })

  it('is null for an ordinary sync', () => {
    expect(describeEmptySync({ imported: 4, duplicates: 1 })).toBeNull()
  })
})
