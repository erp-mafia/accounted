import { describe, expect, it } from 'vitest'
import { buildCustomerMetadataEnrichment } from '../customer-metadata'

describe('buildCustomerMetadataEnrichment', () => {
  const mapped = {
    contact_person: 'Anna Andersson',
    invoice_email_cc_addresses: ['finance@example.test'],
    invoice_email_bcc_addresses: ['archive@example.test'],
  }

  it('fills metadata that was never configured', () => {
    expect(buildCustomerMetadataEnrichment({
      contact_person: null,
      invoice_email_cc_addresses: null,
      invoice_email_bcc_addresses: null,
    }, mapped)).toEqual(mapped)
  })

  it('does not overwrite existing values or explicit clears', () => {
    expect(buildCustomerMetadataEnrichment({
      contact_person: '',
      invoice_email_cc_addresses: [],
      invoice_email_bcc_addresses: ['manual@example.test'],
    }, mapped)).toBeNull()
  })

  it('fills the org number on an org-less invoice stub, and leaves a set one alone', () => {
    // The invoice steps create org-less minimal customers for counterparties
    // the register never delivered; the register row that maps onto such a
    // stub by name brings the number.
    expect(buildCustomerMetadataEnrichment({
      contact_person: 'Anna Andersson',
      invoice_email_cc_addresses: [],
      invoice_email_bcc_addresses: [],
      org_number: null,
    }, { org_number: '5566778899' })).toEqual({ org_number: '5566778899' })

    expect(buildCustomerMetadataEnrichment({
      contact_person: 'Anna Andersson',
      invoice_email_cc_addresses: [],
      invoice_email_bcc_addresses: [],
      org_number: '5511111111',
    }, { org_number: '5566778899' })).toBeNull()
  })

  it('does not turn unknown provider metadata into explicit empty values', () => {
    expect(buildCustomerMetadataEnrichment({
      contact_person: null,
      invoice_email_cc_addresses: null,
      invoice_email_bcc_addresses: null,
    }, {
      contact_person: null,
      invoice_email_cc_addresses: [],
      invoice_email_bcc_addresses: null,
    })).toBeNull()
  })
})
