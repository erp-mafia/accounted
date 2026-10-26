/**
 * Sealing a completed signing request: two documents into the archive.
 *
 *   - The signed PDF: the original pages plus a "Signeringsbevis" page (who
 *     signed, as what, when, with BankID, the masked personnummer and the
 *     document's SHA-256). Shareable: it carries no full personnummer.
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
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { uploadDocument } from '@/lib/core/documents/document-service'
import type { Logger } from '@/lib/logger'
import { downloadDocumentBytes, sha256Hex } from './document'
import { formatSigningMoment, stockholmDay } from './format'
import { describeRequester } from './requests'
import { type SigningRequestRow } from './types'

/** A completed request whose seal has not landed for this long is sealed again on read. */
const SEAL_RETRY_AFTER_MS = 2 * 60 * 1000

interface SealSigner {
  id: string
  position: number
  name: string
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

/** pdf-lib's standard fonts encode WinAnsi: anything outside it prints as "?". */
function winAnsi(value: string): string {
  return value.normalize('NFC').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
}

function slug(value: string): string {
  return value.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 60) || 'dokument'
}

export interface SealedCopies {
  signedDocumentId: string
  evidenceDocumentId: string
}

interface EvidenceLine {
  text: string
  bold?: boolean
  size?: number
  gapAfter?: number
}

async function buildSignedPdf(original: Uint8Array, lines: EvidenceLine[], title: string): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
  const pdf = await PDFDocument.load(original, { updateMetadata: false })
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const [width, height] = [595.28, 841.89]
  const margin = 56
  const maxWidth = width - margin * 2
  let page = pdf.addPage([width, height])
  let y = height - margin

  const wrap = (text: string, font: typeof regular, size: number): string[] => {
    const words = winAnsi(text).split(' ')
    const out: string[] = []
    let current = ''
    for (const word of words) {
      const next = current ? `${current} ${word}` : word
      if (font.widthOfTextAtSize(next, size) <= maxWidth) {
        current = next
        continue
      }
      if (current) out.push(current)
      // A single token wider than the line (a hash): break it by characters.
      let rest = word
      while (font.widthOfTextAtSize(rest, size) > maxWidth) {
        let cut = rest.length - 1
        while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) cut--
        out.push(rest.slice(0, cut))
        rest = rest.slice(cut)
      }
      current = rest
    }
    if (current) out.push(current)
    return out.length > 0 ? out : ['']
  }

  for (const line of lines) {
    const size = line.size ?? 10
    const font = line.bold ? bold : regular
    for (const part of wrap(line.text, font, size)) {
      if (y - size < margin) {
        page = pdf.addPage([width, height])
        y = height - margin
      }
      page.drawText(part, { x: margin, y: y - size, size, font, color: rgb(0.13, 0.13, 0.13) })
      y -= size * 1.45
    }
    y -= line.gapAfter ?? 0
  }

  pdf.setTitle(winAnsi(`${title} (signerad)`))
  pdf.setProducer('Accounted')
  pdf.setModificationDate(new Date())
  return pdf.save()
}

function evidenceLines(input: {
  request: SigningRequestRow
  companyName: string
  requester: string
  fileName: string
  signers: SealSigner[]
  privates: Map<string, SealPrivate>
}): EvidenceLine[] {
  const { request, signers, privates } = input
  const lines: EvidenceLine[] = [
    { text: 'Signeringsbevis', bold: true, size: 18, gapAfter: 6 },
    { text: request.title, bold: true, size: 12, gapAfter: 10 },
    { text: `Företag: ${input.companyName}` },
    { text: `Dokument: ${input.fileName}` },
    { text: `Kontrollsumma (SHA-256): ${request.document_sha256}` },
    { text: `Signerings-id: ${request.id}` },
    { text: `Skickad för signering av ${input.requester}, ${formatSigningMoment(request.created_at)}` },
    { text: `Signeringen slutfördes ${formatSigningMoment(request.completed_at ?? new Date().toISOString())}`, gapAfter: 14 },
    { text: 'Underskrifter', bold: true, size: 12, gapAfter: 4 },
  ]
  for (const s of signers) {
    const bankidName = `${s.bankid_given_name} ${s.bankid_surname}`.trim()
    const masked = privates.get(s.id)?.personnummer_masked
    lines.push({ text: `${s.position}. ${bankidName}${s.role_label ? `, ${s.role_label}` : ''}`, bold: true })
    lines.push({ text: `Signerade med BankID ${formatSigningMoment(s.signed_at)}${masked ? `, personnummer ${masked}` : ''}` })
    if (bankidName.toLowerCase() !== s.name.trim().toLowerCase()) lines.push({ text: `Namn i signeringen: ${s.name}` })
    lines[lines.length - 1]!.gapAfter = 6
  }
  if (request.annual_report_version_id && signers.length > 0) {
    const first = signers.map((s) => s.signed_at).sort()[0]!
    lines.push({ text: `Årsredovisningens datering: ${stockholmDay(first)} (dagen för den första underskriften)`, gapAfter: 6 })
  }
  lines.push({
    text:
      'Varje underskrift är en BankID-signatur, en avancerad elektronisk underskrift enligt eIDAS, som innehåller dokumentets kontrollsumma ovan. ' +
      'Signaturerna, bevisen på att certifikaten var giltiga när de användes och originalfilen finns i bevispaketet (Bevispaket.zip) i företagets arkiv.',
    size: 9,
  })
  return lines
}

async function loadSealInput(service: SupabaseClient, requestId: string) {
  const { data, error } = await service.from('signing_requests').select('id, company_id, created_by, created_via, document_id, document_sha256, title, message, annual_report_version_id, status, expires_at, completed_at, declined_at, cancelled_at, signed_document_id, evidence_document_id, created_at').eq('id', requestId).maybeSingle()
  if (error) throw error
  const request = data as SigningRequestRow | null
  if (!request || request.status !== 'completed') return null
  const [{ data: signerData, error: signerError }, { data: doc, error: docError }] = await Promise.all([
    service
      .from('signing_request_signers')
      .select('id, position, name, role_label, signed_at, bankid_given_name, bankid_surname')
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
  const signed = await buildSignedPdf(
    original,
    evidenceLines({ request, companyName: sender.companyName, requester: sender.requester, fileName: document.file_name, signers, privates }),
    request.title,
  )

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
  return { signedDocumentId: signedDoc.id, evidenceDocumentId: evidenceDoc.id }
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
