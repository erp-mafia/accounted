import { describe, it, expect } from 'vitest'
import {
  documentIdFromPlainUpload,
  plainDocumentUploadForm,
  underlagUploadRoute,
} from '../underlag-upload-route'

describe('underlagUploadRoute', () => {
  it('uses the document inbox when the company has the AI capability', () => {
    expect(underlagUploadRoute({ hasAiCapability: true })).toBe('inbox')
  })

  it('uses the plain documents upload when the company lacks it', () => {
    expect(underlagUploadRoute({ hasAiCapability: false })).toBe('documents')
  })
})

describe('plainDocumentUploadForm', () => {
  it('marks the upload as a picked file and leaves the file to the sender', () => {
    const form = plainDocumentUploadForm()
    expect(form.get('upload_source')).toBe('file_upload')
    expect(form.get('file')).toBeNull()
  })
})

describe('documentIdFromPlainUpload', () => {
  it('reads the id of the stored document', () => {
    expect(documentIdFromPlainUpload({ data: { id: 'doc-1' } })).toBe('doc-1')
  })

  it('answers null for an error envelope, even one that carries data', () => {
    expect(documentIdFromPlainUpload({ error: { code: 'X' } })).toBeNull()
    expect(documentIdFromPlainUpload({ data: { id: 'doc-1' }, error: 'x' })).toBeNull()
  })

  it('answers null when the id is missing or not a string', () => {
    expect(documentIdFromPlainUpload(null)).toBeNull()
    expect(documentIdFromPlainUpload('nope')).toBeNull()
    expect(documentIdFromPlainUpload({})).toBeNull()
    expect(documentIdFromPlainUpload({ data: null })).toBeNull()
    expect(documentIdFromPlainUpload({ data: { id: '' } })).toBeNull()
    expect(documentIdFromPlainUpload({ data: { id: 42 } })).toBeNull()
  })
})
