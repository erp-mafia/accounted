import { describe, expect, it } from 'vitest'
import {
  ALLOWED_DOCUMENT_TYPES,
  DOCUMENT_UPLOAD_ACCEPT,
  declaredDocumentType,
  isAllowedDocumentFile,
} from '../upload-types'

describe('declaredDocumentType', () => {
  it('reads a .csv as text/csv whatever the browser called it (crm#268)', () => {
    expect(declaredDocumentType({ name: 'export.csv', type: 'text/csv' })).toBe('text/csv')
    // Windows with Excel installed
    expect(declaredDocumentType({ name: 'export.csv', type: 'application/vnd.ms-excel' })).toBe('text/csv')
    expect(declaredDocumentType({ name: 'EXPORT.CSV', type: '' })).toBe('text/csv')
    expect(declaredDocumentType({ name: 'export.csv', type: 'application/octet-stream' })).toBe('text/csv')
    expect(declaredDocumentType({ name: 'export.csv', type: 'text/plain' })).toBe('text/csv')
  })

  it('keeps a real Excel file Excel, and never rewrites a declared type for other extensions', () => {
    expect(declaredDocumentType({ name: 'bok.xls', type: 'application/vnd.ms-excel' })).toBe('application/vnd.ms-excel')
    expect(declaredDocumentType({ name: 'kvitto.pdf', type: 'image/jpeg' })).toBe('image/jpeg')
    expect(declaredDocumentType({ name: 'anteckning.txt', type: 'text/plain' })).toBe('text/plain')
  })

  it('takes office types from the extension when the browser declared none', () => {
    expect(declaredDocumentType({ name: 'avtal.docx', type: '' })).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(declaredDocumentType({ name: 'protokoll.odt', type: 'application/octet-stream' })).toBe(
      'application/vnd.oasis.opendocument.text',
    )
    expect(declaredDocumentType({ name: 'IMG_7484.heic', type: '' })).toBe('image/heic')
    expect(declaredDocumentType({ name: 'okänd.xyz', type: '' })).toBe('')
    expect(declaredDocumentType({ name: 'utan-filändelse', type: '' })).toBe('')
    expect(declaredDocumentType({ name: null, type: '' })).toBe('')
  })
})

describe('isAllowedDocumentFile', () => {
  it('accepts CSV, office files and receipts, refuses the rest', () => {
    expect(isAllowedDocumentFile({ name: 'export.csv', type: 'application/vnd.ms-excel' })).toBe(true)
    expect(isAllowedDocumentFile({ name: 'export.csv', type: '' })).toBe(true)
    expect(isAllowedDocumentFile({ name: 'avtal.docx', type: '' })).toBe(true)
    expect(isAllowedDocumentFile({ name: 'kvitto.pdf', type: 'application/pdf' })).toBe(true)
    expect(isAllowedDocumentFile({ name: 'IMG_7484.heic', type: '' })).toBe(true)
    expect(isAllowedDocumentFile({ name: 'run.exe', type: 'application/x-msdownload' })).toBe(false)
    expect(isAllowedDocumentFile({ name: 'arkiv.zip', type: 'application/zip' })).toBe(false)
  })
})

describe('DOCUMENT_UPLOAD_ACCEPT', () => {
  it('offers exactly the extensions whose type the allowlist accepts', () => {
    const extensions = DOCUMENT_UPLOAD_ACCEPT.split(',')
    expect(extensions).toContain('.csv')
    expect(extensions).toContain('.heic')
    for (const ext of extensions) {
      expect(ext.startsWith('.')).toBe(true)
      expect(ALLOWED_DOCUMENT_TYPES).toContain(declaredDocumentType({ name: `f${ext}`, type: '' }))
    }
  })
})
