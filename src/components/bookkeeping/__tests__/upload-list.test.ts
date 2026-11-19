import { describe, it, expect } from 'vitest'
import type { UploadedFile } from '../DocumentUploadZone'
import { addUploads, finishUpload, removeUpload, type UploadedFilesUpdate } from '../upload-list'

/**
 * crm#1101: DocumentUploadZone reported whole lists built from the list each
 * drop started from, so an upload that finished after a later drop or a
 * removal undid it. It now hands its host updates of the latest list. These
 * run the two sequences against a host that passes its useState setter as
 * onFilesChange (JournalEntryForm, JournalEntryAttachments); the booking
 * dialogs' own handling is in
 * components/transactions/__tests__/booking-dialog-uploads.test.ts.
 */

function pending(key: string): UploadedFile {
  return { file: {} as File, status: 'uploading', fileName: `${key}.pdf`, fileSize: 1000, uploadKey: key }
}

function uploaded(file: UploadedFile): UploadedFile {
  return { ...file, status: 'uploaded', id: `doc-${file.uploadKey}` }
}

/** A host whose onFilesChange is its state setter: every update lands on the state as it then is. */
function stateHost(initial: UploadedFile[] = []) {
  let files = initial
  return {
    files: () => files,
    onFilesChange: (update: UploadedFilesUpdate) => {
      files = update(files)
    },
  }
}

const statuses = (files: UploadedFile[]) => files.map((f) => `${f.uploadKey}:${f.status}`)

describe('the updates', () => {
  it('a drop appends to the list as it is', () => {
    const listed = [uploaded(pending('a'))]
    expect(addUploads([pending('b')])(listed)).toEqual([uploaded(pending('a')), pending('b')])
  })

  it('a finished upload takes its own place by uploadKey, a failed one too', () => {
    const listed = [pending('a'), pending('b')]
    const failed: UploadedFile = { ...pending('b'), status: 'error', error: 'För stor fil' }
    expect(finishUpload(uploaded(pending('a')))(listed)).toEqual([uploaded(pending('a')), pending('b')])
    expect(finishUpload(failed)(listed)).toEqual([pending('a'), failed])
  })

  it('a finished upload the host no longer lists stays out, and the list comes back as it was', () => {
    const listed = [pending('b')]
    expect(finishUpload(uploaded(pending('a')))(listed)).toBe(listed)
  })

  it('the x removes by uploadKey', () => {
    expect(removeUpload('a')([uploaded(pending('a')), pending('b')])).toEqual([pending('b')])
  })
})

describe('overlapping uploads', () => {
  it('a file dropped while another one uploads is kept, and both land', () => {
    const host = stateHost()
    const a = pending('a')
    const b = pending('b')

    host.onFilesChange(addUploads([a]))
    // B is dropped while A is still on its way.
    host.onFilesChange(addUploads([b]))
    host.onFilesChange(finishUpload(uploaded(a)))
    expect(statuses(host.files())).toEqual(['a:uploaded', 'b:uploading'])

    host.onFilesChange(finishUpload(uploaded(b)))
    expect(statuses(host.files())).toEqual(['a:uploaded', 'b:uploaded'])
  })

  it('a file removed while another one uploads stays removed when that one lands', () => {
    const host = stateHost()
    const a = pending('a')
    const b = pending('b')

    host.onFilesChange(addUploads([a, b]))
    host.onFilesChange(finishUpload(uploaded(a)))
    // The x on A while B is still on its way.
    host.onFilesChange(removeUpload('a'))
    host.onFilesChange(finishUpload(uploaded(b)))

    expect(host.files()).toEqual([uploaded(b)])
  })

  it('a list the host cleared stays clear when an upload lands after it', () => {
    const host = stateHost()
    host.onFilesChange(addUploads([pending('a')]))
    host.onFilesChange(() => [])
    host.onFilesChange(finishUpload(uploaded(pending('a'))))
    expect(host.files()).toEqual([])
  })
})
