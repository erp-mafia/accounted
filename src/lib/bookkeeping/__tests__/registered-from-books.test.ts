import { describe, it, expect } from 'vitest'
import { isRegisteredFromBooks } from '../registered-from-books'

/**
 * crm#1131: one predicate decides that an invoice is a registration of a
 * document issued elsewhere, for the register's coverage boundary, the
 * invoice page and the agent read alike.
 */
describe('isRegisteredFromBooks', () => {
  it('is true for an invoice linked to its verifikat and written without lines', () => {
    expect(isRegisteredFromBooks({ journal_entry_id: 'je-1' }, [])).toBe(true)
    expect(isRegisteredFromBooks({ journal_entry_id: 'je-1', credited_invoice_id: null }, [])).toBe(true)
  })

  it('is false for an invoice with lines, linked or not', () => {
    expect(isRegisteredFromBooks({ journal_entry_id: 'je-1' }, [{ id: 'item-1' }])).toBe(false)
    expect(isRegisteredFromBooks({ journal_entry_id: null }, [{ id: 'item-1' }])).toBe(false)
  })

  it('is false without a verifikat: a draft without lines is just empty', () => {
    expect(isRegisteredFromBooks({ journal_entry_id: null }, [])).toBe(false)
    expect(isRegisteredFromBooks({}, [])).toBe(false)
  })

  it('does not judge a row whose lines were not read', () => {
    expect(isRegisteredFromBooks({ journal_entry_id: 'je-1' }, undefined)).toBe(false)
    expect(isRegisteredFromBooks({ journal_entry_id: 'je-1' }, null)).toBe(false)
  })

  it('is false for the kreditfaktura of a registration: issued and booked here, without lines to mirror', () => {
    expect(
      isRegisteredFromBooks({ journal_entry_id: 'je-2', credited_invoice_id: 'invoice-1' }, []),
    ).toBe(false)
  })
})
