import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import type { AvailableInboxDoc } from '@/components/bookkeeping/InboxDocumentPicker'
import {
  carriedDocumentIds,
  underlagForReview,
  underlagToCarry,
  uploadInFlight,
  type CarriedUnderlag,
} from '../review-underlag'

/**
 * "Byt" in the Bokför review closed it for the template picker and the pick
 * opened a fresh review: a file uploaded in the first one (already archived
 * and read) was no longer attached, and from 500 kr the button read "Bokför
 * utan underlag" (PostHog PH 118). The state carried across the switch is
 * decided by the pure helpers in review-underlag.ts, tested here; Vitest runs
 * in `node` and never renders components, so the wiring in the dialog and the
 * page is pinned with file-level assertions like the sibling dialog tests.
 */

function upload(overrides: Partial<UploadedFile> = {}): UploadedFile {
  return {
    id: 'doc-upload-1',
    file: {} as File,
    status: 'uploaded',
    fileName: 'massage-invoice.pdf',
    fileSize: 1234,
    uploadKey: 'upload-1',
    ...overrides,
  }
}

function inboxDoc(overrides: Partial<AvailableInboxDoc> = {}): AvailableInboxDoc {
  return {
    inbox_item_id: 'inbox-1',
    document_id: 'doc-inbox-1',
    file_name: 'receipt.pdf',
    mime_type: 'application/pdf',
    file_size_bytes: 2048,
    source: 'email',
    created_at: '2026-09-27T10:00:00Z',
    supplier_name: 'Leverantör AB',
    amount: 1000,
    currency: 'SEK',
    invoice_date: '2026-09-20',
    ...overrides,
  }
}

describe('underlagToCarry', () => {
  it('carries the finished uploads and the inkorg picks', () => {
    const files = [upload()]
    const inboxDocs = [inboxDoc()]
    expect(underlagToCarry({ files, inboxDocs })).toEqual({ files, inboxDocs })
  })

  it('drops an upload that failed or has no document id to link', () => {
    const done = upload()
    const failed = upload({ id: undefined, status: 'error', uploadKey: 'upload-2' })
    const idless = upload({ id: undefined, uploadKey: 'upload-3' })
    expect(underlagToCarry({ files: [done, failed, idless], inboxDocs: [] })).toEqual({ files: [done], inboxDocs: [] })
  })

  it('carries nothing when nothing is attached, so the next review starts as before', () => {
    expect(underlagToCarry({ files: [], inboxDocs: [] })).toBeNull()
    expect(underlagToCarry({ files: [upload({ id: undefined, status: 'error' })], inboxDocs: [] })).toBeNull()
  })
})

describe('underlagForReview', () => {
  const carried: CarriedUnderlag = { transactionId: 'tx-1', files: [upload()], inboxDocs: [inboxDoc()] }

  it('hands the carried underlag to the review the "Byt" picker opens on the same row', () => {
    expect(underlagForReview(carried, { transactionId: 'tx-1', fromPicker: true })).toEqual({
      files: carried.files,
      inboxDocs: carried.inboxDocs,
    })
  })

  it('gives every other way in an empty review, like closing the review does', () => {
    // The row's own Bokför after the picker was dismissed.
    expect(underlagForReview(carried, { transactionId: 'tx-1', fromPicker: false })).toBeNull()
    // Another row: an underlag never follows the dialog to another verifikat.
    expect(underlagForReview(carried, { transactionId: 'tx-2', fromPicker: true })).toBeNull()
    expect(underlagForReview(null, { transactionId: 'tx-1', fromPicker: true })).toBeNull()
  })
})

describe('carriedDocumentIds', () => {
  it('names the carried uploads and picks, which the reopened review does not read again', () => {
    const ids = carriedDocumentIds({ files: [upload(), upload({ id: undefined, uploadKey: 'upload-2' })], inboxDocs: [inboxDoc()] })
    expect([...ids].sort()).toEqual(['doc-inbox-1', 'doc-upload-1'])
    expect(carriedDocumentIds(null).size).toBe(0)
  })
})

describe('uploadInFlight', () => {
  it('holds "Byt" while an upload has no document id yet', () => {
    expect(uploadInFlight([upload(), upload({ id: undefined, status: 'uploading', uploadKey: 'upload-2' })])).toBe(true)
    expect(uploadInFlight([upload(), upload({ id: undefined, status: 'error', uploadKey: 'upload-2' })])).toBe(false)
    expect(uploadInFlight([])).toBe(false)
  })
})

describe('wiring', () => {
  const DIALOG_SRC = fs.readFileSync(path.resolve(__dirname, '../QuickReviewDialog.tsx'), 'utf8')
  const PAGE_SRC = fs.readFileSync(path.resolve(__dirname, '../../../app/(dashboard)/transactions/page.tsx'), 'utf8')

  it('the dialog opens with the carried underlag attached and does not read it again', () => {
    expect(DIALOG_SRC).toMatch(/useState<UploadedFile\[\]>\(\(\) => carriedUnderlag\?\.files \?\? \[\]\)/)
    expect(DIALOG_SRC).toMatch(/useState<AvailableInboxDoc\[\]>\(\(\) => carriedUnderlag\?\.inboxDocs \?\? \[\]\)/)
    expect(DIALOG_SRC).toContain('setPickedInboxDocs(carriedUnderlag?.inboxDocs ?? [])')
    expect(DIALOG_SRC).toContain('carriedDocIds.has(readDocId)')
  })

  it('"Byt" hands over what underlagToCarry keeps, and waits for an upload in flight', () => {
    expect(DIALOG_SRC).toContain('onChangeTemplate(underlagToCarry({ files: uploadedFiles, inboxDocs: pickedInboxDocs }))')
    expect(DIALOG_SRC).toContain('disabled={uploadInFlight(uploadedFiles)}')
  })

  it('the page carries it from "Byt" to the review its picker opens, and nowhere else', () => {
    expect(PAGE_SRC).toMatch(/function handleChangeTemplate\(underlag: ReviewUnderlag \| null\)/)
    expect(PAGE_SRC).toContain('setTemplatePickerUnderlag(underlag ? { ...underlag, transactionId: quickReview.transaction.id } : null)')
    expect(PAGE_SRC).toMatch(/underlagForReview\(templatePickerUnderlag, \{\s*transactionId: transaction\.id,\s*fromPicker: templatePickerOpen,\s*\}\)/)
    expect(PAGE_SRC).toContain('carriedUnderlag={quickReview?.underlag ?? null}')
    // A picker opened from the row starts without a carried underlag.
    const openCategoryDialog = PAGE_SRC.slice(PAGE_SRC.indexOf('function openCategoryDialog('), PAGE_SRC.indexOf('function openReview('))
    expect(openCategoryDialog).toContain('setTemplatePickerUnderlag(null)')
  })
})
