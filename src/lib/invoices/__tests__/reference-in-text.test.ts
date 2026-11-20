import { describe, expect, it } from 'vitest'
import { findSupplierInvoiceMatch } from '../supplier-invoice-matching'
import { descriptionMentionsReference } from '@/lib/invariants/reference-number'
import { tryReconcileTransaction, type UnlinkedGLLine } from '@/lib/reconciliation/bank-reconciliation'
import type { SupplierInvoice, Transaction } from '@/types'

const line = (entry_description: string): UnlinkedGLLine => ({
  line_id: 'l1',
  journal_entry_id: 'e1',
  debit_amount: 1000,
  credit_amount: 0,
  line_description: null,
  entry_date: '2026-03-01',
  voucher_number: 1,
  voucher_series: 'A',
  entry_description,
  source_type: 'manual',
})

/** 45 days from the verifikat: only a reference can pair them. */
const row = (reference: string) =>
  ({ id: 't1', date: '2026-04-15', amount: 1000, currency: 'SEK', reference }) as Transaction

const matched = (reference: string, text: string) => tryReconcileTransaction(row(reference), [line(text)])?.method ?? null

describe('a reference names a document only as a whole number in the text', () => {
  it('digits inside a longer run name nothing', () => {
    expect(matched('1234', 'Faktura 212345')).toBeNull()
    expect(matched('1814', 'Levbet Tele2 18145')).toBeNull()
  })

  it('compares on the digits, whatever separates them on the bank row', () => {
    expect(matched('2026-0042', 'Faktura 20260042')).toBe('auto_reference')
    expect(matched('2026 0042', 'Faktura 20260042')).toBe('auto_reference')
    expect(matched('20260042', 'Faktura 20260042')).toBe('auto_reference')
  })

  it('still reads a reference as it was written', () => {
    expect(matched('2026-0042', 'Faktura 2026-0042')).toBe('auto_reference')
  })

  it('a reference with no digits, or too few, names nothing', () => {
    expect(matched('Hyra mars', 'Hyra mars')).toBeNull()
    expect(matched('123', 'Faktura 123')).toBeNull()
  })

  it('a reference with words never falls back to the digits inside it: February\'s rent is not March\'s', () => {
    expect(matched('Hyra feb 2026', 'Hyra mars 2026')).toBeNull()
    expect(matched('Lokalhyra 2026', 'Försäkring 2026-03-01')).toBeNull()
  })

  it('a reference with letters stands as written', () => {
    expect(matched('Hyra feb 2026', 'Hyra feb 2026')).toBe('auto_reference')
    expect(matched('F-101', 'Betalning faktura F-101')).toBe('auto_reference')
    expect(matched('INV-42', 'Faktura INV-42')).toBe('auto_reference')
    expect(matched('R123', 'Kvitto R123')).toBe('auto_reference')
    expect(matched('F-101', 'Betalning faktura F-1010')).toBeNull()
  })

  it('a whole number followed by another number is still whole', () => {
    expect(matched('1234', 'Faktura 1234 2026-03-01')).toBe('auto_reference')
    expect(matched('1234', '2026-03-01 1234')).toBe('auto_reference')
  })
})

describe('descriptionMentionsReference', () => {
  it('reads the boundary on the text as written, and the groups of a reference through whitespace', () => {
    expect(descriptionMentionsReference('Faktura 1234 2026', 1234)).toBe(true)
    expect(descriptionMentionsReference('OCR 1234 5678', '12345678')).toBe(true)
    expect(descriptionMentionsReference('OCR 12345678', '1234 5678')).toBe(true)
    expect(descriptionMentionsReference('Levbet Tele2 (1814)', 14)).toBe(false)
    expect(descriptionMentionsReference('2026-05-11', 26)).toBe(false)
  })

  it('takes a reference with regex characters as text', () => {
    expect(descriptionMentionsReference('Faktura (2026.1)', '(2026.1)')).toBe(true)
    expect(descriptionMentionsReference('Faktura 2026x1', '2026.1')).toBe(false)
  })
})

describe('a supplier giro names the supplier only as a whole number in the text', () => {
  const invoice = (bankgiro: string | null) =>
    ({ id: 'si1', status: 'approved', remaining_amount: 500, total: 500, currency: 'SEK', supplier: { bankgiro, plusgiro: null } }) as unknown as SupplierInvoice
  const tx = (description: string) =>
    ({ id: 't1', date: '2026-04-15', amount: -500, currency: 'SEK', description }) as Transaction

  it('digits inside a longer run are no giro: an OCR number holding them scored 0.92', () => {
    expect(findSupplierInvoiceMatch(tx('OCR 91234567890'), [invoice('123-4567')])?.matchMethod).not.toBe('amount_bankgiro')
  })

  it('the giro as a whole number matches', () => {
    expect(findSupplierInvoiceMatch(tx('BG 1234567 Hyra'), [invoice('123-4567')])?.matchMethod).toBe('amount_bankgiro')
  })

  it('a giro with no digits matches nothing: it used to match every text', () => {
    expect(findSupplierInvoiceMatch(tx('vad som helst'), [invoice('ej angivet')])?.matchMethod).not.toBe('amount_bankgiro')
  })
})
