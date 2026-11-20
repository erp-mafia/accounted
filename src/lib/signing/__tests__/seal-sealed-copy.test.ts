/**
 * Sealing a completed signing request with a seal certificate configured
 * (../seal.ts with ../pades-seal.ts): the signed copy carries the original
 * and a manifest, is sealed over all of it, and says so; the BankID
 * signatures stay out of it; a seal that fails holds the copy back for a
 * retry and, after a quarter of an hour, no longer does.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { P12Signer, PDF } from '@libpdf/core'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { sha256Hex } from '../document'
import type { SigningSeal } from '../pades-seal'
import type { SigningRequestRow } from '../types'
import { SIGNING_MAX_DOCUMENT_BYTES } from '../types'
import { COMPANY, DOC, MINUTE, REQ, attachStorage, onePagePdf, requestRow, testLogger, type TestLogger } from './fixtures'
import { TEST_SEAL_P12_BASE64, TEST_SEAL_PASSWORD, sealIntegrity } from './seal-fixture'

const upload = vi.hoisted(() => ({ uploadDocument: vi.fn() }))
vi.mock('@/lib/core/documents/document-service', () => upload)
vi.mock('@/lib/email/brand-sender', () => ({ getBaseUrlForCompany: vi.fn().mockResolvedValue('https://app.accounted.se') }))
const completedMail = vi.hoisted(() => ({ sendSigningCompletedMail: vi.fn() }))
vi.mock('@/lib/email/send-signing-completed', () => completedMail)
vi.mock('../brand', () => ({ signingSenderBrand: vi.fn().mockResolvedValue({ logoUrl: null, platformName: 'Accounted' }) }))
const configured = vi.hoisted(() => ({ loadSigningSeal: vi.fn() }))
vi.mock('../pades-seal', async (importOriginal) => ({ ...(await importOriginal<typeof import('../pades-seal')>()), loadSigningSeal: configured.loadSigningSeal }))

import { sealPdf } from '../pades-seal'
import { sealSigningRequest } from '../seal'

const STORAGE_PATH = `documents/${COMPANY}/${DOC}.pdf`
const b64 = (value: string | Uint8Array) => Buffer.from(value).toString('base64')
const XML_1 = '<?xml version="1.0"?><Signature><KeyInfo>cert of 199001011239</KeyInfo></Signature>'
const XML_2 = '<?xml version="1.0"?><Signature><KeyInfo>cert of 198112189876</KeyInfo></Signature>'
const OCSP_1 = new Uint8Array([0x30, 0x82, 0x01, 0x0a, 0xff])
const OCSP_2 = new Uint8Array([0x30, 0x82, 0x02, 0x0b, 0x00])
const SEALED_SENTENCE = 'Den här filen är elektroniskt förseglad och tidsstämplad'

const signers = [
  { id: 'signer-1', position: 1, name: 'Anna Andersson', email: 'anna@example.se', role_label: 'VD', signed_at: '2026-10-24T12:00:00.000Z', bankid_given_name: 'Anna', bankid_surname: 'Andersson' },
  { id: 'signer-2', position: 2, name: 'Erik E', email: null, role_label: null, signed_at: '2026-10-24T12:30:00.000Z', bankid_given_name: 'Erik', bankid_surname: 'Eriksson' },
]

let original: Uint8Array
let seal: SigningSeal
let db: ReturnType<typeof createTableMockSupabase>
let files: Map<string, Uint8Array>
let log: TestLogger
let request: SigningRequestRow

beforeAll(async () => {
  original = await onePagePdf('Hyresavtal mellan parterna')
  const signer = await P12Signer.create(new Uint8Array(Buffer.from(TEST_SEAL_P12_BASE64, 'base64')), TEST_SEAL_PASSWORD)
  // The bare signature: a timestamp needs an authority on the network.
  seal = { certificate: { subject: 'CN=Test', issuer: 'CN=Test', validFrom: '2026-01-01T00:00:00.000Z', validTo: '2126-01-01T00:00:00.000Z' }, apply: (pdf) => sealPdf(pdf, { signer, timestampAuthority: null, log: testLogger() }) }
})

const completed = (agoMs: number) =>
  requestRow({ status: 'completed', completed_at: new Date(Date.now() - agoMs).toISOString(), title: 'Hyresavtal 2026', document_sha256: sha256Hex(original), created_at: '2026-10-23T08:00:00.000Z' })

beforeEach(() => {
  vi.clearAllMocks()
  request = completed(MINUTE)
  const requests: TableMockResolver = (calls) => (calls.some((c) => c.method === 'update') ? { data: [{ id: REQ }] } : { data: request })
  db = createTableMockSupabase({
    signing_requests: requests,
    signing_request_signers: { data: signers },
    signing_signer_private: {
      data: [
        { signer_id: 'signer-1', personnummer_masked: 'XXXXXXXX-1239', signature_xml: b64(XML_1), ocsp_response: b64(OCSP_1) },
        { signer_id: 'signer-2', personnummer_masked: 'XXXXXXXX-9876', signature_xml: b64(XML_2), ocsp_response: b64(OCSP_2) },
      ],
    },
    document_attachments: { data: { file_name: 'hyresavtal.pdf', storage_path: STORAGE_PATH } },
    companies: { data: { name: 'Bolaget AB', team_id: null, org_number: '5566778899' } },
    profiles: { data: { full_name: 'Karin Byråsson' } },
  })
  files = new Map([[STORAGE_PATH, original]])
  attachStorage(db.supabase, files)
  ;(db.supabase as unknown as { auth: unknown }).auth = { admin: { getUserById: vi.fn().mockResolvedValue({ data: { user: { email: 'karin@byran.se' } } }) } }
  completedMail.sendSigningCompletedMail.mockResolvedValue({ sent: 2 })
  upload.uploadDocument.mockImplementation(async (_service: unknown, _user: string, _company: string, file: { name: string }) => ({
    id: file.name.endsWith('.pdf') ? 'signed-doc' : 'evidence-doc',
  }))
  configured.loadSigningSeal.mockResolvedValue(seal)
  log = testLogger()
})

const uploadedBytes = (index: number) => new Uint8Array((upload.uploadDocument.mock.calls[index] as [unknown, string, string, { buffer: ArrayBuffer }])[3].buffer)

async function lastPageText(bytes: Uint8Array): Promise<string> {
  const { getDocumentProxy, extractText } = await import('unpdf')
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: false })
  return text[text.length - 1]!.replace(/\s+/g, ' ').trim()
}

// Real PDF renders and a real signature: slower than a mock on a loaded runner.
describe('sealSigningRequest with a seal certificate', { timeout: 20_000 }, () => {
  it('seals the signed copy over all of it, with the original attached byte for byte, and says so on the Signeringsbevis', async () => {
    expect(await sealSigningRequest(db.supabase as never, REQ, log)).toEqual({ signedDocumentId: 'signed-doc', evidenceDocumentId: 'evidence-doc' })
    const signed = uploadedBytes(0)
    expect(sealIntegrity(signed)).toEqual({ coversWholeFile: true, digestMatches: true, subFilter: 'ETSI.CAdES.detached' })

    const pdf = await PDF.load(signed)
    expect([...pdf.getAttachments().keys()].sort()).toEqual(['original.pdf', 'signeringsbevis.json'])
    const attached = pdf.getAttachment('original.pdf')!
    expect(Buffer.from(attached).equals(Buffer.from(original))).toBe(true)
    // The hash every BankID signature was made over is the hash of the file inside.
    expect(sha256Hex(attached)).toBe(request.document_sha256)

    const evidence = await lastPageText(signed)
    expect(evidence).toContain(`${SEALED_SENTENCE}: en PDF-läsare visar om något har ändrats efter förseglingen. Originalfilen ligger med som bilaga.`)
    expect(evidence).toContain('bevispaketet i Bolaget AB:s arkiv')
    expect(log.info).toHaveBeenCalledWith('signed copy sealed', { signingRequestId: REQ, bytes: signed.length })
  })

  it('names each BankID signature by its fingerprint in the attached manifest, and carries neither a signature nor a full personnummer', async () => {
    await sealSigningRequest(db.supabase as never, REQ, log)
    const signed = uploadedBytes(0)
    const manifest = JSON.parse(Buffer.from((await PDF.load(signed)).getAttachment('signeringsbevis.json')!).toString('utf8'))
    expect(manifest).toEqual({
      format: 'accounted.signing.sealed-copy/1',
      signing_request_id: REQ,
      title: 'Hyresavtal 2026',
      company: { name: 'Bolaget AB', org_number: '5566778899' },
      document: { file_name: 'hyresavtal.pdf', sha256: sha256Hex(original), attachment: 'original.pdf' },
      annual_report_version_id: null,
      created_at: '2026-10-23T08:00:00.000Z',
      completed_at: request.completed_at,
      method: expect.stringContaining('BankID'),
      signers: [
        { position: 1, name: 'Anna Andersson', role: 'VD', bankid_name: 'Anna Andersson', personnummer_masked: 'XXXXXXXX-1239', signed_at: '2026-10-24T12:00:00.000Z', signature_sha256: sha256Hex(Buffer.from(XML_1)), ocsp_sha256: sha256Hex(OCSP_1) },
        { position: 2, name: 'Erik E', role: null, bankid_name: 'Erik Eriksson', personnummer_masked: 'XXXXXXXX-9876', signed_at: '2026-10-24T12:30:00.000Z', signature_sha256: sha256Hex(Buffer.from(XML_2)), ocsp_sha256: sha256Hex(OCSP_2) },
      ],
      evidence: expect.stringContaining('evidence package'),
    })
    const everything = Buffer.from(signed).toString('latin1')
    for (const secret of ['199001011239', '198112189876', '<Signature>']) expect(everything).not.toContain(secret)

    // The fingerprints are those of the files in the evidence package, which is as it was.
    const zip = await JSZip.loadAsync(uploadedBytes(1))
    expect(Object.keys(zip.files).sort()).toEqual(['manifest.json', 'ocsp-1.der', 'ocsp-2.der', 'original.pdf', 'signatur-1.xml', 'signatur-2.xml'])
    expect(sha256Hex(await zip.file('signatur-1.xml')!.async('uint8array'))).toBe(manifest.signers[0].signature_sha256)
    expect(sha256Hex(await zip.file('ocsp-2.der')!.async('uint8array'))).toBe(manifest.signers[1].ocsp_sha256)
  })

  it('leaves an original over half the largest signable PDF out of the copy, which then says only that it is sealed', async () => {
    // A stream no page uses: bytes that do not compress, so the file is as large as it looks.
    const { PDFDocument } = await import('pdf-lib')
    const { randomBytes } = await import('node:crypto')
    const big = await PDFDocument.load(original)
    big.context.register(big.context.stream(randomBytes(SIGNING_MAX_DOCUMENT_BYTES / 2 + 1024)))
    const large = await big.save({ useObjectStreams: false })
    expect(large.length).toBeGreaterThan(SIGNING_MAX_DOCUMENT_BYTES / 2)
    files.set(STORAGE_PATH, large)
    request = requestRow({ ...request, document_sha256: sha256Hex(large) })

    await sealSigningRequest(db.supabase as never, REQ, log)
    const signed = uploadedBytes(0)
    expect(sealIntegrity(signed)).toMatchObject({ coversWholeFile: true, digestMatches: true })
    const pdf = await PDF.load(signed)
    expect([...pdf.getAttachments().keys()]).toEqual(['signeringsbevis.json'])
    const manifest = JSON.parse(Buffer.from(pdf.getAttachment('signeringsbevis.json')!).toString('utf8'))
    expect(manifest.document).toEqual({ file_name: 'hyresavtal.pdf', sha256: sha256Hex(large), attachment: null })
    const evidence = await lastPageText(signed)
    expect(evidence).toContain(SEALED_SENTENCE)
    expect(evidence).not.toContain('Originalfilen ligger med som bilaga')
  })

  it('mails the sealed copy, the same bytes it archives', async () => {
    await sealSigningRequest(db.supabase as never, REQ, log)
    const sent = completedMail.sendSigningCompletedMail.mock.calls[0]![0] as { pdf: { bytes: Uint8Array }; pageCount: number }
    expect(Buffer.from(sent.pdf.bytes).equals(Buffer.from(uploadedBytes(0)))).toBe(true)
    expect(sent.pageCount).toBe(1)
  })

  it('holds the copy back when the seal fails soon after the last signature: nothing is archived or mailed, a later read tries again', async () => {
    configured.loadSigningSeal.mockResolvedValue({ ...seal, apply: vi.fn().mockRejectedValue(new Error('tsa down')) })
    await expect(sealSigningRequest(db.supabase as never, REQ, log)).rejects.toThrow('tsa down')
    expect(upload.uploadDocument).not.toHaveBeenCalled()
    expect(db.payloads('signing_requests', 'update')).toEqual([])
    expect(completedMail.sendSigningCompletedMail).not.toHaveBeenCalled()
  })

  it('archives the copy without a seal once the seal has kept failing for a quarter of an hour, and says so in the log', async () => {
    request = completed(16 * MINUTE)
    configured.loadSigningSeal.mockRejectedValue(new Error('certificate file does not open'))
    expect(await sealSigningRequest(db.supabase as never, REQ, log)).toEqual({ signedDocumentId: 'signed-doc', evidenceDocumentId: 'evidence-doc' })
    expect(log.error).toHaveBeenCalledWith('signing seal kept failing, archiving the signed copy without it', expect.objectContaining({ message: 'certificate file does not open' }), { signingRequestId: REQ })
    const signed = uploadedBytes(0)
    expect(sealIntegrity(signed)).toBeNull()
    expect((await PDF.load(signed)).getAttachments().size).toBe(0)
    expect(await lastPageText(signed)).not.toContain(SEALED_SENTENCE)
  })

  it('makes the plain signed copy while no seal is configured: no attachment, no word about a seal', async () => {
    configured.loadSigningSeal.mockResolvedValue(null)
    await sealSigningRequest(db.supabase as never, REQ, log)
    const signed = uploadedBytes(0)
    expect(sealIntegrity(signed)).toBeNull()
    expect((await PDF.load(signed)).getAttachments().size).toBe(0)
    expect(await lastPageText(signed)).not.toContain(SEALED_SENTENCE)
    expect(log.info).not.toHaveBeenCalledWith('signed copy sealed', expect.anything())
  })
})
