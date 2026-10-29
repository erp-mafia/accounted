/**
 * Sealing a completed signing request: two documents into the archive.
 *
 *   - The signed PDF: the original pages, each with a stamp in its bottom
 *     margin ("Signerat med BankID av JW, EM · ID 1569BCE7 · <verify URL>"),
 *     plus the Signeringsbevis page(s): who signed, as what, when, with
 *     BankID, the masked personnummer and the document's SHA-256
 *     (./certificate-pdf.tsx). Shareable: it carries no full personnummer.
 *   - Bevispaket.zip: the original PDF, each signer's BankID signature
 *     (XML-DSig, which carries the full personnummer) and OCSP response, and
 *     a manifest. With it anyone can extract the original, hash it and match
 *     the hash inside each signature without us; it is the signed original
 *     the company keeps (BFL 7 kap: in the format and content it had).
 *
 * Both are written by the service role in the requester's name, once: the
 * request takes its sealed copies only while they are NULL (the guard of
 * migration 20261025200000). The original is re-hashed against
 * document_sha256 first, so a changed file is never sealed. A failed seal is
 * retried on a later read (ensureSealed).
 *
 * The seal that wins mails the signed PDF to every signer with an address
 * and to the sender (never the evidence package: it carries every signer's
 * full personnummer). The signed copy's own SHA-256 is what /verifiera
 * looks up (./verify.ts), and its evidence page says so.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getBranding } from '@/lib/branding/service'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { getBaseUrlForCompany } from '@/lib/email/brand-sender'
import { sendSigningCompletedMail } from '@/lib/email/send-signing-completed'
import type { Logger } from '@/lib/logger'
import { signingSenderBrand } from './brand'
import type { SigningCertificateData } from './certificate-pdf'
import { downloadDocumentBytes, sha256Hex } from './document'
import { stockholmDay } from './format'
import { resolveSigningLogo } from './logo'
import { describeRequester } from './requests'
import { type SigningRequestRow } from './types'

/** A completed request whose seal has not landed for this long is sealed again on read. */
const SEAL_RETRY_AFTER_MS = 2 * 60 * 1000

interface SealSigner {
  id: string
  position: number
  name: string
  email: string | null
  role_label: string | null
  signed_at: string
  bankid_given_name: string
  bankid_surname: string
}

interface SealPrivate {
  signer_id: string
  personnummer_masked: string | null
  signature_xml: string
  ocsp_response: string
}

function slug(value: string): string {
  return value.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 60) || 'dokument'
}

export interface SealedCopies {
  signedDocumentId: string
  evidenceDocumentId: string
}

/** Where the stamp goes on a page, given its visible box and rotation. */
export interface StampPlacement {
  /** Width of the strip to draw, in the strip's own points. */
  stripWidth: number
  /** The strip is drawn at this scale (below 1 only on pages narrower than STAMP_MIN_WIDTH). */
  scale: number
  x: number
  y: number
  /** Counter-clockwise degrees, so the strip reads upright on the page as displayed. */
  rotate: 0 | 90 | 180 | 270
}

/**
 * The stamp sits centred in the bottom margin of the page as a reader sees
 * it: along the crop box's bottom edge for an upright page, along its right
 * edge for a page shown turned 90 degrees, and so on. The strip's own
 * bottom-left corner lands on the displayed page's bottom-left corner,
 * lifted STAMP_BOTTOM_OFFSET off the edge.
 */
export function stampPlacement(
  box: { x: number; y: number; width: number; height: number },
  rotation: number,
  constants: { minWidth: number; bottomOffset: number },
): StampPlacement {
  const turn = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360
  const visibleWidth = turn === 90 || turn === 270 ? box.height : box.width
  const scale = Math.min(1, visibleWidth / constants.minWidth)
  const stripWidth = scale < 1 ? constants.minWidth : visibleWidth
  const lift = constants.bottomOffset * scale
  const [x0, y0, x1, y1] = [box.x, box.y, box.x + box.width, box.y + box.height]
  if (turn === 90) return { stripWidth, scale, rotate: 90, x: x1 - lift, y: y0 }
  if (turn === 180) return { stripWidth, scale, rotate: 180, x: x1, y: y1 - lift }
  if (turn === 270) return { stripWidth, scale, rotate: 270, x: x0 + lift, y: y1 }
  return { stripWidth, scale, rotate: 0, x: x0, y: y0 + lift }
}

type CertificateInput = Omit<SigningCertificateData, 'originalPageCount' | 'fonts'>

/**
 * The original's pages, each stamped in its bottom margin, then the
 * Signeringsbevis pages. The stamp is drawn after the page's own content,
 * which pdf-lib wraps in q/Q first, so a page that leaves its graphics
 * state changed cannot move or scale it. Nothing of the original is
 * covered: the stamp has no background.
 */
async function buildSignedPdf(
  original: Uint8Array,
  input: { certificate: CertificateInput; title: string },
): Promise<{ bytes: Uint8Array; originalPageCount: number }> {
  const [{ PDFDocument, degrees }, certificateModule] = await Promise.all([import('pdf-lib'), import('./certificate-pdf')])
  const { STAMP_BOTTOM_OFFSET, STAMP_MIN_WIDTH, prepareSigningFonts, renderSigningCertificate, renderStampStrips, signersInitials, stampLine } = certificateModule
  const pdf = await PDFDocument.load(original, { updateMetadata: false })
  const pages = pdf.getPages()
  const fonts = await prepareSigningFonts()

  const placements = pages.map((page) => stampPlacement(page.getCropBox(), page.getRotation().angle, { minWidth: STAMP_MIN_WIDTH, bottomOffset: STAMP_BOTTOM_OFFSET }))
  const widths = [...new Set(placements.map((p) => p.stripWidth))]
  const strips = await pdf.embedPdf(
    await renderStampStrips({
      text: stampLine({
        initials: signersInitials(input.certificate.signers.map((s) => ({ givenName: s.bankidGivenName, surname: s.bankidSurname }))),
        requestId: input.certificate.requestId,
        verifyUrl: input.certificate.verifyUrl,
      }),
      widths,
      fonts,
    }),
    widths.map((_, i) => i),
  )
  pages.forEach((page, i) => {
    const p = placements[i]!
    page.drawPage(strips[widths.indexOf(p.stripWidth)]!, { x: p.x, y: p.y, xScale: p.scale, yScale: p.scale, rotate: degrees(p.rotate) })
  })

  const certificate = await PDFDocument.load(await renderSigningCertificate({ ...input.certificate, originalPageCount: pages.length, fonts }))
  for (const page of await pdf.copyPages(certificate, certificate.getPageIndices())) pdf.addPage(page)

  pdf.setTitle(`${input.title} (signerad)`)
  pdf.setProducer('Accounted')
  pdf.setModificationDate(new Date())
  return { bytes: await pdf.save(), originalPageCount: pages.length }
}

/** The company's logo and platform for the evidence page; a lookup that fails draws initials, never blocks the seal. */
async function certificateBrand(service: SupabaseClient, companyId: string, log: Logger) {
  const warn = (what: string) => (err: unknown) => {
    log.warn(`signing certificate ${what} unavailable, sealing without it`, { companyId, error: err instanceof Error ? err.message : String(err) })
    return null
  }
  const brand = (await signingSenderBrand(service, companyId).catch(warn('brand'))) ?? { logoUrl: null, platformName: getBranding().appName }
  const logo = await resolveSigningLogo(brand.logoUrl).catch(warn('logo'))
  return { logo, platformName: brand.platformName }
}

async function companyOrgNumber(service: SupabaseClient, companyId: string): Promise<string | null> {
  const { data } = await service.from('companies').select('org_number').eq('id', companyId).maybeSingle()
  return (data as { org_number?: string | null } | null)?.org_number?.trim() || null
}

async function loadSealInput(service: SupabaseClient, requestId: string) {
  const { data, error } = await service.from('signing_requests').select('id, company_id, created_by, created_via, document_id, document_sha256, title, message, annual_report_version_id, status, expires_at, completed_at, declined_at, cancelled_at, signed_document_id, evidence_document_id, created_at').eq('id', requestId).maybeSingle()
  if (error) throw error
  const request = data as SigningRequestRow | null
  if (!request || request.status !== 'completed') return null
  const [{ data: signerData, error: signerError }, { data: doc, error: docError }] = await Promise.all([
    service
      .from('signing_request_signers')
      .select('id, position, name, email, role_label, signed_at, bankid_given_name, bankid_surname')
      .eq('signing_request_id', request.id)
      .eq('status', 'signed')
      .order('position'),
    service.from('document_attachments').select('file_name, storage_path').eq('id', request.document_id).maybeSingle(),
  ])
  if (signerError) throw signerError
  if (docError) throw docError
  const signers = (signerData ?? []) as SealSigner[]
  const { data: privateData, error: privateError } = await service
    .from('signing_signer_private')
    .select('signer_id, personnummer_masked, signature_xml, ocsp_response')
    .in('signer_id', signers.map((s) => s.id))
  if (privateError) throw privateError
  const privates = new Map(((privateData ?? []) as SealPrivate[]).map((p) => [p.signer_id, p]))
  const document = doc as { file_name: string; storage_path: string } | null
  return { request, signers, privates, document }
}

/**
 * Seal a completed request. Answers null when there is nothing to seal (not
 * completed, already sealed, or another seal won the race).
 */
export async function sealSigningRequest(service: SupabaseClient, requestId: string, log: Logger): Promise<SealedCopies | null> {
  const input = await loadSealInput(service, requestId)
  if (!input || !input.document) return null
  const { request, signers, privates, document } = input
  if (request.signed_document_id && request.evidence_document_id) return null
  if (signers.some((s) => !privates.get(s.id)?.signature_xml)) throw new Error('A signed signer has no stored signature')

  const original = await downloadDocumentBytes(service, document.storage_path)
  if (!original) throw new Error('Original document not in storage')
  if (sha256Hex(original) !== request.document_sha256) throw new Error('Original document no longer matches the signed hash')

  const sender = await describeRequester(service, request.company_id, request.created_by)
  const [baseUrl, brand, orgNumber] = await Promise.all([
    getBaseUrlForCompany(request.company_id),
    certificateBrand(service, request.company_id, log),
    companyOrgNumber(service, request.company_id),
  ])
  const verifyUrl = `${baseUrl}/verifiera`
  const { bytes: signed, originalPageCount } = await buildSignedPdf(original, {
    title: request.title,
    certificate: {
      requestId: request.id,
      title: request.title,
      companyName: sender.companyName,
      orgNumber,
      logo: brand.logo,
      requester: sender.requester,
      createdAt: request.created_at,
      completedAt: request.completed_at ?? new Date().toISOString(),
      fileName: document.file_name,
      sha256: request.document_sha256,
      signers: signers.map((s) => ({
        name: s.name,
        role: s.role_label,
        bankidGivenName: s.bankid_given_name,
        bankidSurname: s.bankid_surname,
        personnummerMasked: privates.get(s.id)?.personnummer_masked ?? null,
        signedAt: s.signed_at,
      })),
      annualReportDate: request.annual_report_version_id && signers.length > 0 ? stockholmDay(signers.map((s) => s.signed_at).sort()[0]!) : null,
      verifyUrl,
      platformName: brand.platformName,
    },
  })

  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  zip.file('original.pdf', original)
  const manifestSigners = signers.map((s) => {
    const p = privates.get(s.id)!
    const xml = Buffer.from(p.signature_xml, 'base64')
    zip.file(`signatur-${s.position}.xml`, xml)
    zip.file(`ocsp-${s.position}.der`, Buffer.from(p.ocsp_response, 'base64'))
    return {
      position: s.position,
      name: s.name,
      role: s.role_label,
      bankid_name: `${s.bankid_given_name} ${s.bankid_surname}`.trim(),
      personnummer_masked: p.personnummer_masked,
      signed_at: s.signed_at,
      signature_file: `signatur-${s.position}.xml`,
      signature_sha256: sha256Hex(xml),
      ocsp_file: `ocsp-${s.position}.der`,
    }
  })
  zip.file(
    'manifest.json',
    JSON.stringify(
      {
        format: 'accounted.signing.evidence/1',
        signing_request_id: request.id,
        title: request.title,
        company_id: request.company_id,
        document: { file_name: document.file_name, sha256: request.document_sha256, file: 'original.pdf' },
        annual_report_version_id: request.annual_report_version_id,
        created_at: request.created_at,
        completed_at: request.completed_at,
        method: 'BankID (TIC Identity), XML-DSig with OCSP; userNonVisibleData carries {request, signer, sha256}',
        signers: manifestSigners,
      },
      null,
      2,
    ),
  )
  const evidence = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })

  const base = slug(request.title)
  const toBuffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const signedDoc = await uploadDocument(
    service,
    request.created_by,
    request.company_id,
    { name: `${base}-signerad.pdf`, buffer: toBuffer(signed), type: 'application/pdf' },
    { upload_source: 'system', extractionOwner: 'none' },
  )
  const evidenceDoc = await uploadDocument(
    service,
    request.created_by,
    request.company_id,
    { name: `${base}-bevispaket.zip`, buffer: toBuffer(evidence), type: 'application/zip' },
    { upload_source: 'system', extractionOwner: 'none' },
  )

  const { data: updated, error } = await service
    .from('signing_requests')
    .update({ signed_document_id: signedDoc.id, evidence_document_id: evidenceDoc.id })
    .eq('id', request.id)
    .eq('status', 'completed')
    .is('signed_document_id', null)
    .is('evidence_document_id', null)
    .select('id')
  if (error) throw error
  if ((updated ?? []).length !== 1) {
    log.warn('signing request was sealed by another call; this seal\'s copies stay unreferenced in the archive', { signingRequestId: request.id })
    return null
  }
  log.info('signing request sealed', { signingRequestId: request.id, signedDocumentId: signedDoc.id, evidenceDocumentId: evidenceDoc.id })
  await mailSignedCopy(service, { request, companyName: sender.companyName, signers, pageCount: originalPageCount, verifyUrl, pdf: { filename: `${base}-signerad.pdf`, bytes: signed }, log }).catch((err) =>
    log.error('signed copy mail failed', err instanceof Error ? err : new Error(String(err)), { signingRequestId: request.id }),
  )
  return { signedDocumentId: signedDoc.id, evidenceDocumentId: evidenceDoc.id }
}

/** The signers' addresses and the sender's, each once, case-insensitively. */
export function signedCopyRecipients(signerEmails: Array<string | null>, senderEmail: string | null): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of [...signerEmails, senderEmail]) {
    const email = raw?.trim()
    if (!email || seen.has(email.toLowerCase())) continue
    seen.add(email.toLowerCase())
    out.push(email)
  }
  return out
}

async function mailSignedCopy(
  service: SupabaseClient,
  input: { request: SigningRequestRow; companyName: string; signers: SealSigner[]; pageCount: number; verifyUrl: string; pdf: { filename: string; bytes: Uint8Array }; log: Logger },
): Promise<void> {
  const { request, signers } = input
  const { data } = await service.auth.admin.getUserById(request.created_by)
  const recipients = signedCopyRecipients(signers.map((s) => s.email), data?.user?.email ?? null)
  await sendSigningCompletedMail({
    companyId: request.company_id,
    companyName: input.companyName,
    title: request.title,
    completedAt: request.completed_at ?? new Date().toISOString(),
    signers: signers.map((s) => ({ name: `${s.bankid_given_name} ${s.bankid_surname}`.trim(), role: s.role_label, signedAt: s.signed_at })),
    pageCount: input.pageCount,
    verifyUrl: input.verifyUrl,
    recipients,
    pdf: input.pdf,
    log: input.log,
  })
}

/** Seal again a completed request whose seal never landed (a failed upload, a timed-out function). */
export async function ensureSealed(
  service: SupabaseClient,
  request: Pick<SigningRequestRow, 'id' | 'status' | 'completed_at' | 'signed_document_id' | 'evidence_document_id'>,
  log: Logger,
  now: number = Date.now(),
): Promise<void> {
  if (request.status !== 'completed' || (request.signed_document_id && request.evidence_document_id)) return
  if (!request.completed_at || now - new Date(request.completed_at).getTime() < SEAL_RETRY_AFTER_MS) return
  await sealSigningRequest(service, request.id, log).catch((err) =>
    log.error('signing request seal retry failed', err instanceof Error ? err : new Error(String(err)), { signingRequestId: request.id }),
  )
}
