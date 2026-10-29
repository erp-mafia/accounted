/**
 * The minutes as a PDF, archived and signed two ways: with BankID where
 * signing is open for the company (SIGNING_ENABLED and the plan; the
 * archived PDF goes through lib/signing like any document and the meeting
 * follows the request, ./signing-sync.ts), or by hand: printed, signed on
 * paper and the signed copy uploaded. Either way the elections take effect
 * in the roles first (./effects.ts) and the minutes are frozen from then on.
 *
 * A stämma's PDF carries the aktiebok as of the meeting day as bilaga 2
 * (ABL 7:28). The archived copy (the one signed) always masks the
 * personnummer: the archive is readable by every member and the signers may
 * not be members. A download for an owner or admin prints them in full, as
 * the aktiebok printout does (W1's rule).
 */
import { PDFDocument } from 'pdf-lib'
import { uploadDocument, validateDocumentFile } from '@/lib/core/documents/document-service'
import { stockholmWallTimeToUtc, todayIsoStockholm } from '@/lib/dates/iso'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import { createSigningRequest, signingStartRefusal, type CreatedSigningRequest } from '@/lib/signing/requests'
import { createServiceClient } from '@/lib/supabase/server'
import { loadFullPersonnummer, loadRegisterParties } from '../people'
import { buildAktiebokPdfData } from '../pdf-data'
import { loadRoles } from '../roles'
import { companyForPdf } from '../session'
import { loadShareRegisterData } from '../share-register'
import { applyRegisterEffects } from './effects'
import { MeetingError, meetingFailure } from './errors'
import { buildMinutesPdfData, minutesFilename } from './minutes-pdf-data'
import { isStamma } from './rules'
import { afterMeetingChange, loadDecisionRecords, loadMeetingRecord } from './store'
import { buildMeetingView, type MeetingDetail } from './view'

/** The minutes PDF, with the aktiebok appended for a stämma. */
export async function renderMeetingPdf(ctx: OperationContext, view: MeetingDetail, options: { fullPersonnummer: boolean }): Promise<Buffer> {
  const company = await companyForPdf(ctx.supabase, ctx.companyId)
  const generatedAt = todayIsoStockholm()
  // Loaded on use: react-pdf stays out of every module that reaches the
  // meeting services (the operation registry among them) until a PDF is made.
  const { renderMinutesPdf } = await import('./minutes-pdf')
  const minutes = await renderMinutesPdf(buildMinutesPdfData(view, company, generatedAt))
  if (!isStamma(view.kind)) return minutes

  const [register, roles] = await Promise.all([loadShareRegisterData(ctx, view.meeting_date), loadRoles(ctx, view.meeting_date)])
  const full = options.fullPersonnummer ? await loadFullPersonnummer(ctx.companyId, [...register.parties.keys()]) : undefined
  const { renderAktiebokPdf } = await import('../pdf')
  const aktiebok = await renderAktiebokPdf(buildAktiebokPdfData(register, roles, company, { fullPersonnummer: full, generatedAt }))

  const merged = await PDFDocument.create()
  for (const bytes of [minutes, aktiebok]) {
    const source = await PDFDocument.load(bytes)
    const pages = await merged.copyPages(source, source.getPageIndices())
    for (const page of pages) merged.addPage(page)
  }
  merged.setTitle(`${view.title} ${company.name}`)
  return Buffer.from(await merged.save())
}

/**
 * Send the minutes for BankID signing: the PDF is archived, every signer
 * (rules.ts minutesSigners) gets a link by mail where the register has
 * their address, else the answer carries their link. The minutes are frozen
 * while the request runs and signed when it completes.
 */
export async function requestMeetingSignatures(ctx: OperationContext, id: string): Promise<OperationOutcome<CreatedSigningRequest>> {
  try {
    const refusal = await signingStartRefusal(ctx.supabase, ctx.companyId)
    if (refusal) return { ok: false, code: refusal }
    const record = await loadMeetingRecord(ctx.supabase, ctx.companyId, id)
    if (!record) throw new MeetingError('CORPORATE_MEETING_NOT_FOUND')
    if (record.status === 'draft') throw new MeetingError('CORPORATE_MEETING_NOT_HELD')
    if (record.status === 'signed') throw new MeetingError('CORPORATE_MEETING_LOCKED')
    if (record.signing_request_id) throw new MeetingError('CORPORATE_MEETING_SIGNING_PENDING')
    const view = await buildMeetingView(ctx, record)
    if (view.signers.length === 0) throw new MeetingError('CORPORATE_MEETING_SIGNERS_MISSING')

    const pdf = await renderMeetingPdf(ctx, view, { fullPersonnummer: false })
    const archived = await uploadDocument(
      createServiceClient(),
      ctx.userId,
      ctx.companyId,
      { name: minutesFilename(view), buffer: new Uint8Array(pdf).buffer as ArrayBuffer, type: 'application/pdf' },
      { upload_source: 'system', extractionOwner: 'none' },
    )
    const parties = await loadRegisterParties(ctx.companyId, view.signers.map((s) => s.party_id))
    const outcome = await createSigningRequest(ctx, {
      documentId: archived.id,
      title: `${view.title}, ${view.meeting_date}`,
      message: null,
      sendEmail: true,
      createdVia: 'app',
      signers: view.signers.map((s) => ({ name: s.name, email: parties.get(s.party_id)?.email ?? null, roleLabel: s.role_label })),
    })
    if (!outcome.ok || outcome.dryRun) return outcome

    const { error } = await ctx.supabase
      .from('corporate_meetings')
      .update({ signing_request_id: outcome.data.signing_request_id, minutes_document_id: archived.id })
      .eq('company_id', ctx.companyId)
      .eq('id', record.id)
      .eq('status', 'held')
      .is('signing_request_id', null)
    if (error) throw error
    return outcome
  } catch (error) {
    return meetingFailure(error)
  }
}

export interface ManualSignInput {
  signedOn: string
  /** Who signed, as the paper copy shows. */
  signatureNames: string
  /** The signed minutes, scanned. */
  file?: { name: string; buffer: ArrayBuffer; type: string } | null
}

export interface SignedMeeting {
  corporate_meeting_id: string
  status: 'signed'
  signed_document_id: string | null
  roles_added: string[]
  roles_ended: string[]
}

/**
 * Signed by hand: the elections take effect in the roles, the scan (when
 * there is one) is archived as the signed copy, and the minutes are frozen.
 */
export async function signMeetingManually(ctx: OperationContext, id: string, input: ManualSignInput): Promise<OperationOutcome<SignedMeeting>> {
  try {
    const record = await loadMeetingRecord(ctx.supabase, ctx.companyId, id)
    if (!record) throw new MeetingError('CORPORATE_MEETING_NOT_FOUND')
    if (record.status === 'draft') throw new MeetingError('CORPORATE_MEETING_NOT_HELD')
    if (record.status === 'signed') throw new MeetingError('CORPORATE_MEETING_LOCKED')
    if (record.signing_request_id) throw new MeetingError('CORPORATE_MEETING_SIGNING_PENDING')
    if (input.signedOn < record.meeting_date || input.signedOn > todayIsoStockholm()) {
      return { ok: false, code: 'BOLAGET_DATES_INVALID', messageSv: 'Underskriftsdagen kan inte vara före mötet eller framåt i tiden.' }
    }
    if (input.file) {
      const invalid = validateDocumentFile({ size: input.file.buffer.byteLength, type: input.file.type })
      if (invalid) throw new MeetingError('CORPORATE_MEETING_FILE_INVALID', undefined, { reason: invalid })
    }

    const decisions = await loadDecisionRecords(ctx.supabase, ctx.companyId, record.id)
    const applied = await applyRegisterEffects(ctx, record, decisions)
    if (!applied.ok) return applied

    let signedDocumentId: string | null = null
    if (input.file) {
      const document = await uploadDocument(ctx.supabase, ctx.userId, ctx.companyId, input.file, { upload_source: 'file_upload', extractionOwner: 'none' })
      signedDocumentId = document.id
    }
    const signedAt = input.signedOn === todayIsoStockholm() ? new Date().toISOString() : stockholmWallTimeToUtc(input.signedOn, '12:00').toISOString()
    const { data, error } = await ctx.supabase
      .from('corporate_meetings')
      .update({ status: 'signed', signed_at: signedAt, signature_names: input.signatureNames.trim().slice(0, 1000), signed_document_id: signedDocumentId })
      .eq('company_id', ctx.companyId)
      .eq('id', record.id)
      .eq('status', 'held')
      .is('signing_request_id', null)
      .select('id')
      .maybeSingle()
    if (error) throw error
    if (!data) throw new MeetingError('CORPORATE_MEETING_LOCKED')
    const warnings: OperationWarning[] = [...applied.warnings, ...(await afterMeetingChange(ctx, record.id))]
    return {
      ok: true,
      data: { corporate_meeting_id: record.id, status: 'signed', signed_document_id: signedDocumentId, roles_added: applied.added, roles_ended: applied.ended },
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  } catch (error) {
    return meetingFailure(error)
  }
}
