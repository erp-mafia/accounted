import { describe, expect, it } from 'vitest'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { bankRowAlreadyBookedMessages, matchInvoiceTxAlreadyBookedMessages } from '../match-si-tx-already-booked'

describe('matchInvoiceTxAlreadyBookedMessages', () => {
  it('names the undo of a booking on the pointer', () => {
    const messages = matchInvoiceTxAlreadyBookedMessages({ voucher: 'A12', undo: 'uncategorize' })
    expect(messages?.message_sv).toContain('återför A12')
    expect(messages?.message_en).toContain('gnubok_uncategorize_transaction')
  })

  it('never sends a reconciliation link to uncategorize: that reverses the independent verifikat', () => {
    const messages = matchInvoiceTxAlreadyBookedMessages({ voucher: 'A12', undo: 'unlink' })
    expect(messages?.message_sv).toContain('Koppla bort')
    expect(messages?.message_en).toContain('gnubok_reconcile_unmatch')
    expect(messages?.message_en).not.toContain('uncategorize')
  })

  it('says a storno of a samlingsverifikat brings every row back', () => {
    const messages = matchInvoiceTxAlreadyBookedMessages({ voucher: 'A12', undo: 'reverse_voucher' })
    expect(messages?.message_sv).toContain('alla transaktioner på verifikatet')
    expect(messages?.message_en).toContain('gnubok_reverse_journal_entry')
    expect(messages?.message_en).not.toContain('uncategorize')
  })

  it('stays with the registry sentence when no verifikat is named: a failed read, a concurrent booking', () => {
    expect(matchInvoiceTxAlreadyBookedMessages({ voucher: null, undo: null })).toBeNull()
  })
})

describe('bankRowAlreadyBookedMessages', () => {
  it('answers for the two match codes and nothing else', () => {
    expect(bankRowAlreadyBookedMessages('MATCH_INVOICE_TX_ALREADY_BOOKED', { voucher: 'A12', undo: 'uncategorize' })).not.toBeNull()
    expect(bankRowAlreadyBookedMessages('MATCH_SI_TX_ALREADY_BOOKED', { voucher: 'A12', storno_allowed: true })).not.toBeNull()
    expect(bankRowAlreadyBookedMessages('TRANSACTION_ALREADY_CATEGORIZED', { voucher: 'A12' })).toBeNull()
  })

  it('reaches the UI in its own language', () => {
    const body = { error: { code: 'MATCH_INVOICE_TX_ALREADY_BOOKED', details: { voucher: 'A12', undo: 'uncategorize' } } }
    expect(getErrorMessage(body, { locale: 'sv' })).toContain('återför A12')
    expect(getErrorMessage(body, { locale: 'en' })).toContain('booked on verifikat A12')
  })
})

describe('the registry', () => {
  it('holds a 409 for a booked row and for an ignored row, in both languages', () => {
    for (const code of ['MATCH_INVOICE_TX_ALREADY_BOOKED', 'BANK_ROW_IGNORED']) {
      const entry = getErrorEntry(code)
      expect(entry?.httpStatus).toBe(409)
      expect(entry?.message_sv).toBeTruthy()
      expect(entry?.message_en).toBeTruthy()
    }
  })
})
