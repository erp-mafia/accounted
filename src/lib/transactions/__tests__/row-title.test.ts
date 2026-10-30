import { describe, it, expect } from 'vitest'
import { bankRowTitle } from '../row-title'
import { customerPhoneMatches } from '@/lib/invoices/invoice-matching'

describe('bankRowTitle', () => {
  it('puts the payer name first on a Swish row whose text is only the number and the Swish id (crm#1399)', () => {
    const row = { description: '+46701234567    1234567890123456', merchant_name: 'Anna Andersson' }
    expect(bankRowTitle(row)).toBe('Anna Andersson (+46701234567    1234567890123456)')
  })

  it('puts the name first on a bare phone number', () => {
    expect(bankRowTitle({ description: '0701234567', merchant_name: 'Anna Andersson' })).toBe(
      'Anna Andersson (0701234567)',
    )
  })

  it('puts the name first on an OCR-only bill payment', () => {
    expect(bankRowTitle({ description: '16501234567890', merchant_name: 'Skatteverket' })).toBe(
      'Skatteverket (16501234567890)',
    )
  })

  it('keeps the text when the bank sent no name (SEB Swish rows)', () => {
    expect(bankRowTitle({ description: '46701234567', merchant_name: null })).toBe('46701234567')
    expect(bankRowTitle({ description: '46701234567', merchant_name: '   ' })).toBe('46701234567')
  })

  it('keeps the text when the "name" is the number again (Swedbank, Sparbanken Nord)', () => {
    expect(bankRowTitle({ description: '+46701234567', merchant_name: '+46701234567' })).toBe('+46701234567')
  })

  it('keeps a text that has words in it: the bank already named the row', () => {
    expect(bankRowTitle({ description: 'Swish +46701234567', merchant_name: 'Anna Andersson' })).toBe(
      'Swish +46701234567',
    )
    expect(bankRowTitle({ description: 'ICA Kvantum', merchant_name: 'ICA KVANTUM' })).toBe('ICA Kvantum')
  })

  it('keeps a title the user typed', () => {
    expect(
      bankRowTitle({ description: '0701234567', merchant_name: 'Anna Andersson', title_edited_at: '2026-10-01T10:00:00Z' }),
    ).toBe('0701234567')
  })

  it('shows the name alone when the text is empty', () => {
    expect(bankRowTitle({ description: '', merchant_name: 'Anna Andersson' })).toBe('Anna Andersson')
  })

  it('reads letters beyond ASCII', () => {
    expect(bankRowTitle({ description: 'Överföring', merchant_name: 'Anna' })).toBe('Överföring')
    expect(bankRowTitle({ description: '123', merchant_name: 'Åsa Öberg' })).toBe('Åsa Öberg (123)')
  })

  it('leaves the stored row alone, so the Swish phone matcher still reads the number', () => {
    const row = { description: '+46701234567    1234567890123456', merchant_name: 'Anna Andersson', reference: null }
    bankRowTitle(row)
    expect(row.description).toBe('+46701234567    1234567890123456')
    expect(customerPhoneMatches('070-123 45 67', row)).toBe(true)
  })
})
