/**
 * Sealing a completed signing request (../seal.ts): the signed PDF is the
 * original plus one evidence page, Bevispaket.zip carries the original byte
 * for byte, each signature and OCSP response and a manifest with the hash,
 * both go to the archive once, and nothing is sealed from a stored file that
 * no longer hashes to what was signed.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { PDFArray, PDFDocument, PDFRawStream, PDFStream, decodePDFRawStream } from 'pdf-lib'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { sha256Hex } from '../document'
import type { SigningRequestRow } from '../types'
import { COMPANY, DOC, HOUR, PN, REQ, SENDER, attachStorage, onePagePdf, requestRow, testLogger, type TestLogger } from './fixtures'

const upload = vi.hoisted(() => ({ uploadDocument: vi.fn() }))
vi.mock('@/lib/core/documents/document-service', () => upload)

import { ensureSealed, sealSigningRequest } from '../seal'

const STORAGE_PATH = `documents/${COMPANY}/${DOC}.pdf`
const COMPLETED_AT = '2026-10-24T12:30:00.000Z'
const b64 = (value: string | Uint8Array) => Buffer.from(value).toString('base64')
const XML_1 = '<?xml version="1.0"?><Signature><KeyInfo>cert of 199001011239</KeyInfo></Signature>'
const XML_2 = '<?xml version="1.0"?><Signature><KeyInfo>cert of 198112189876</KeyInfo></Signature>'
const OCSP_1 = new Uint8Array([0x30, 0x82, 0x01, 0x0a, 0xff])
const OCSP_2 = new Uint8Array([0x30, 0x82, 0x02, 0x0b, 0x00])

let original: Uint8Array
let db: ReturnType<typeof createTableMockSupabase>
let files: Map<string, Uint8Array>
let log: TestLogger
let request: SigningRequestRow | null
let sealedRows: Array<{ id: string }>

const signers = [
  { id: 'signer-1', position: 1, name: 'Anna Andersson', role_label: 'VD', signed_at: '2026-10-24T12:00:00.000Z', bankid_given_name: 'Anna', bankid_surname: 'Andersson' },
  { id: 'signer-2', position: 2, name: 'Erik E', role_label: null, signed_at: '2026-10-24T12:30:00.000Z', bankid_given_name: 'Erik', bankid_surname: 'Eriksson' },
]
let privates: Array<Record<string, unknown>>

beforeAll(async () => {
  original = await onePagePdf('Hyresavtal mellan parterna')
})

const requests: TableMockResolver = (calls) => (calls.some((c) => c.method === 'update') ? { data: sealedRows } : { data: request })

beforeEach(() => {
  vi.clearAllMocks()
  request = requestRow({ status: 'completed', completed_at: COMPLETED_AT, title: 'Hyresavtal 2026', document_sha256: sha256Hex(original), created_at: '2026-10-23T08:00:00.000Z' })
  sealedRows = [{ id: REQ }]
  privates = [
    { signer_id: 'signer-1', personnummer_masked: 'XXXXXXXX-1239', signature_xml: b64(XML_1), ocsp_response: b64(OCSP_1) },
    { signer_id: 'signer-2', personnummer_masked: 'XXXXXXXX-9876', signature_xml: b64(XML_2), ocsp_response: b64(OCSP_2) },
  ]
  db = createTableMockSupabase({
    signing_requests: requests,
    signing_request_signers: { data: signers },
    signing_signer_private: () => ({ data: privates }),
    document_attachments: { data: { file_name: 'hyresavtal.pdf', storage_path: STORAGE_PATH } },
    companies: { data: { name: 'Bolaget AB', team_id: null } },
    profiles: { data: { full_name: 'Karin Byråsson' } },
  })
  files = new Map([[STORAGE_PATH, original]])
  attachStorage(db.supabase, files)
  log = testLogger()
  upload.uploadDocument.mockImplementation(async (_service: unknown, _user: string, _company: string, file: { name: string }) => ({
    id: file.name.endsWith('.pdf') ? 'signed-doc' : 'evidence-doc',
  }))
})

const uploaded = (index: number) => upload.uploadDocument.mock.calls[index] as [unknown, string, string, { name: string; buffer: ArrayBuffer; type: string }, Record<string, unknown>]

/** The text pdf-lib drew on a page (standard fonts: WinAnsi hex strings shown with Tj). */
function pageText(pdf: PDFDocument, index: number): string[] {
  const contents = pdf.getPages()[index]!.node.Contents()
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => pdf.context.lookup(ref)) : [contents]
  const lines: string[] = []
  for (const stream of streams) {
    if (!(stream instanceof PDFStream)) continue
    const bytes = stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents()
    for (const match of Buffer.from(bytes).toString('latin1').matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      lines.push(Buffer.from(match[1]!, 'hex').toString('latin1'))
    }
  }
  return lines
}

describe('sealSigningRequest', () => {
  it('archives the signed PDF and the evidence package in the sender\'s name and points the request at them once', async () => {
    expect(await sealSigningRequest(db.supabase as never, REQ, log)).toEqual({ signedDocumentId: 'signed-doc', evidenceDocumentId: 'evidence-doc' })
    expect(upload.uploadDocument).toHaveBeenCalledTimes(2)
    const [service, user, company, signedFile, signedMeta] = uploaded(0)
    expect([service, user, company]).toEqual([db.supabase, SENDER, COMPANY])
    expect(signedFile).toMatchObject({ name: 'hyresavtal-2026-signerad.pdf', type: 'application/pdf' })
    expect(signedMeta).toEqual({ upload_source: 'system', extractionOwner: 'none' })
    expect(uploaded(1)[3]).toMatchObject({ name: 'hyresavtal-2026-bevispaket.zip', type: 'application/zip' })
    expect(db.payloads('signing_requests', 'update')).toEqual([{ signed_document_id: 'signed-doc', evidence_document_id: 'evidence-doc' }])
    expect(db.findCalls('signing_requests', 'is')).toEqual([['signed_document_id', null], ['evidence_document_id', null]])
    expect(db.findCalls('signing_requests', 'eq')).toEqual(expect.arrayContaining([['status', 'completed']]))
    expect(log.info).toHaveBeenCalledWith('signing request sealed', { signingRequestId: REQ, signedDocumentId: 'signed-doc', evidenceDocumentId: 'evidence-doc' })
  })

  it('makes the signed PDF the original pages plus one evidence page naming each signer, with the masked personnummer only', async () => {
    await sealSigningRequest(db.supabase as never, REQ, log)
    const signed = await PDFDocument.load(new Uint8Array(uploaded(0)[3].buffer))
    const before = await PDFDocument.load(original)
    expect(signed.getPageCount()).toBe(before.getPageCount() + 1)
    expect(signed.getTitle()).toBe('Hyresavtal 2026 (signerad)')
    expect(pageText(before, 0)).toEqual(['Hyresavtal mellan parterna'])
    expect(pageText(signed, 0)).toEqual(pageText(before, 0))

    const evidence = pageText(signed, signed.getPageCount() - 1).join('\n')
    expect(evidence).toContain('Signeringsbevis')
    expect(evidence).toContain('Hyresavtal 2026')
    expect(evidence).toContain('Företag: Bolaget AB')
    expect(evidence).toContain('Dokument: hyresavtal.pdf')
    expect(evidence.replace(/\n/g, '')).toContain(`Kontrollsumma (SHA-256): ${sha256Hex(original)}`)
    expect(evidence).toContain(`Signerings-id: ${REQ}`)
    expect(evidence).toContain('Skickad för signering av Karin Byråsson')
    expect(evidence).toContain('1. Anna Andersson, VD')
    expect(evidence).toContain('personnummer XXXXXXXX-1239')
    expect(evidence).toContain('2. Erik Eriksson')
    // The name the sender typed differs from the BankID name: both are shown.
    expect(evidence).toContain('Namn i signeringen: Erik E')
    expect(evidence).not.toContain('Namn i signeringen: Anna Andersson')
    expect(evidence).not.toContain(PN)
    expect(evidence).not.toContain('198112189876')
    expect(evidence).not.toContain('Årsredovisningens datering')
  })

  it('dates an årsredovisning by its first signature on the evidence page', async () => {
    request = requestRow({ ...request!, annual_report_version_id: 'version-1' })
    await sealSigningRequest(db.supabase as never, REQ, log)
    const signed = await PDFDocument.load(new Uint8Array(uploaded(0)[3].buffer))
    expect(pageText(signed, signed.getPageCount() - 1).join('\n')).toContain('Årsredovisningens datering: 2026-10-24 (dagen för den första underskriften)')
  })

  it('packs the original byte for byte, each signature and OCSP response, and a manifest with the hash', async () => {
    await sealSigningRequest(db.supabase as never, REQ, log)
    const zip = await JSZip.loadAsync(new Uint8Array(uploaded(1)[3].buffer))
    expect(Object.keys(zip.files).sort()).toEqual(['manifest.json', 'ocsp-1.der', 'ocsp-2.der', 'original.pdf', 'signatur-1.xml', 'signatur-2.xml'])
    const packed = await zip.file('original.pdf')!.async('uint8array')
    expect(Buffer.from(packed).equals(Buffer.from(original))).toBe(true)
    expect(sha256Hex(packed)).toBe(request!.document_sha256)
    expect(await zip.file('signatur-1.xml')!.async('string')).toBe(XML_1)
    expect(await zip.file('signatur-2.xml')!.async('string')).toBe(XML_2)
    expect(Buffer.from(await zip.file('ocsp-1.der')!.async('uint8array')).equals(Buffer.from(OCSP_1))).toBe(true)
    expect(Buffer.from(await zip.file('ocsp-2.der')!.async('uint8array')).equals(Buffer.from(OCSP_2))).toBe(true)

    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
    expect(manifest).toMatchObject({
      format: 'accounted.signing.evidence/1',
      signing_request_id: REQ,
      title: 'Hyresavtal 2026',
      company_id: COMPANY,
      document: { file_name: 'hyresavtal.pdf', sha256: sha256Hex(original), file: 'original.pdf' },
      annual_report_version_id: null,
      completed_at: COMPLETED_AT,
    })
    expect(manifest.signers).toEqual([
      {
        position: 1,
        name: 'Anna Andersson',
        role: 'VD',
        bankid_name: 'Anna Andersson',
        personnummer_masked: 'XXXXXXXX-1239',
        signed_at: '2026-10-24T12:00:00.000Z',
        signature_file: 'signatur-1.xml',
        signature_sha256: sha256Hex(Buffer.from(XML_1)),
        ocsp_file: 'ocsp-1.der',
      },
      {
        position: 2,
        name: 'Erik E',
        role: null,
        bankid_name: 'Erik Eriksson',
        personnummer_masked: 'XXXXXXXX-9876',
        signed_at: '2026-10-24T12:30:00.000Z',
        signature_file: 'signatur-2.xml',
        signature_sha256: sha256Hex(Buffer.from(XML_2)),
        ocsp_file: 'ocsp-2.der',
      },
    ])
  })

  it('refuses, and archives nothing, when the stored original no longer hashes to what was signed', async () => {
    files.set(STORAGE_PATH, await onePagePdf('Ett ändrat avtal'))
    await expect(sealSigningRequest(db.supabase as never, REQ, log)).rejects.toThrow('Original document no longer matches the signed hash')
    expect(upload.uploadDocument).not.toHaveBeenCalled()
    expect(db.payloads('signing_requests', 'update')).toEqual([])
  })

  it('refuses when the original is not in storage', async () => {
    files.clear()
    await expect(sealSigningRequest(db.supabase as never, REQ, log)).rejects.toThrow('Original document not in storage')
    expect(upload.uploadDocument).not.toHaveBeenCalled()
  })

  it('refuses when a signed signer has no stored signature', async () => {
    privates = privates.slice(0, 1)
    await expect(sealSigningRequest(db.supabase as never, REQ, log)).rejects.toThrow('A signed signer has no stored signature')
    expect(upload.uploadDocument).not.toHaveBeenCalled()
  })

  it('seals nothing for a request that is not completed, is already sealed, or is gone', async () => {
    request = requestRow({ status: 'open' })
    expect(await sealSigningRequest(db.supabase as never, REQ, log)).toBeNull()
    request = requestRow({ status: 'completed', completed_at: COMPLETED_AT, signed_document_id: 'a', evidence_document_id: 'b' })
    expect(await sealSigningRequest(db.supabase as never, REQ, log)).toBeNull()
    request = null
    expect(await sealSigningRequest(db.supabase as never, REQ, log)).toBeNull()
    expect(upload.uploadDocument).not.toHaveBeenCalled()
  })

  it('answers null and leaves its copies unreferenced when another seal won the race', async () => {
    sealedRows = []
    expect(await sealSigningRequest(db.supabase as never, REQ, log)).toBeNull()
    expect(upload.uploadDocument).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('sealed by another call'), { signingRequestId: REQ })
  })
})

describe('ensureSealed', () => {
  const NOW = Date.parse(COMPLETED_AT) + 3 * 60 * 1000
  const completed = { id: REQ, status: 'completed' as const, completed_at: COMPLETED_AT, signed_document_id: null, evidence_document_id: null }

  it('leaves alone a request that is not completed, already sealed, or completed under two minutes ago', async () => {
    await ensureSealed(db.supabase as never, { ...completed, status: 'open' }, log, NOW)
    await ensureSealed(db.supabase as never, { ...completed, signed_document_id: 'a', evidence_document_id: 'b' }, log, NOW)
    await ensureSealed(db.supabase as never, completed, log, Date.parse(COMPLETED_AT) + 60 * 1000)
    await ensureSealed(db.supabase as never, { ...completed, completed_at: null }, log, NOW)
    expect(db.tables()).toEqual([])
  })

  it('seals again a completed request whose seal never landed, and only logs a failure', async () => {
    await ensureSealed(db.supabase as never, completed, log, NOW)
    expect(upload.uploadDocument).toHaveBeenCalledTimes(2)
    files.clear()
    await ensureSealed(db.supabase as never, completed, log, NOW + HOUR)
    expect(log.error).toHaveBeenCalledWith('signing request seal retry failed', expect.any(Error), { signingRequestId: REQ })
  })
})
