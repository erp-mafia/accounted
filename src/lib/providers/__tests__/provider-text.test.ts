import { describe, expect, it } from 'vitest'
import { cleanProviderPayload, cleanProviderText } from '../provider-text'

describe('cleanProviderText', () => {
  it('removes NUL, the other C0 controls and DEL', () => {
    expect(cleanProviderText('A\u0000B\u0001C\u001FD\u007FE\u000BF\u000CG')).toBe('ABCDEFG')
  })

  it('keeps tab, line feed, carriage return and ordinary Unicode', () => {
    expect(cleanProviderText('Rad 1\r\n\tÅlund & Søn')).toBe('Rad 1\r\n\tÅlund & Søn')
  })
})

describe('cleanProviderPayload', () => {
  it('cleans strings at any depth and leaves other values alone', () => {
    const input = {
      invoiceNumber: 'INV\u0000-1',
      totalAmount: 105.12,
      paid: false,
      journalEntryRef: null,
      lineItems: [{ description: 'Abonnemang\u0000', quantity: 1 }],
      tags: ['a\u0002', 7],
    }

    expect(cleanProviderPayload(input)).toEqual({
      invoiceNumber: 'INV-1',
      totalAmount: 105.12,
      paid: false,
      journalEntryRef: null,
      lineItems: [{ description: 'Abonnemang', quantity: 1 }],
      tags: ['a', 7],
    })
  })

  it('does not mutate the parsed body it was given', () => {
    const input = { invoiceNumber: 'X\u0000' }
    cleanProviderPayload(input)
    expect(input.invoiceNumber).toBe('X\u0000')
  })

  it('passes scalars and undefined straight through', () => {
    expect(cleanProviderPayload(42)).toBe(42)
    expect(cleanProviderPayload(undefined)).toBeUndefined()
    expect(cleanProviderPayload('\u0000')).toBe('')
  })
})
