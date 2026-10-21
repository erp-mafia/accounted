import { describe, it, expect } from 'vitest'
import {
  MAX_INVOICE_ATTACHMENT_FILE_BYTES,
  invoiceAttachmentFileLimitBytes,
  invoiceAttachmentSizeVerdict,
  offersInvoiceAttachments,
} from '@/lib/invoices/invoice-attachment-limits'
import { HOSTED_MAX_UPLOAD_BYTES } from '@/lib/documents/upload-size'

const MB = 1024 * 1024

describe('invoiceAttachmentFileLimitBytes (#79)', () => {
  it('is the platform body cap on hosted, not the archive ceiling', () => {
    expect(invoiceAttachmentFileLimitBytes(true)).toBe(HOSTED_MAX_UPLOAD_BYTES)
    expect(invoiceAttachmentFileLimitBytes(true)).toBe(4 * MB)
  })

  it('is the archive ceiling self-hosted', () => {
    expect(invoiceAttachmentFileLimitBytes(false)).toBe(MAX_INVOICE_ATTACHMENT_FILE_BYTES)
    expect(invoiceAttachmentFileLimitBytes(false)).toBe(10 * MB)
  })
})

describe('invoiceAttachmentSizeVerdict (#79)', () => {
  it('refuses a 6 MB PDF on hosted up front (it used to pass the 10 MB check and fail later)', () => {
    expect(invoiceAttachmentSizeVerdict({ size: 6 * MB, type: 'application/pdf' }, true)).toBe('too_large')
  })

  it('lets a 6 MB PDF through self-hosted', () => {
    expect(invoiceAttachmentSizeVerdict({ size: 6 * MB, type: 'application/pdf' }, false)).toBe('ok')
  })

  it('sends a photo over the hosted cap to the browser shrink', () => {
    expect(invoiceAttachmentSizeVerdict({ size: 7 * MB, type: 'image/jpeg' }, true)).toBe('shrink')
    expect(invoiceAttachmentSizeVerdict({ size: 7 * MB, type: 'image/heic' }, true)).toBe('shrink')
  })

  it('accepts a file exactly at the limit and refuses one byte over self-hosted', () => {
    expect(invoiceAttachmentSizeVerdict({ size: 4 * MB, type: 'application/pdf' }, true)).toBe('ok')
    expect(invoiceAttachmentSizeVerdict({ size: 10 * MB, type: 'application/pdf' }, false)).toBe('ok')
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

  it('does not offer them on a channel that does not email them', () => {
    expect(offersInvoiceAttachments({ ...base, channel: 'manual', status: 'draft' })).toBe(false)
    expect(offersInvoiceAttachments({ ...base, channel: 'peppol', status: 'draft' })).toBe(false)
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
