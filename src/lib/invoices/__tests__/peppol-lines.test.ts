import { describe, expect, it } from 'vitest'
import { countTextRowsLeftOutOfPeppol, isPeppolInvoiceLine } from '../peppol-lines'

describe('isPeppolInvoiceLine', () => {
  it('keeps product rows, including rows saved before line_type existed, and drops text rows', () => {
    expect(isPeppolInvoiceLine({ line_type: 'product' })).toBe(true)
    expect(isPeppolInvoiceLine({ line_type: undefined })).toBe(true)
    expect(isPeppolInvoiceLine({ line_type: 'text' })).toBe(false)
  })
})

describe('countTextRowsLeftOutOfPeppol', () => {
  it('counts text rows with words in them, not blank spacer rows or product rows', () => {
    expect(countTextRowsLeftOutOfPeppol([
      { line_type: 'product', description: 'Rådgivning' },
      { line_type: 'text', description: 'Avser projekt Norrland, vecka 41' },
      { line_type: 'text', description: '   ' },
      { line_type: 'text', description: 'Inköpsorder 4500012345' },
    ])).toBe(2)
  })

  it('is zero for an invoice without text rows', () => {
    expect(countTextRowsLeftOutOfPeppol([{ line_type: 'product', description: 'Rådgivning' }])).toBe(0)
    expect(countTextRowsLeftOutOfPeppol([])).toBe(0)
  })
})
