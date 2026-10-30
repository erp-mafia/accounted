import { describe, it, expect } from 'vitest'
import {
  MAX_INVOICE_ATTACHMENT_FILE_BYTES,
  invoiceAttachmentSizeVerdict,
  isPeppolAttachmentFile,
  offersInvoiceAttachments,
} from '@/lib/invoices/invoice-attachment-limits'

const MB = 1024 * 1024

describe('invoiceAttachmentSizeVerdict (#79)', () => {
  it('lets a 6 MB PDF through on hosted too: it goes straight to Storage, not in a request body', () => {
    expect(invoiceAttachmentSizeVerdict({ size: 6 * MB, type: 'application/pdf' }, true)).toBe('ok')
    expect(invoiceAttachmentSizeVerdict({ size: 6 * MB, type: 'application/pdf' }, false)).toBe('ok')
  })

  it('sends a photo over the archive ceiling to the browser shrink on hosted', () => {
    expect(invoiceAttachmentSizeVerdict({ size: 12 * MB, type: 'image/jpeg' }, true)).toBe('shrink')
    expect(invoiceAttachmentSizeVerdict({ size: 12 * MB, type: 'image/heic' }, true)).toBe('shrink')
  })

  it('accepts a file exactly at the archive ceiling and refuses one byte over', () => {
    expect(MAX_INVOICE_ATTACHMENT_FILE_BYTES).toBe(10 * MB)
    expect(invoiceAttachmentSizeVerdict({ size: 10 * MB, type: 'application/pdf' }, true)).toBe('ok')
    expect(invoiceAttachmentSizeVerdict({ size: 10 * MB + 1, type: 'application/pdf' }, true)).toBe('too_large')
    expect(invoiceAttachmentSizeVerdict({ size: 10 * MB + 1, type: 'image/jpeg' }, false)).toBe('too_large')
  })
})

describe('offersInvoiceAttachments (#79, crm#1315)', () => {
  const base = { isSandbox: false, canEmail: true }

  it('offers them when the editor emails a document it has not saved yet', () => {
    expect(offersInvoiceAttachments({ ...base, channel: 'email', status: null })).toBe(true)
  })

  it('offers them when a draft is emailed (the invoice page and the editor on a saved draft)', () => {
    expect(offersInvoiceAttachments({ ...base, channel: 'email', status: 'draft' })).toBe(true)
  })

  it('offers them on a Peppol send of a draft or an unsaved document, with or without email in the plan (crm#1545)', () => {
    expect(offersInvoiceAttachments({ ...base, channel: 'peppol', status: 'draft' })).toBe(true)
    expect(offersInvoiceAttachments({ ...base, channel: 'peppol', status: null })).toBe(true)
    expect(offersInvoiceAttachments({ channel: 'peppol', status: 'draft', isSandbox: false, canEmail: false })).toBe(true)
    expect(offersInvoiceAttachments({ ...base, channel: 'peppol', status: 'sent' })).toBe(false)
    expect(offersInvoiceAttachments({ channel: 'peppol', status: 'draft', isSandbox: true, canEmail: true })).toBe(false)
  })

  it('does not offer them on a channel that does not carry them', () => {
    expect(offersInvoiceAttachments({ ...base, channel: 'manual', status: 'draft' })).toBe(false)
    // A Kivra or Billo mailbox takes the invoice PDF alone.
    expect(offersInvoiceAttachments({ ...base, channel: 'kivra', status: 'draft' })).toBe(false)
    expect(offersInvoiceAttachments({ ...base, channel: 'billo', status: null })).toBe(false)
    expect(offersInvoiceAttachments({ ...base, channel: null, status: null })).toBe(false)
  })

  it('does not offer them once the set is fixed (issued)', () => {
    expect(offersInvoiceAttachments({ ...base, channel: 'email', status: 'sent' })).toBe(false)
  })

  it('does not offer them in the sandbox or without email in the plan', () => {
    expect(offersInvoiceAttachments({ channel: 'email', status: null, isSandbox: true, canEmail: true })).toBe(false)
    expect(offersInvoiceAttachments({ channel: 'email', status: null, isSandbox: false, canEmail: false })).toBe(false)
  })
})

describe('isPeppolAttachmentFile (crm#1545)', () => {
  it('takes a PDF by type, or by name when the browser gives no type', () => {
    expect(isPeppolAttachmentFile({ type: 'application/pdf', name: 'tidrapport' })).toBe(true)
    expect(isPeppolAttachmentFile({ type: '', name: 'Dagbok.PDF' })).toBe(true)
    expect(isPeppolAttachmentFile({ type: 'image/png', name: 'kvitto.pdf' })).toBe(false)
    expect(isPeppolAttachmentFile({ type: '', name: 'tidrapport.docx' })).toBe(false)
  })
})
