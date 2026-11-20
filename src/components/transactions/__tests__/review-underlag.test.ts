import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import type { AvailableInboxDoc } from '@/components/bookkeeping/InboxDocumentPicker'
import type { UnderlagFacts } from '@/lib/transactions/underlag-read'
import {
  carriedDocumentIds,
  heldUnderlag,
  pinRefused,
  pinUnderlag,
  readAfterPin,
  readAfterUnpin,
  removedUpload,
  transactionUnderlagId,
  underlagForReview,
  underlagLinkTargets,
  underlagToCarry,
  unpinUnderlag,
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

/**
 * crm#1101: a document attached in a booking dialog lived in the dialog's
 * state until the booking linked it, so closing the dialog forgot it. The
 * first one is now the transaction's own underlag the moment it lands
 * (pinned through the attach route; the orderings are in
 * underlag-controller.test.ts); a row pins one document, so the rest are
 * only held, and the booking links them all.
 */
describe('transactionUnderlagId', () => {
  it('takes what this dialog pinned or took off over everything else', () => {
    expect(transactionUnderlagId({ session: 'doc-new', read: 'doc-read', rowPin: 'doc-row' })).toBe('doc-new')
    // Taken off here: none, whatever the read or the row still say.
    expect(transactionUnderlagId({ session: null, read: 'doc-read', rowPin: 'doc-row' })).toBeNull()
  })

  it('then the route read (pinned or matched in the inkorg), its "none" included', () => {
    expect(transactionUnderlagId({ read: 'doc-matched', rowPin: null })).toBe('doc-matched')
    // The list's pin went stale (detached elsewhere): the read wins.
    expect(transactionUnderlagId({ read: null, rowPin: 'doc-row' })).toBeNull()
  })

  it('and the row pin only while the read is on its way', () => {
    expect(transactionUnderlagId({ rowPin: 'doc-row' })).toBe('doc-row')
    expect(transactionUnderlagId({})).toBeNull()
  })
})

describe('readAfterPin / readAfterUnpin', () => {
  it('shows the pin to every reader of the route before its revalidation lands', () => {
    expect(readAfterPin(undefined, 'doc-1', 'kvitto.pdf')).toEqual({
      source: 'pinned',
      document: { id: 'doc-1', file_name: 'kvitto.pdf', mime_type: null },
      inbox_item_id: null,
      facts: null,
    })
  })

  it('never carries another document\'s facts onto the pin', () => {
    const facts: UnderlagFacts = {
      supplier: null,
      date: null,
      total: 125,
      subtotal: 100,
      vat_amount: 25,
      vat_rate: 25,
      currency: 'SEK',
      kind: null,
    }
    const before = { source: 'matched' as const, document: { id: 'doc-old', file_name: 'a.pdf', mime_type: null }, inbox_item_id: 'inbox-1', facts }
    expect(readAfterPin(before, 'doc-new', 'b.pdf').facts).toBeNull()
    expect(readAfterPin({ ...before, document: { id: 'doc-new', file_name: 'b.pdf', mime_type: null } }, 'doc-new', 'b.pdf').facts).toBe(facts)
  })

  it('shows no underlag once it was taken off', () => {
    expect(readAfterUnpin()).toEqual({ source: null, document: null, inbox_item_id: null, facts: null })
  })
})

describe('heldUnderlag', () => {
  const pinnedUpload = upload({ id: 'doc-pinned', uploadKey: 'upload-1' })
  const second = upload({ id: 'doc-second', uploadKey: 'upload-2', fileName: 'second.pdf' })
  const pick = inboxDoc()

  it('leaves out the transaction\'s own underlag, which the row keeps', () => {
    expect(heldUnderlag({ files: [pinnedUpload, second], inboxDocs: [pick] }, 'doc-pinned')).toEqual({
      files: [second],
      inboxDocs: [pick],
    })
    expect(heldUnderlag({ files: [second], inboxDocs: [pick] }, 'doc-inbox-1')).toEqual({ files: [second], inboxDocs: [] })
  })

  it('holds everything when the row has no underlag (its pin failed)', () => {
    const attached = { files: [pinnedUpload, second], inboxDocs: [pick] }
    expect(heldUnderlag(attached, null)).toBe(attached)
  })

  it('so "Byt" never carries the row\'s own underlag into the next review', () => {
    expect(underlagToCarry(heldUnderlag({ files: [pinnedUpload], inboxDocs: [] }, 'doc-pinned'))).toBeNull()
    expect(underlagToCarry(heldUnderlag({ files: [pinnedUpload, second], inboxDocs: [] }, 'doc-pinned'))).toEqual({
      files: [second],
      inboxDocs: [],
    })
  })
})

describe('underlagLinkTargets', () => {
  it('links finished uploads, then picks with the inbox item each consumes, all against the row', () => {
    const attached = {
      files: [
        upload({ id: 'doc-a', fileName: 'a.pdf', uploadKey: 'upload-a' }),
        upload({ id: undefined, status: 'uploading', uploadKey: 'upload-b' }),
        upload({ id: undefined, status: 'error', uploadKey: 'upload-c' }),
      ],
      inboxDocs: [inboxDoc(), inboxDoc({ document_id: 'doc-inbox-2', inbox_item_id: 'inbox-2', supplier_name: null, file_name: 'kvitto.jpg' })],
    }
    expect(underlagLinkTargets(attached, 'tx-1')).toEqual([
      { documentId: 'doc-a', fileName: 'a.pdf', transactionId: 'tx-1' },
      { documentId: 'doc-inbox-1', fileName: 'Leverantör AB', inboxItemId: 'inbox-1', transactionId: 'tx-1' },
      { documentId: 'doc-inbox-2', fileName: 'kvitto.jpg', inboxItemId: 'inbox-2', transactionId: 'tx-1' },
    ])
  })

  it("links the document pinned to the row as well: an anchor the booking route failed to make is then reported", () => {
    const pinned = upload({ id: 'doc-pinned', uploadKey: 'upload-1', fileName: 'kvitto.pdf' })
    const second = upload({ id: 'doc-second', uploadKey: 'upload-2', fileName: 'second.pdf' })
    expect(underlagLinkTargets({ files: [pinned, second], inboxDocs: [] }, 'tx-1').map((t) => t.documentId)).toEqual([
      'doc-pinned',
      'doc-second',
    ])
  })

  it('links nothing when nothing is attached', () => {
    expect(underlagLinkTargets({ files: [], inboxDocs: [] }, 'tx-1')).toEqual([])
  })
})

describe('removedUpload', () => {
  const own = upload({ id: 'doc-own', uploadKey: 'upload-own' })
  const other = upload({ id: 'doc-other', uploadKey: 'upload-other' })

  it('reads the x in the upload list as a removal of that finished upload', () => {
    expect(removedUpload([own, other], [other])).toBe(own)
    expect(removedUpload([own, other], [own])).toBe(other)
  })

  it('matches on uploadKey: the same upload in another state, or a new drop, is no removal', () => {
    const stillUploading = { ...own, id: undefined, status: 'uploading' as const }
    expect(removedUpload([own, other], [stillUploading, other])).toBeNull()
    expect(removedUpload([own], [own, other])).toBeNull()
  })

  it('is null for an upload that never got a document id', () => {
    const failed = upload({ id: undefined, status: 'error', uploadKey: 'upload-failed' })
    expect(removedUpload([failed, other], [other])).toBeNull()
  })
})

describe('pinRefused', () => {
  it('reads a 4xx as a refusal the booking would meet too, and offline or a server error as not one', () => {
    expect(pinRefused(409)).toBe(true)
    expect(pinRefused(404)).toBe(true)
    expect(pinRefused(0)).toBe(false)
    expect(pinRefused(500)).toBe(false)
    expect(pinRefused(503)).toBe(false)
  })
})

describe('pinUnderlag / unpinUnderlag', () => {
  function response(status: number, body: unknown = {}): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
  }

  it('pins through the attach route, the one "Matcha mot underlag" and the agent use', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { data: {} }))
    await expect(pinUnderlag('tx-1', 'doc-1', fetchImpl)).resolves.toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledWith('/api/transactions/tx-1/attach-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document_id: 'doc-1' }),
    })
  })

  it('takes it off with DELETE on the same route', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { data: {} }))
    await expect(unpinUnderlag('tx-1', fetchImpl)).resolves.toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledWith('/api/transactions/tx-1/attach-document', { method: 'DELETE' })
  })

  it('hands a refusal back with its status and envelope, and never throws', async () => {
    const refusal = { error: { code: 'DOC_DETACH_POSTED', message: 'Underlaget är redan räkenskapsinformation.' } }
    await expect(unpinUnderlag('tx-1', vi.fn().mockResolvedValue(response(409, refusal)))).resolves.toEqual({
      ok: false,
      status: 409,
      body: refusal,
    })
    await expect(pinUnderlag('tx-1', 'doc-1', vi.fn().mockRejectedValue(new Error('offline')))).resolves.toEqual({
      ok: false,
      status: 0,
      body: null,
    })
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

  it('"Byt" hands over the held underlag (the row carries its own), and waits for an upload or a pin in flight', () => {
    expect(DIALOG_SRC).toContain('onChangeTemplate(underlagToCarry(held))')
    expect(DIALOG_SRC).toContain('disabled={uploadInFlight(uploadedFiles) || underlagState.busy}')
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
