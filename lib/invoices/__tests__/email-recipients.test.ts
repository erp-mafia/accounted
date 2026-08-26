import { describe, expect, it } from 'vitest'
import {
  exceedsInvoiceEmailRecipientLimit,
  findAdditionalInvoiceRecipientCollisions,
  invoiceEmailRecipientCount,
  parseInvoiceRecipientText,
  resolveInvoiceEmailRecipients,
} from '@/lib/invoices/email-recipients'

describe('resolveInvoiceEmailRecipients', () => {
  it('uses the legacy copy only while the company list is unconfigured', () => {
    expect(resolveInvoiceEmailRecipients({
      to: 'customer@example.test',
      configuredCc: null,
      legacyCc: 'billing@example.test',
    }).cc).toEqual(['billing@example.test'])

    expect(resolveInvoiceEmailRecipients({
      to: 'customer@example.test',
      configuredCc: [],
      legacyCc: 'billing@example.test',
    }).cc).toEqual([])
  })

  it('merges fixed and per-send recipients with deterministic precedence', () => {
    expect(resolveInvoiceEmailRecipients({
      to: 'customer@example.test',
      configuredCc: ['finance@example.test', 'CUSTOMER@example.test'],
      configuredBcc: ['archive@example.test', 'finance@example.test'],
      additionalCc: ['handler@example.test', 'Finance@example.test'],
      additionalBcc: ['director@example.test', 'archive@example.test'],
    })).toEqual({
      to: ['customer@example.test'],
      cc: ['finance@example.test', 'handler@example.test'],
      bcc: ['archive@example.test', 'director@example.test'],
    })
  })

  it('merges customer-specific recipients between company settings and per-send additions', () => {
    expect(resolveInvoiceEmailRecipients({
      to: 'customer@example.test',
      configuredCc: ['company-copy@example.test'],
      configuredBcc: ['company-archive@example.test'],
      customerCc: ['customer-copy@example.test', 'COMPANY-COPY@example.test'],
      customerBcc: ['customer-archive@example.test', 'customer-copy@example.test'],
      additionalCc: ['case-owner@example.test'],
      additionalBcc: ['audit@example.test'],
    })).toEqual({
      to: ['customer@example.test'],
      cc: [
        'company-copy@example.test',
        'customer-copy@example.test',
        'case-owner@example.test',
      ],
      bcc: [
        'company-archive@example.test',
        'customer-archive@example.test',
        'audit@example.test',
      ],
    })
  })

  it('counts the final de-duplicated To, CC, and BCC recipients', () => {
    const atLimit = resolveInvoiceEmailRecipients({
      to: 'customer@example.test',
      configuredCc: Array.from({ length: 19 }, (_, index) => `copy-${index}@example.test`),
    })
    expect(invoiceEmailRecipientCount(atLimit)).toBe(20)
    expect(exceedsInvoiceEmailRecipientLimit(atLimit)).toBe(false)

    const overLimit = resolveInvoiceEmailRecipients({
      to: 'customer@example.test',
      configuredCc: atLimit.cc,
      additionalBcc: ['archive@example.test'],
    })
    expect(invoiceEmailRecipientCount(overLimit)).toBe(21)
    expect(exceedsInvoiceEmailRecipientLimit(overLimit)).toBe(true)
  })

  it('trims and de-duplicates address text', () => {
    expect(parseInvoiceRecipientText(
      ' finance@example.test,\nDIRECTOR@example.test; finance@example.test ',
    )).toEqual(['finance@example.test', 'DIRECTOR@example.test'])
  })

  it('reports per-send collisions instead of silently changing recipient precedence', () => {
    expect(findAdditionalInvoiceRecipientCollisions({
      to: 'customer@example.test',
      configuredCc: ['finance@example.test'],
      configuredBcc: ['archive@example.test'],
      additionalCc: ['CUSTOMER@example.test', 'case-owner@example.test'],
      additionalBcc: ['finance@example.test', 'case-owner@example.test'],
    })).toEqual([
      {
        address: 'CUSTOMER@example.test',
        field: 'additional_cc',
        conflicts_with: 'to',
      },
      {
        address: 'finance@example.test',
        field: 'additional_bcc',
        conflicts_with: 'configured_cc',
      },
      {
        address: 'case-owner@example.test',
        field: 'additional_bcc',
        conflicts_with: 'additional_cc',
      },
    ])
  })

  it('reports collisions with customer-specific recipients', () => {
    expect(findAdditionalInvoiceRecipientCollisions({
      to: 'customer@example.test',
      customerCc: ['finance@example.test'],
      customerBcc: ['archive@example.test'],
      additionalCc: ['ARCHIVE@example.test'],
      additionalBcc: ['FINANCE@example.test'],
    })).toEqual([
      {
        address: 'ARCHIVE@example.test',
        field: 'additional_cc',
        conflicts_with: 'customer_bcc',
      },
      {
        address: 'FINANCE@example.test',
        field: 'additional_bcc',
        conflicts_with: 'customer_cc',
      },
    ])
  })
})
