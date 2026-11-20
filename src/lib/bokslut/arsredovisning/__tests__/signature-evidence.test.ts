import { describe, it, expect } from 'vitest'
import {
  documentEvidenceReference,
  evidenceDocumentId,
  orderEvidenceCandidates,
} from '../signature-evidence'
import { SignatureSignedSchema } from '../workflow-schemas'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

const DOCUMENT_ID = '7c1f2a9e-3b4d-4e5f-9a6b-1c2d3e4f5a6b'
const VERSION_ID = '4e7d0c43-9f5e-4a8f-8a43-2f0c1f6f3e11'

describe('signature evidence from the archive (PH 186)', () => {
  it('turns an archive document into a reference the signature route accepts', () => {
    const reference = documentEvidenceReference(DOCUMENT_ID)
    expect(reference).toBe(`document:${DOCUMENT_ID}`)
    const parsed = SignatureSignedSchema.safeParse({
      status: 'signed',
      annual_report_version_id: VERSION_ID,
      signing_method: 'paper_original',
      evidence_reference: reference,
      signed_at: '2027-03-05T10:00:00.000Z',
    })
    expect(parsed.success).toBe(true)
  })

  it('reads the document back from a document reference and nothing else', () => {
    expect(evidenceDocumentId(`document:${DOCUMENT_ID}`)).toBe(DOCUMENT_ID)
    expect(evidenceDocumentId(` document:${DOCUMENT_ID} `)).toBe(DOCUMENT_ID)
    expect(evidenceDocumentId('archive:AR-2026-001')).toBeNull()
    expect(evidenceDocumentId('document:')).toBeNull()
    expect(evidenceDocumentId('')).toBeNull()
  })

  it('lists documents typed as an årsredovisning first, then the latest upload first', () => {
    const ordered = orderEvidenceCandidates([
      { document_id: 'receipt-old', created_at: '2027-02-01T10:00:00Z', doc_type: 'receipt' },
      { document_id: 'annual-old', created_at: '2026-03-01T10:00:00Z', doc_type: 'annual_report' },
      { document_id: 'untyped-new', created_at: '2027-03-05T16:00:00Z', doc_type: null },
      { document_id: 'annual-new', created_at: '2027-03-05T15:00:00Z', doc_type: 'annual_report' },
    ])
    expect(ordered.map((document) => document.document_id)).toEqual([
      'annual-new',
      'annual-old',
      'untyped-new',
      'receipt-old',
    ])
  })

  it('has every string of the evidence picker in both locales', () => {
    const keys = [
      'signature_document_label',
      'signature_document_placeholder',
      'signature_document_empty',
      'signature_document_upload',
      'signature_document_uploading',
      'signature_document_upload_error',
      'signature_document_help',
      'signature_reference_label',
      'signature_evidence_hint',
    ]
    for (const key of keys) {
      expect(sv.annualReportSteps).toHaveProperty(key)
      expect(en.annualReportSteps).toHaveProperty(key)
    }
  })
})
