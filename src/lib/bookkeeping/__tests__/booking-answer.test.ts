import { describe, expect, it } from 'vitest'
import { bookedEntryOf } from '../booking-answer'

describe('bookedEntryOf', () => {
  it('reads the manual journal-entry door: { data: entry }', () => {
    expect(bookedEntryOf({ data: { id: 'je-1', voucher_series: 'A', voucher_number: 12 } })).toEqual({
      id: 'je-1',
      voucher_series: 'A',
      voucher_number: 12,
    })
  })

  it('reads the bank row and webshop doors: { data: entry, journal_entry_id }', () => {
    expect(bookedEntryOf({ data: { id: 'je-2', voucher_series: 'B', voucher_number: 3 }, journal_entry_id: 'je-2', success: true })).toEqual({
      id: 'je-2',
      voucher_series: 'B',
      voucher_number: 3,
    })
  })

  it('reads the inbox book-direct door, whose entry is nested under journal_entry', () => {
    const answer = {
      data: {
        journal_entry: { id: 'je-3', voucher_series: 'A', voucher_number: 7 },
        inbox_item_id: 'item-1',
        transaction_id: 'tx-1',
      },
    }
    expect(bookedEntryOf(answer)).toEqual({ id: 'je-3', voucher_series: 'A', voucher_number: 7 })
  })

  it('carries the webshop door\'s underlag_archived flag when the door answers it', () => {
    expect(
      bookedEntryOf({ data: { id: 'je-5', voucher_series: 'A', voucher_number: 9 }, journal_entry_id: 'je-5', underlag_archived: false }),
    ).toEqual({ id: 'je-5', voucher_series: 'A', voucher_number: 9, underlag_archived: false })
    expect(bookedEntryOf({ journal_entry_id: 'je-6', underlag_archived: true })).toEqual({
      id: 'je-6',
      underlag_archived: true,
    })
    // A door that does not say leaves the flag out rather than guessing.
    expect(bookedEntryOf({ data: { id: 'je-7' } })).not.toHaveProperty('underlag_archived')
  })

  it('carries the manual door\'s no_document_required answer when the door gives it', () => {
    expect(
      bookedEntryOf({ data: { id: 'je-8', voucher_series: 'A', voucher_number: 4 }, no_document_required: false }),
    ).toEqual({ id: 'je-8', voucher_series: 'A', voucher_number: 4, no_document_required: false })
    expect(bookedEntryOf({ data: { id: 'je-9' }, no_document_required: true })).toEqual({
      id: 'je-9',
      no_document_required: true,
    })
    // Not asked, not answered: the flag stays out.
    expect(bookedEntryOf({ data: { id: 'je-10' } })).not.toHaveProperty('no_document_required')
  })

  it('falls back to a top-level journal_entry_id', () => {
    expect(bookedEntryOf({ journal_entry_id: 'je-4' })).toEqual({ id: 'je-4' })
  })

  it('names no entry for an answer without one', () => {
    expect(bookedEntryOf({ data: { inbox_item_id: 'item-1' } })).toEqual({ id: null })
    expect(bookedEntryOf(null)).toEqual({ id: null })
    expect(bookedEntryOf('ok')).toEqual({ id: null })
  })
})
