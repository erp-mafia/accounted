/**
 * The board signs the årsredovisning with BankID (ÅRL 2 kap. 7 §: an
 * electronic årsredovisning is signed with an avancerad elektronisk
 * underskrift). A signing request (lib/signing) over the version's e-signing
 * copy, one signer per bound slot: each BankID signature fills its slot in
 * the same transaction (record_signing_signature), and the last one moves the
 * version to signed by the existing trigger. Bolagsverket never receives the
 * board's signatures: the iXBRL carries names, roles and the per-signer dates
 * read from the slots, and the company keeps the signed original (the
 * evidence package in the archive, BFL 7 kap).
 *
 * Rules:
 *   - One track per version: a version some slot of which carries evidence of
 *     a signature made elsewhere (paper, another e-signature service) is not
 *     sent for BankID signing, and a slot covered by a BankID request takes
 *     no evidence recorded by hand (Bolagsverket has not said a mixed paper
 *     and electronic original is allowed).
 *   - The signer's BankID name must match the slot's name (Bolagsverket kod
 *     1171 checks the names against the register on the signing day):
 *     bankIdNameMatchesSlot in lib/signing/subjects.ts.
 *   - The fastställelseintyg is signed at Bolagsverket after the årsstämma,
 *     never here.
 *   - The revisor's slot is not part of the board's request: the revisor
 *     makes the påteckning (ABL 9 kap. 28 §) once the revisionsberättelse is
 *     given, weeks after the board signed and on what the revisor decided,
 *     so it is recorded on its own (evidence by hand) and never counts
 *     towards the board's track.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { uploadDocument } from '@/lib/core/documents/document-service'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { checkSigners, createSigningRequest, signingStartRefusal, type CreatedSigningRequest } from '@/lib/signing/requests'
import { createServiceClient } from '@/lib/supabase/server'
import { getArsredovisningESigningPdf } from './file-service'
import { isAuditorRole } from './workflow-schemas'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

export interface ArsredovisningSignerInput {
  /** The bound slot (arsredovisning_signature_requests.id) this signer fills. */
  signatureId: string
  email?: string | null
  /** A member of the company: they can sign in the app. */
  userId?: string | null
  /** The app's dialog only: locks the slot to this person's BankID. */
  personalNumber?: string | null
}

export interface RequestArsredovisningSignaturesInput {
  fiscalPeriodId: string
  versionId: string
  signers: ArsredovisningSignerInput[]
  message?: string | null
  expiresInDays?: number | null
  sendEmail?: boolean
  createdVia: 'app' | 'api' | 'mcp'
}

interface SlotRow {
  id: string
  role: string
  signer_name: string
  status: 'pending' | 'signed' | 'declined'
  signing_method: string | null
}

/** Whether a slot is covered by a BankID request that is open or that someone has signed. */
export async function slotCoveredByBankIdSigning(ctx: Pick<OperationContext, 'supabase' | 'companyId'>, signatureId: string): Promise<boolean> {
  const { data, error } = await ctx.supabase
    .from('signing_request_signers')
    .select('signing_request_id, status')
    .eq('company_id', ctx.companyId)
    .eq('annual_report_signature_id', signatureId)
  if (error) throw new Error(`Failed to read BankID signing of the slot: ${error.message}`)
  const rows = (Array.isArray(data) ? data : []) as Array<{ signing_request_id: string; status: string }>
  if (rows.some((r) => r.status === 'signed')) return true
  if (rows.length === 0) return false
  const { data: open, error: openError } = await ctx.supabase
    .from('signing_requests')
    .select('id')
    .eq('company_id', ctx.companyId)
    .in('id', rows.map((r) => r.signing_request_id))
    .eq('status', 'open')
    .limit(1)
  if (openError) throw new Error(`Failed to read BankID signing requests: ${openError.message}`)
  return Array.isArray(open) && open.length > 0
}

/** Open requests on versions a re-lock superseded can no longer be signed: they are cancelled. */
export async function cancelSigningForSupersededVersions(service: SupabaseClient, companyId: string, fiscalPeriodId: string): Promise<void> {
  const { data: superseded, error } = await service
    .from('annual_report_versions')
    .select('id')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('status', 'superseded')
  if (error) throw new Error(`Failed to read superseded versions: ${error.message}`)
  const ids = ((superseded ?? []) as Array<{ id: string }>).map((v) => v.id)
  if (ids.length === 0) return
  const { error: cancelError } = await service
    .from('signing_requests')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('company_id', companyId)
    .in('annual_report_version_id', ids)
    .eq('status', 'open')
  if (cancelError) throw new Error(`Failed to cancel signing of superseded versions: ${cancelError.message}`)
}

async function checkVersion(
  ctx: OperationContext,
  input: RequestArsredovisningSignaturesInput,
): Promise<{ ok: true; slots: SlotRow[]; periodStart: string; periodEnd: string; expiredOpen: string[] } | Failure> {
  const { data: version, error } = await ctx.supabase
    .from('annual_report_versions')
    .select('id, status, fiscal_period_id')
    .eq('company_id', ctx.companyId)
    .eq('fiscal_period_id', input.fiscalPeriodId)
    .eq('id', input.versionId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load annual report version: ${error.message}`)
  if (!version) return { ok: false, code: 'NOT_FOUND' }
  if ((version as { status: string }).status !== 'ready_for_signature') return { ok: false, code: 'ARSREDOVISNING_VERSION_NOT_SIGNABLE' }

  const { data: period, error: periodError } = await ctx.supabase
    .from('fiscal_periods')
    .select('period_start, period_end')
    .eq('company_id', ctx.companyId)
    .eq('id', input.fiscalPeriodId)
    .maybeSingle()
  if (periodError) throw new Error(`Failed to load fiscal period: ${periodError.message}`)
  if (!period) return { ok: false, code: 'PERIOD_NOT_FOUND' }

  const { data: slotData, error: slotError } = await ctx.supabase
    .from('arsredovisning_signature_requests')
    .select('id, role, signer_name, status, signing_method')
    .eq('company_id', ctx.companyId)
    .eq('fiscal_period_id', input.fiscalPeriodId)
    .eq('annual_report_version_id', input.versionId)
    .order('created_at', { ascending: true })
  if (slotError) throw new Error(`Failed to load signature slots: ${slotError.message}`)
  // The board's slots only: the revisor's påteckning is recorded on its own.
  const slots = ((slotData ?? []) as SlotRow[]).filter((slot) => !isAuditorRole(slot.role))
  if (slots.length === 0) return { ok: false, code: 'ARSREDOVISNING_VERSION_NOT_SIGNABLE' }
  // One track per version: evidence recorded by hand on any slot keeps the
  // whole version on that track, and a declined slot cannot be signed.
  if (slots.some((s) => s.status === 'signed' && s.signing_method !== 'bankid')) {
    return { ok: false, code: 'ARSREDOVISNING_SIGNING_TRACK_MIXED' }
  }
  if (slots.some((s) => s.status === 'declined')) return { ok: false, code: 'SIGNATURE_INVALID_TRANSITION', details: { reason: 'declined_slot' } }

  // One open request per version. An open request past its expiry no longer
  // signs anything: it is cancelled when the new one is made.
  const { data: open, error: openError } = await ctx.supabase
    .from('signing_requests')
    .select('id, expires_at')
    .eq('company_id', ctx.companyId)
    .eq('annual_report_version_id', input.versionId)
    .eq('status', 'open')
  if (openError) throw new Error(`Failed to read signing requests: ${openError.message}`)
  const openRows = (Array.isArray(open) ? open : []) as Array<{ id: string; expires_at: string }>
  const live = openRows.find((r) => new Date(r.expires_at).getTime() > Date.now())
  if (live) return { ok: false, code: 'SIGNING_REQUEST_ALREADY_OPEN', details: { signing_request_id: live.id } }

  const p = period as { period_start: string; period_end: string }
  return { ok: true, slots, periodStart: p.period_start, periodEnd: p.period_end, expiredOpen: openRows.map((r) => r.id) }
}

/** The pending slots, in roster order, each with the signer input that covers it. */
function pairSigners(slots: SlotRow[], signers: ArsredovisningSignerInput[]): Array<{ slot: SlotRow; signer: ArsredovisningSignerInput }> | Failure {
  const pending = slots.filter((s) => s.status === 'pending')
  const bySlot = new Map(signers.map((s) => [s.signatureId, s]))
  if (bySlot.size !== signers.length) return { ok: false, code: 'SIGNING_SIGNERS_INVALID', details: { reason: 'duplicate_slot' } }
  if (signers.some((s) => !pending.some((slot) => slot.id === s.signatureId))) {
    return { ok: false, code: 'SIGNING_SIGNERS_INVALID', details: { reason: 'unknown_slot' } }
  }
  if (pending.length === 0) return { ok: false, code: 'ARSREDOVISNING_VERSION_NOT_SIGNABLE' }
  const pairs: Array<{ slot: SlotRow; signer: ArsredovisningSignerInput }> = []
  for (const slot of pending) {
    // Every pending slot is covered: a slot left out would keep the version
    // from ever being signed. A signer given no address is still a signer
    // (the link is answered for the sender to hand over).
    pairs.push({ slot, signer: bySlot.get(slot.id) ?? { signatureId: slot.id } })
  }
  return pairs
}

function requestInput(
  input: RequestArsredovisningSignaturesInput,
  documentId: string,
  pairs: Array<{ slot: SlotRow; signer: ArsredovisningSignerInput }>,
  period: { periodStart: string; periodEnd: string },
) {
  return {
    documentId,
    title: `Årsredovisning för räkenskapsåret ${period.periodStart} till ${period.periodEnd}`,
    message: input.message ?? null,
    expiresInDays: input.expiresInDays ?? null,
    sendEmail: input.sendEmail,
    createdVia: input.createdVia,
    annualReportVersionId: input.versionId,
    signers: pairs.map(({ slot, signer }) => ({
      name: slot.signer_name,
      roleLabel: slot.role,
      email: signer.email ?? null,
      userId: signer.userId ?? null,
      personalNumber: signer.personalNumber ?? null,
      annualReportSignatureId: slot.id,
    })),
  }
}

/**
 * Send a locked årsredovisning version to its board for BankID signing: the
 * e-signing copy is rendered once and archived, and a signing request covers
 * every pending slot. A dry run renders and stores nothing.
 */
export async function requestArsredovisningSignatures(
  ctx: OperationContext,
  input: RequestArsredovisningSignaturesInput,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<CreatedSigningRequest>> {
  const refusal = await signingStartRefusal(ctx.supabase, ctx.companyId, { arsredovisning: true })
  if (refusal) return { ok: false, code: refusal }
  const checked = await checkVersion(ctx, input)
  if (!checked.ok) return checked
  const pairs = pairSigners(checked.slots, input.signers)
  if (!Array.isArray(pairs)) return pairs

  if (dryRun) {
    // The e-signing copy does not exist before the real call: the preview
    // checks the signers on the caller's client and answers the slots they fill.
    const signers = await checkSigners(ctx.supabase, ctx.companyId, requestInput(input, '', pairs, checked).signers, { samePersonMaySignTwice: true })
    if (!signers.ok) return signers
    return {
      ok: true,
      dryRun: true,
      preview: {
        fiscal_period_id: input.fiscalPeriodId,
        annual_report_version_id: input.versionId,
        title: requestInput(input, '', pairs, checked).title,
        signers: pairs.map(({ slot, signer }) => ({
          signature_id: slot.id,
          name: slot.signer_name,
          role: slot.role,
          email: signer.email ?? null,
          email_will_be_sent: (input.sendEmail ?? true) && Boolean(signer.email),
        })),
        urls: null,
      },
    }
  }

  if (checked.expiredOpen.length > 0) {
    const { error: cancelError } = await createServiceClient()
      .from('signing_requests')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('company_id', ctx.companyId)
      .in('id', checked.expiredOpen)
      .eq('status', 'open')
    if (cancelError) throw new Error(`Failed to cancel an expired signing request: ${cancelError.message}`)
  }

  const pdf = await getArsredovisningESigningPdf(ctx, { fiscal_period_id: input.fiscalPeriodId, version_id: input.versionId })
  if (!pdf.ok) return pdf
  if (pdf.dryRun) return { ok: false, code: 'INTERNAL_ERROR' }
  const bytes = pdf.data.bytes
  const archived = await uploadDocument(
    createServiceClient(),
    ctx.userId,
    ctx.companyId,
    { name: pdf.data.filename, buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, type: 'application/pdf' },
    { upload_source: 'system', extractionOwner: 'none' },
  )
  return createSigningRequest(ctx, requestInput(input, archived.id, pairs, checked))
}
