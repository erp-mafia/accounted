import { describe, expect, it } from 'vitest'
import { SIGNABLE_FILE_ACCEPT, SIGNABLE_MIME_TYPE, isSignableMimeType, signableFileRefusal } from '../signable-file'
import { SIGNING_MAX_DOCUMENT_BYTES } from '../types'

describe('isSignableMimeType', () => {
  it('takes a PDF and nothing else', () => {
    expect(isSignableMimeType('application/pdf')).toBe(true)
    expect(isSignableMimeType('image/png')).toBe(false)
    expect(isSignableMimeType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(false)
    expect(isSignableMimeType('application/octet-stream')).toBe(false)
    expect(isSignableMimeType('')).toBe(false)
    expect(isSignableMimeType(null)).toBe(false)
    expect(isSignableMimeType(undefined)).toBe(false)
  })
})

describe('signableFileRefusal', () => {
  it('lets a PDF through', () => {
    expect(signableFileRefusal({ name: 'avtal.pdf', type: 'application/pdf', size: 120_000 })).toBeNull()
  })

  it('reads the type from the extension when the browser declared none or only the generic one', () => {
    expect(signableFileRefusal({ name: 'Avtal.PDF', type: '', size: 120_000 })).toBeNull()
    expect(signableFileRefusal({ name: 'avtal.pdf', type: 'application/octet-stream', size: 120_000 })).toBeNull()
  })

  it('refuses what is not a PDF, whatever its name says', () => {
    expect(signableFileRefusal({ name: 'avtal.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 120_000 })).toBe('not_pdf')
    expect(signableFileRefusal({ name: 'kvitto.jpg', type: 'image/jpeg', size: 120_000 })).toBe('not_pdf')
    expect(signableFileRefusal({ name: 'avtal.pdf', type: 'image/png', size: 120_000 })).toBe('not_pdf')
    expect(signableFileRefusal({ name: 'avtal', type: '', size: 120_000 })).toBe('not_pdf')
    expect(signableFileRefusal({ name: null, type: null, size: 120_000 })).toBe('not_pdf')
  })

  it('refuses a PDF over the signing limit and takes one exactly at it', () => {
    expect(signableFileRefusal({ name: 'avtal.pdf', type: 'application/pdf', size: SIGNING_MAX_DOCUMENT_BYTES })).toBeNull()
    expect(signableFileRefusal({ name: 'avtal.pdf', type: 'application/pdf', size: SIGNING_MAX_DOCUMENT_BYTES + 1 })).toBe('too_large')
  })

  it('names the type before the size', () => {
    expect(signableFileRefusal({ name: 'film.mov', type: 'video/quicktime', size: SIGNING_MAX_DOCUMENT_BYTES * 4 })).toBe('not_pdf')
  })
})

describe('SIGNABLE_FILE_ACCEPT', () => {
  it('offers PDFs only, by extension and by type', () => {
    expect(SIGNABLE_FILE_ACCEPT.split(',')).toEqual(['.pdf', SIGNABLE_MIME_TYPE])
  })
})
