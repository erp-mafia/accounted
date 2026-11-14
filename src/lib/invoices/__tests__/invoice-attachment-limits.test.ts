import { describe, it, expect } from 'vitest'
import {
  MAX_INVOICE_ATTACHMENTS,
  MAX_INVOICE_ATTACHMENT_FILE_BYTES,
  archivedAttachmentRefusal,
  formatAttachmentSize,
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

  it('offers the invoicing-only role nothing: it does not reach the attachment routes (for #206)', () => {
    for (const channel of ['email', 'peppol'] as const) {
      for (const status of [null, 'draft']) {
        expect(offersInvoiceAttachments({ ...base, channel, status, invoicer: true })).toBe(false)
        expect(offersInvoiceAttachments({ ...base, channel, status, invoicer: false })).toBe(true)
      }
    }
  })

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

describe('archivedAttachmentRefusal (accounted#42)', () => {
  const pdf = (bytes: number) => ({ file_name: 'grossist-faktura.pdf', mime_type: 'application/pdf', file_size_bytes: bytes })
  const none = { count: 0, bytes: 0 }

  it('takes a booked supplier invoice PDF by email and over Peppol', () => {
    expect(archivedAttachmentRefusal(pdf(200 * 1024), none, 'email')).toBeNull()
    expect(archivedAttachmentRefusal(pdf(200 * 1024), none, 'peppol')).toBeNull()
  })

  it('takes a photo or an office file by email but only a PDF over Peppol, as the upload path does', () => {
    const photo = { file_name: 'kvitto.jpg', mime_type: 'image/jpeg', file_size_bytes: 1 * MB }
    const sheet = { file_name: 'tid.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', file_size_bytes: 1 * MB }
    expect(archivedAttachmentRefusal(photo, none, 'email')).toBeNull()
    expect(archivedAttachmentRefusal(sheet, none, 'email')).toBeNull()
    expect(archivedAttachmentRefusal(photo, none, 'peppol')).toBe('peppol_pdf_only')
    expect(archivedAttachmentRefusal(sheet, none, 'peppol')).toBe('peppol_pdf_only')
  })

  it('reads the type off the name when the record stores none', () => {
    expect(archivedAttachmentRefusal({ file_name: 'Faktura.PDF', mime_type: null, file_size_bytes: 1000 }, none, 'peppol')).toBeNull()
  })

  it('refuses what an upload would refuse: a mail body or an archive file', () => {
    expect(archivedAttachmentRefusal({ file_name: 'mejl.html', mime_type: 'text/html', file_size_bytes: 1000 }, none, 'email')).toBe('unsupported_type')
    expect(archivedAttachmentRefusal({ file_name: 'filer.zip', mime_type: 'application/zip', file_size_bytes: 1000 }, none, 'email')).toBe('unsupported_type')
  })

  it('refuses a stored file over the per-file ceiling: nothing is shrunk, the stored file is what goes out', () => {
    expect(archivedAttachmentRefusal(pdf(MAX_INVOICE_ATTACHMENT_FILE_BYTES), none, 'email')).toBeNull()
    expect(archivedAttachmentRefusal(pdf(MAX_INVOICE_ATTACHMENT_FILE_BYTES + 1), none, 'email')).toBe('too_large')
    expect(
      archivedAttachmentRefusal({ file_name: 'foto.jpg', mime_type: 'image/jpeg', file_size_bytes: 12 * MB }, none, 'email'),
    ).toBe('too_large')
  })

  it('counts what the invoice carries and what is picked so far toward the count and the total', () => {
    expect(archivedAttachmentRefusal(pdf(1000), { count: MAX_INVOICE_ATTACHMENTS - 1, bytes: 0 }, 'email')).toBeNull()
    expect(archivedAttachmentRefusal(pdf(1000), { count: MAX_INVOICE_ATTACHMENTS, bytes: 0 }, 'email')).toBe('too_many')
    expect(archivedAttachmentRefusal(pdf(2 * MB), { count: 3, bytes: 24 * MB }, 'email')).toBe('total_too_large')
    expect(archivedAttachmentRefusal(pdf(2 * MB), { count: 1, bytes: 3 * MB }, 'email')).toBeNull()
  })

  it('holds a Peppol send to its 5 MB total, so a 6 MB PDF can never ride inside the e-faktura', () => {
    expect(archivedAttachmentRefusal(pdf(2 * MB), { count: 1, bytes: 3 * MB }, 'peppol')).toBeNull()
    expect(archivedAttachmentRefusal(pdf(2 * MB + 1), { count: 1, bytes: 3 * MB }, 'peppol')).toBe('total_too_large')
    expect(archivedAttachmentRefusal(pdf(6 * MB), none, 'peppol')).toBe('total_too_large')
  })
})

describe('formatAttachmentSize', () => {
  it('shows KB under a megabyte and MB above, in the reader\'s locale', () => {
    expect(formatAttachmentSize(null, 'sv')).toBe('')
    expect(formatAttachmentSize(512, 'en')).toBe('0.5 KB')
    expect(formatAttachmentSize(5 * MB, 'en')).toBe('5 MB')
    expect(formatAttachmentSize(1.5 * MB, 'sv')).toBe('1,5 MB')
  })
})
