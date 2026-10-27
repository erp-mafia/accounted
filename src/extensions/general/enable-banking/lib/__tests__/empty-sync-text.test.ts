import { describe, it, expect } from 'vitest'
import { describeEmptySync, emptySyncKind } from '../empty-sync-text'

describe('emptySyncKind (PH 221)', () => {
  it('names entries the bank sent but has not booked', () => {
    expect(emptySyncKind({ imported: 0, duplicates: 0, notBooked: 2 })).toBe('not_booked')
  })

  it('names a bank that sent nothing for the window', () => {
    expect(emptySyncKind({ imported: 0, duplicates: 0 })).toBe('nothing')
    expect(emptySyncKind({ imported: 0, duplicates: 0, notBooked: 0 })).toBe('nothing')
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

  it('points an empty answer at the bank file import', () => {
    expect(describeEmptySync({ imported: 0, duplicates: 0 })).toMatch(/inga transaktioner.*bankfil/)
  })

  it('is null for an ordinary sync', () => {
    expect(describeEmptySync({ imported: 4, duplicates: 1 })).toBeNull()
  })
})
