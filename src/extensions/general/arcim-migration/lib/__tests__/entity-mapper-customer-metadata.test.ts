import { describe, expect, it } from 'vitest'
import type { CustomerDto } from '@/lib/providers/dto'
import { mapCustomer } from '../entity-mapper'

describe('Arcim customer metadata mapping', () => {
  it('maps contact person and customer-specific invoice recipients', () => {
    const dto: CustomerDto = {
      id: 'customer-1',
      customerNumber: '1001',
      type: 'company',
      party: {
        name: 'Kund AB',
        identifications: [{ id: '556677-8899', schemeId: 'SE:ORGNR' }],
        contact: {
          name: 'Anna Andersson',
          email: 'invoice@example.test',
        },
      },
      invoiceEmailCcAddresses: ['finance@example.test'],
      invoiceEmailBccAddresses: ['archive@example.test'],
      active: true,
    }

    expect(mapCustomer(dto, 'user-1', 'company-1')).toMatchObject({
      contact_person: 'Anna Andersson',
      email: 'invoice@example.test',
      invoice_email_cc_addresses: ['finance@example.test'],
      invoice_email_bcc_addresses: ['archive@example.test'],
    })
  })

  it('uses null for provider fields that were not supplied', () => {
    const dto: CustomerDto = {
      id: 'customer-2',
      customerNumber: '1002',
      party: { name: 'Kund Två AB', identifications: [] },
      active: true,
    }

    expect(mapCustomer(dto, 'user-1', 'company-1')).toMatchObject({
      contact_person: null,
      invoice_email_cc_addresses: null,
      invoice_email_bcc_addresses: null,
    })
  })
})
