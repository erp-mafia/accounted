import { describe, expect, it } from 'vitest'
import { mapFortnoxToCustomer } from '../mapper'

describe('Fortnox customer metadata mapping', () => {
  it('prefers invoice email and carries reference plus CC/BCC recipients', () => {
    const dto = mapFortnoxToCustomer({
      CustomerNumber: '1001',
      Name: 'Kund AB',
      Email: 'general@example.test',
      EmailInvoice: 'invoice@example.test',
      EmailInvoiceCC: 'finance@example.test; owner@example.test, FINANCE@example.test',
      EmailInvoiceBCC: ['archive@example.test', 'audit@example.test'],
      YourReference: 'Anna Andersson',
      Active: true,
    })

    expect(dto.party.contact).toMatchObject({
      name: 'Anna Andersson',
      email: 'invoice@example.test',
    })
    expect(dto.invoiceEmailCcAddresses).toEqual([
      'finance@example.test',
      'owner@example.test',
    ])
    expect(dto.invoiceEmailBccAddresses).toEqual([
      'archive@example.test',
      'audit@example.test',
    ])
  })

  it('falls back to the general email and preserves absent copy fields as undefined', () => {
    const dto = mapFortnoxToCustomer({
      CustomerNumber: '1002',
      Name: 'Kund Två AB',
      Email: 'general@example.test',
    })

    expect(dto.party.contact?.email).toBe('general@example.test')
    expect(dto.invoiceEmailCcAddresses).toBeUndefined()
    expect(dto.invoiceEmailBccAddresses).toBeUndefined()
  })
})
