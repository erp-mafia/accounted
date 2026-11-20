/**
 * Sealing a completed signing request (../seal.ts): the signed PDF is the
 * original, every page stamped in its bottom margin, plus the
 * Signeringsbevis page(s); Bevispaket.zip carries the original byte for
 * byte, each signature and OCSP response and a manifest with the hash, both
 * go to the archive once, and nothing is sealed from a stored file that no
 * longer hashes to what was signed.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { PDFDict, PDFDocument, PDFName, PDFStream, StandardFonts, degrees } from 'pdf-lib'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { sha256Hex } from '../document'
import type { SigningRequestRow } from '../types'
import { COMPANY, DOC, HOUR, PN, REQ, SENDER, attachStorage, onePagePdf, requestRow, testLogger, type TestLogger } from './fixtures'

const upload = vi.hoisted(() => ({ uploadDocument: vi.fn() }))
vi.mock('@/lib/core/documents/document-service', () => upload)
vi.mock('@/lib/email/brand-sender', () => ({ getBaseUrlForCompany: vi.fn().mockResolvedValue('https://app.accounted.se') }))
const completedMail = vi.hoisted(() => ({ sendSigningCompletedMail: vi.fn() }))
vi.mock('@/lib/email/send-signing-completed', () => completedMail)
const brand = vi.hoisted(() => ({ signingSenderBrand: vi.fn() }))
vi.mock('../brand', () => brand)

import { ensureSealed, sealSigningRequest, signedCopyRecipients, stampPlacement } from '../seal'

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
  { id: 'signer-1', position: 1, name: 'Anna Andersson', email: 'anna@example.se', role_label: 'VD', signed_at: '2026-10-24T12:00:00.000Z', bankid_given_name: 'Anna', bankid_surname: 'Andersson' },
  { id: 'signer-2', position: 2, name: 'Erik E', email: null, role_label: null, signed_at: '2026-10-24T12:30:00.000Z', bankid_given_name: 'Erik', bankid_surname: 'Eriksson' },
]
const getUserById = vi.fn()
let privates: Array<Record<string, unknown>>

beforeAll(async () => {
  original = await onePagePdf('Hyresavtal mellan parterna')
})

const requests: TableMockResolver = (calls) => (calls.some((c) => c.method === 'update') ? { data: sealedRows } : { data: request })

beforeEach(() => {
  vi.clearAllMocks()
  request = requestRow({ status: 'completed', completed_at: COMPLETED_AT, title: 'Hyresavtal 2026', document_sha256: sha256Hex(original), created_at: '2026-10-23T08:00:00.000Z' })
  sealedRows = [{ id: REQ }]
  // The mask is stored with each signature and printed as stored: signer 1
  // in the display form signatures get now (birth date visible, crm#1969),
  // signer 2 as one recorded before that, which keeps the mask it has.
  privates = [
    { signer_id: 'signer-1', personnummer_masked: '19900101-XXXX', signature_xml: b64(XML_1), ocsp_response: b64(OCSP_1) },
    { signer_id: 'signer-2', personnummer_masked: 'XXXXXXXX-9876', signature_xml: b64(XML_2), ocsp_response: b64(OCSP_2) },
  ]
  db = createTableMockSupabase({
    signing_requests: requests,
    signing_request_signers: { data: signers },
    signing_signer_private: () => ({ data: privates }),
    document_attachments: { data: { file_name: 'hyresavtal.pdf', storage_path: STORAGE_PATH } },
    companies: { data: { name: 'Bolaget AB', team_id: null, org_number: '5566778899' } },
    profiles: { data: { full_name: 'Karin Byråsson' } },
  })
  files = new Map([[STORAGE_PATH, original]])
  attachStorage(db.supabase, files)
  getUserById.mockResolvedValue({ data: { user: { email: 'Karin@Byran.se' } } })
  ;(db.supabase as unknown as { auth: unknown }).auth = { admin: { getUserById } }
  completedMail.sendSigningCompletedMail.mockResolvedValue({ sent: 2 })
  brand.signingSenderBrand.mockResolvedValue({ logoUrl: null, platformName: 'Accounted' })
  log = testLogger()
  upload.uploadDocument.mockImplementation(async (_service: unknown, _user: string, _company: string, file: { name: string }) => ({
    id: file.name.endsWith('.pdf') ? 'signed-doc' : 'evidence-doc',
  }))
})

const uploaded = (index: number) => upload.uploadDocument.mock.calls[index] as [unknown, string, string, { name: string; buffer: ArrayBuffer; type: string }, Record<string, unknown>]

/** The text of each page of a PDF, whitespace collapsed (unpdf, pdf.js: every font and encoding). */
async function pagesText(bytes: Uint8Array): Promise<string[]> {
  const { getDocumentProxy, extractText } = await import('unpdf')
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: false })
  return text.map((page) => page.replace(/\s+/g, ' ').trim())
}

const signedBytes = () => new Uint8Array(uploaded(0)[3].buffer)
const STAMP = 'Signerat med BankID av AA, EE · ID 77777777 · app.accounted.se/verifiera'

// Real PDF renders (react-pdf, the bundled fonts registered on first use): slower than a mock on a loaded runner.
describe('sealSigningRequest', { timeout: 20_000 }, () => {
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

  it('makes the signed PDF the original pages, each stamped, plus a Signeringsbevis naming each signer with the masked personnummer only', async () => {
    await sealSigningRequest(db.supabase as never, REQ, log)
    const signed = await PDFDocument.load(signedBytes())
    const before = await PDFDocument.load(original)
    expect(signed.getPageCount()).toBe(before.getPageCount() + 1)
    expect(signed.getTitle()).toBe('Hyresavtal 2026 (signerad)')
    const [page1, evidence] = await pagesText(signedBytes())
    // The original's own text stays, and its bottom margin carries the stamp.
    expect(page1).toContain('Hyresavtal mellan parterna')
    expect(page1).toContain(STAMP)

    expect(evidence).toContain('Bolaget AB Org.nr 556677-8899 Signeringsbevis ID 77777777')
    expect(evidence).toContain('Hyresavtal 2026 Signerat av alla (2 av 2). Slutfört 24 oktober 2026 kl. 14:30.')
    // Each signer: the name in the signing and the role, the BankID name and masked personnummer, when.
    expect(evidence).toContain('Anna Andersson VD ANNA ANDERSSON 19900101-XXXX 24 okt 2026, 14:00 BankID')
    // A signature recorded before the display form changed prints the mask stored with it.
    expect(evidence).toContain('Erik E Undertecknare ERIK ERIKSSON XXXXXXXX-9876 24 okt 2026, 14:30 BankID')
    expect(evidence).toContain('Fil hyresavtal.pdf, 1 sida')
    expect(evidence).toContain('Skickat för signering 23 oktober 2026 kl. 10:00 av Karin Byråsson')
    expect(evidence).toContain(`Kontrollsumma (SHA-256) ${sha256Hex(original)}`)
    expect(evidence).toContain(`Signerings-ID ${REQ}`)
    expect(evidence).toContain('en avancerad elektronisk underskrift enligt eIDAS')
    expect(evidence).toContain('bevispaketet i Bolaget AB:s arkiv')
    expect(evidence).toContain('Signeringsbevis · ID 77777777 Sida 2 (2) · Signerat via Accounted')
    // The evidence page has its own footer, not the stamp.
    expect(evidence).not.toContain('Signerat med BankID av')
    expect(evidence).not.toContain(PN)
    expect(evidence).not.toContain('198112189876')
    expect(evidence).not.toContain('Årsredovisningens datering')
  })

  it('stamps every original page, whatever its size and rotation, and only those', async () => {
    const multi = await PDFDocument.create()
    const font = await multi.embedFont(StandardFonts.Helvetica)
    for (const [width, height, rotation] of [[595.28, 841.89, 0], [841.89, 595.28, 90], [297.64, 419.53, 180], [612, 792, 270]] as const) {
      const page = multi.addPage([width, height])
      page.setRotation(degrees(rotation))
      page.drawText(`Sida ${width}`, { x: 40, y: height - 60, size: 12, font })
    }
    const four = await multi.save()
    files.set(STORAGE_PATH, four)
    request = requestRow({ ...request!, document_sha256: sha256Hex(four) })
    await sealSigningRequest(db.supabase as never, REQ, log)
    const pages = await pagesText(signedBytes())
    expect(pages).toHaveLength(5)
    for (const page of pages.slice(0, 4)) expect(page).toContain(STAMP)
    expect(pages[4]).toContain('Fil hyresavtal.pdf, 4 sidor')
    expect(pages[4]).toContain('Sida 5 (5)')
    expect(pages[4]).not.toContain('Signerat med BankID av')
  })

  it('draws Swedish and other letters as they are, in the stamp and on the Signeringsbevis', async () => {
    request = requestRow({ ...request!, title: 'Årsstämma i Ödeshög, Åre & Älvdalen' })
    db.setTable('signing_request_signers', {
      data: [
        { ...signers[0], name: 'Åsa Öberg', role_label: 'Ordförande', bankid_given_name: 'Åsa', bankid_surname: 'Öberg' },
        { ...signers[1], name: 'Łukasz Żółć', bankid_given_name: 'Łukasz', bankid_surname: 'Żółć' },
      ],
    })
    db.setTable('companies', { data: { name: 'Ängsbacka Fårö AB', team_id: null, org_number: null } })
    await sealSigningRequest(db.supabase as never, REQ, log)
    const [page1, evidence] = await pagesText(signedBytes())
    expect(page1).toContain('Signerat med BankID av ÅÖ, ŁŻ · ID 77777777')
    expect(evidence).toContain('Ängsbacka Fårö AB Signeringsbevis')
    expect(evidence).toContain('Årsstämma i Ödeshög, Åre & Älvdalen')
    expect(evidence).toContain('Åsa Öberg Ordförande ÅSA ÖBERG')
    expect(evidence).toContain('Łukasz Żółć Undertecknare ŁUKASZ ŻÓŁĆ')
    expect(evidence).not.toContain('Org.nr')
    expect(evidence).not.toContain('?')
  })

  it('carries many signers over as many Signeringsbevis pages as it takes, every one of them named', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...signers[1], id: `signer-${i + 1}`, position: i + 1, name: `Signerare ${i + 1}`, bankid_given_name: 'Erik', bankid_surname: `Nummer${i + 1}` }))
    db.setTable('signing_request_signers', { data: many })
    privates = many.map((s) => ({ signer_id: s.id, personnummer_masked: 'XXXXXXXX-0000', signature_xml: b64(XML_1), ocsp_response: b64(OCSP_1) }))
    await sealSigningRequest(db.supabase as never, REQ, log)
    const pages = await pagesText(signedBytes())
    const evidence = pages.slice(1)
    expect(evidence.length).toBeGreaterThan(1)
    const all = evidence.join(' ')
    for (let i = 1; i <= 20; i++) expect(all).toContain(`Signerare ${i} Undertecknare ERIK NUMMER${i} `)
    expect(all).toContain('Signerat av alla (20 av 20)')
    expect(pages[0]).toContain('Signerat med BankID av EN, EN, EN, EN, EN, EN +14 · ID 77777777')
    evidence.forEach((page, i) => {
      expect(page).toContain('Signeringsbevis ID 77777777')
      expect(page).toContain(`Sida ${i + 2} (${pages.length})`)
    })
    expect(evidence[evidence.length - 1]).toContain('Kontrollera att kopian är äkta')
  })

  it('draws the company logo on the Signeringsbevis, and seals without it when the lookup fails', async () => {
    const { default: sharp } = await import('sharp')
    const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#1c1b19' } }).png().toBuffer()
    brand.signingSenderBrand.mockResolvedValue({ logoUrl: `data:image/png;base64,${png.toString('base64')}`, platformName: 'Byrån Ekonomi' })
    await sealSigningRequest(db.supabase as never, REQ, log)
    const signed = await PDFDocument.load(signedBytes())
    const xobjects = signed.getPages()[1]!.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict)
    const subtypes = xobjects.keys().map((key) => xobjects.lookup(key, PDFStream).dict.get(PDFName.of('Subtype'))?.toString())
    expect(subtypes).toContain('/Image')
    expect((await pagesText(signedBytes()))[1]).toContain('Signerat via Byrån Ekonomi')

    upload.uploadDocument.mockClear()
    brand.signingSenderBrand.mockRejectedValue(new Error('brands down'))
    expect(await sealSigningRequest(db.supabase as never, REQ, log)).toEqual({ signedDocumentId: 'signed-doc', evidenceDocumentId: 'evidence-doc' })
    expect(log.warn).toHaveBeenCalledWith('signing certificate brand unavailable, sealing without it', { companyId: COMPANY, error: 'brands down' })
    const evidence = (await pagesText(signedBytes()))[1]
    expect(evidence).toContain('B Bolaget AB Org.nr 556677-8899')
    expect(evidence).toContain('Signerat via Accounted')
  })

  it('dates an årsredovisning by its first signature on the evidence page', async () => {
    request = requestRow({ ...request!, annual_report_version_id: 'version-1' })
    await sealSigningRequest(db.supabase as never, REQ, log)
    expect((await pagesText(signedBytes()))[1]).toContain('Årsredovisningens datering 2026-10-24 (dagen för den första underskriften)')
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
        personnummer_masked: '19900101-XXXX',
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

  it('answers null and leaves its copies unreferenced when another seal won the race, and mails nothing', async () => {
    sealedRows = []
    expect(await sealSigningRequest(db.supabase as never, REQ, log)).toBeNull()
    expect(upload.uploadDocument).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('sealed by another call'), { signingRequestId: REQ })
    expect(completedMail.sendSigningCompletedMail).not.toHaveBeenCalled()
  })

  it('mails the signed PDF, never the evidence package, to each signer with an address and the sender', async () => {
    await sealSigningRequest(db.supabase as never, REQ, log)
    expect(getUserById).toHaveBeenCalledWith(SENDER)
    expect(completedMail.sendSigningCompletedMail).toHaveBeenCalledTimes(1)
    const sent = completedMail.sendSigningCompletedMail.mock.calls[0]![0] as {
      companyId: string
      title: string
      completedAt: string
      signers: Array<{ name: string; role: string | null; signedAt: string }>
      pageCount: number
      verifyUrl: string
      recipients: string[]
      pdf: { filename: string; bytes: Uint8Array }
    }
    expect(sent).toMatchObject({
      companyId: COMPANY,
      title: 'Hyresavtal 2026',
      completedAt: COMPLETED_AT,
      signers: [
        { name: 'Anna Andersson', role: 'VD', signedAt: '2026-10-24T12:00:00.000Z' },
        { name: 'Erik Eriksson', role: null, signedAt: '2026-10-24T12:30:00.000Z' },
      ],
      pageCount: 1,
      verifyUrl: 'https://app.accounted.se/verifiera',
      recipients: ['anna@example.se', 'Karin@Byran.se'],
    })
    expect(sent.pdf.filename).toBe('hyresavtal-2026-signerad.pdf')
    expect(Buffer.from(sent.pdf.bytes).equals(Buffer.from(uploaded(0)[3].buffer))).toBe(true)
  })

  it('prints where a copy is checked on the evidence page', async () => {
    await sealSigningRequest(db.supabase as never, REQ, log)
    expect((await pagesText(signedBytes()))[1]).toContain('Kontrollera att kopian är äkta Ladda upp filen på app.accounted.se/verifiera.')
  })

  it('keeps the seal when the mail fails, and only logs it', async () => {
    completedMail.sendSigningCompletedMail.mockRejectedValue(new Error('resend down'))
    expect(await sealSigningRequest(db.supabase as never, REQ, log)).toEqual({ signedDocumentId: 'signed-doc', evidenceDocumentId: 'evidence-doc' })
    expect(log.error).toHaveBeenCalledWith('signed copy mail failed', expect.any(Error), { signingRequestId: REQ })
  })
})

describe('signedCopyRecipients', () => {
  it('names each address once, whatever its case, skipping signers without one', () => {
    expect(signedCopyRecipients(['anna@example.se', null, ' ANNA@example.se ', 'erik@example.se'], 'erik@EXAMPLE.se')).toEqual(['anna@example.se', 'erik@example.se'])
    expect(signedCopyRecipients([null], null)).toEqual([])
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

describe('stampPlacement', () => {
  const constants = { minWidth: 400, bottomOffset: 14 }
  const a4 = { x: 0, y: 0, width: 595.28, height: 841.89 }

  it('lays the strip along the bottom edge of the page as displayed, reading upright', () => {
    expect(stampPlacement(a4, 0, constants)).toEqual({ stripWidth: 595.28, scale: 1, rotate: 0, x: 0, y: 14 })
    // Shown turned a quarter clockwise: the right edge is the bottom, the strip runs up it.
    expect(stampPlacement(a4, 90, constants)).toEqual({ stripWidth: 841.89, scale: 1, rotate: 90, x: 595.28 - 14, y: 0 })
    expect(stampPlacement(a4, 180, constants)).toEqual({ stripWidth: 595.28, scale: 1, rotate: 180, x: 595.28, y: 841.89 - 14 })
    expect(stampPlacement(a4, 270, constants)).toEqual({ stripWidth: 841.89, scale: 1, rotate: 270, x: 14, y: 841.89 })
  })

  it('reads any multiple of 90, negative or past a turn, and follows a crop box off the origin', () => {
    expect(stampPlacement(a4, -90, constants).rotate).toBe(270)
    expect(stampPlacement(a4, 450, constants).rotate).toBe(90)
    expect(stampPlacement({ x: 20, y: 30, width: 500, height: 700 }, 0, constants)).toEqual({ stripWidth: 500, scale: 1, rotate: 0, x: 20, y: 44 })
  })

  it('scales the strip down on a page narrower than the smallest strip, lifting it as much less', () => {
    expect(stampPlacement({ x: 0, y: 0, width: 200, height: 300 }, 0, constants)).toEqual({ stripWidth: 400, scale: 0.5, rotate: 0, x: 0, y: 7 })
  })
})
