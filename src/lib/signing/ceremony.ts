/**
 * The signer's side of a signing request: the page's description, the BankID
 * start, the poll that records the signature, a decline, and stopping a
 * signing in progress. One implementation behind both doors: the public
 * token routes under /api/signera/[token] (anyone holding the link) and the
 * member routes under /api/signing/me/[signerId] (a logged-in member who is
 * the signer), so a member never needs the emailed link.
 *
 * The rules:
 *   - The TIC session id lives on the signer row (never in the shared BankID
 *     flow cookie), so a login in progress in the same browser is untouched.
 *   - A short poll lease on the row: two concurrent polls never both ask TIC,
 *     which hands a completed result out at most twice.
 *   - The poll that sees the session complete checks that the signature binds
 *     this document (userNonVisibleData) and records it through
 *     record_signing_signature, which checks the lock, consumes the session
 *     and fills the årsredovisning slot in one transaction.
 *   - A personnummer is never logged and never answered; the collected
 *     signature only travels to the RPC.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptStoredPersonalNumber, hashPersonalNumber, maskPersonalNumber } from '@/lib/auth/bankid'
import { signerPersonalNumberFromBankIdLogin } from '@/lib/auth/bankid-signer'
import { eventBus } from '@/lib/events/bus'
import type { Logger } from '@/lib/logger'
import type { OperationOutcome } from '@/lib/operations/types'
import { resolveBankIdSigning, type BankIdSigningFailure, type CollectedBankIdSignature } from './bankid-provider'
import { describeRequester } from './requests'
import { sealSigningRequest } from './seal'
import { bankIdNameMatchesSlot, subjectForSigning, subjectStatement } from './subjects'
import { hashSigningToken, isValidSigningTokenFormat } from './tokens'
import { SIGNING_DECLINE_REASON_MAX, requestState, type SigningRequestRow, type SigningRequestState, type SigningSignerRow } from './types'
import { buildUserNonVisibleData, buildUserVisibleData, signatureBindsPayload, signedVisibleText, type SignedPayload } from './visible-data'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

/** How long one poll holds the row while it asks TIC. */
const POLL_LEASE_MS = 10_000
/** Two starts this close are one click twice: the second is refused. */
const START_COOLDOWN_MS = 3_000

export interface SignerScope {
  service: SupabaseClient
  request: SigningRequestRow
  signer: SigningSignerRow
  log: Logger
}

export type ResolveSignerResult =
  | { ok: true; request: SigningRequestRow; signer: SigningSignerRow }
  | { ok: false; reason: 'invalid_format' | 'not_found' | 'not_signer' }

async function loadScope(service: SupabaseClient, signer: SigningSignerRow | null): Promise<ResolveSignerResult> {
  if (!signer) return { ok: false, reason: 'not_found' }
  const { data, error } = await service.from('signing_requests').select('id, company_id, created_by, created_via, document_id, document_sha256, title, message, annual_report_version_id, status, expires_at, completed_at, declined_at, cancelled_at, signed_document_id, evidence_document_id, created_at').eq('id', signer.signing_request_id).maybeSingle()
  if (error) throw error
  const request = data as SigningRequestRow | null
  if (!request) return { ok: false, reason: 'not_found' }
  // An archived company (also a migration reset's source) signs nothing more.
  const { data: company } = await service.from('companies').select('archived_at').eq('id', request.company_id).maybeSingle()
  if (!company || (company as { archived_at: string | null }).archived_at) return { ok: false, reason: 'not_found' }
  return { ok: true, request, signer }
}

/** Resolve a clear link token (service role; strict hash equality). Never log the token. */
export async function resolveSignerByToken(service: SupabaseClient, token: string): Promise<ResolveSignerResult> {
  if (!isValidSigningTokenFormat(token)) return { ok: false, reason: 'invalid_format' }
  const { data, error } = await service.from('signing_request_signers').select('id, company_id, signing_request_id, position, name, email, role_label, user_id, lock_kind, annual_report_signature_id, link_sent_at, last_reminded_at, status, bankid_session_id, bankid_session_started_at, signed_at, bankid_given_name, bankid_surname, declined_at, decline_reason, last_error_code, created_at').eq('token_hash', hashSigningToken(token)).maybeSingle()
  if (error) throw error
  return loadScope(service, (data as SigningSignerRow | null) ?? null)
}

/** Resolve a signer for the logged-in member who is that signer. */
export async function resolveMemberSigner(service: SupabaseClient, signerId: string, userId: string): Promise<ResolveSignerResult> {
  const { data, error } = await service.from('signing_request_signers').select('id, company_id, signing_request_id, position, name, email, role_label, user_id, lock_kind, annual_report_signature_id, link_sent_at, last_reminded_at, status, bankid_session_id, bankid_session_started_at, signed_at, bankid_given_name, bankid_surname, declined_at, decline_reason, last_error_code, created_at').eq('id', signerId).maybeSingle()
  if (error) throw error
  const signer = (data as SigningSignerRow | null) ?? null
  if (signer && signer.user_id !== userId) return { ok: false, reason: 'not_signer' }
  return loadScope(service, signer)
}

export interface SignerPageData {
  request: {
    title: string
    message: string | null
    company_name: string
    requester: string
    file_name: string
    sha256: string
    state: SigningRequestState
    expires_at: string
  }
  signer: {
    /** The signer's place in `signers`, so the page can mark their own row. */
    position: number
    name: string
    role_label: string | null
    status: SigningSignerRow['status']
    signed_at: string | null
    bankid_name: string | null
    /** Locked to one person's BankID (the page says so). */
    locked: boolean
    last_error_code: string | null
  }
  /** Everyone asked to sign, without their addresses. */
  signers: Array<{ position: number; name: string; role_label: string | null; status: SigningSignerRow['status'] }>
}

export async function describeForSigner(scope: SignerScope, now: number = Date.now()): Promise<SignerPageData> {
  const { service, request, signer } = scope
  const [{ data: doc }, { data: others }, sender] = await Promise.all([
    service.from('document_attachments').select('file_name').eq('id', request.document_id).maybeSingle(),
    service.from('signing_request_signers').select('position, name, role_label, status').eq('signing_request_id', request.id).order('position'),
    describeRequester(service, request.company_id, request.created_by),
  ])
  const bankidName = [signer.bankid_given_name, signer.bankid_surname].filter(Boolean).join(' ').trim()
  return {
    request: {
      title: request.title,
      message: request.message,
      company_name: sender.companyName,
      requester: sender.requester,
      file_name: (doc as { file_name?: string } | null)?.file_name ?? 'dokument.pdf',
      sha256: request.document_sha256,
      state: requestState(request, now),
      expires_at: request.expires_at,
    },
    signer: {
      position: signer.position,
      name: signer.name,
      role_label: signer.role_label,
      status: signer.status,
      signed_at: signer.signed_at,
      bankid_name: bankidName || null,
      locked: signer.lock_kind !== 'none',
      last_error_code: signer.last_error_code,
    },
    signers: ((others ?? []) as Array<{ position: number; name: string; role_label: string | null; status: SigningSignerRow['status'] }>),
  }
}

function providerFailure(failure: BankIdSigningFailure): Failure {
  if (failure.code === 'RATE_LIMITED') return { ok: false, code: 'SIGNING_RATE_LIMITED' }
  if (failure.code === 'NOT_CONFIGURED') return { ok: false, code: 'SIGNING_UNAVAILABLE' }
  return { ok: false, code: 'SIGNING_PROVIDER_ERROR', details: { provider_code: failure.code } }
}

function openForSigning(scope: SignerScope, now: number): Failure | null {
  if (requestState(scope.request, now) !== 'open') return { ok: false, code: 'SIGNING_REQUEST_CLOSED' }
  if (scope.signer.status !== 'pending') return { ok: false, code: 'SIGNING_SIGNER_NOT_PENDING' }
  return null
}

/** The personnummer the order is locked to, or null for an unlocked signer. Never logged. */
async function lockedPersonalNumber(scope: SignerScope): Promise<{ ok: true; personalNumber: string | null } | Failure> {
  const { signer, service } = scope
  if (signer.lock_kind === 'none') return { ok: true, personalNumber: null }
  if (signer.lock_kind === 'member') {
    const personalNumber = signer.user_id ? await signerPersonalNumberFromBankIdLogin(signer.user_id) : null
    return personalNumber ? { ok: true, personalNumber } : { ok: false, code: 'SIGNING_SIGNER_MISMATCH' }
  }
  const { data, error } = await service.from('signing_signer_private').select('lock_personnummer_encrypted').eq('signer_id', signer.id).maybeSingle()
  if (error) throw error
  const stored = (data as { lock_personnummer_encrypted?: unknown } | null)?.lock_personnummer_encrypted
  if (!stored) return { ok: false, code: 'SIGNING_SIGNER_MISMATCH' }
  return { ok: true, personalNumber: decryptStoredPersonalNumber(stored as string) }
}

function payloadFor(request: SigningRequestRow, signer: SigningSignerRow, contentHash?: string): SignedPayload {
  return {
    v: 1,
    kind: 'accounted.signing',
    request: request.id,
    signer: signer.id,
    sha256: request.document_sha256,
    ...(contentHash ? { content_hash: contentHash } : {}),
  }
}

export interface StartedSigning {
  auto_start_token: string
  qr_start_token: string
  qr_start_secret: string
  expires_at: string
}

/**
 * Start a BankID sign session for the signer. A session already running for
 * them is cancelled at TIC first (a restart), so only the newest can be
 * recorded (record_signing_signature checks the session id).
 */
export async function startSignature(
  scope: SignerScope,
  input: { endUserIp: string; userAgent?: string | null; now?: number },
): Promise<OperationOutcome<StartedSigning>> {
  const now = input.now ?? Date.now()
  const closed = openForSigning(scope, now)
  if (closed) return closed
  const { service, request, signer, log } = scope
  if (signer.bankid_session_started_at && now - new Date(signer.bankid_session_started_at).getTime() < START_COOLDOWN_MS) {
    return { ok: false, code: 'SIGNING_RATE_LIMITED' }
  }
  const provider = await resolveBankIdSigning()
  if (!provider) return { ok: false, code: 'SIGNING_UNAVAILABLE' }
  const subject = await subjectForSigning(service, request)
  if (!subject.ok) return { ok: false, code: subject.code }
  const lock = await lockedPersonalNumber(scope)
  if (!lock.ok) return lock

  if (signer.bankid_session_id) await provider.cancelBankIdSignature(signer.bankid_session_id).catch(() => null)

  const [{ data: doc }, sender] = await Promise.all([
    service.from('document_attachments').select('file_name').eq('id', request.document_id).maybeSingle(),
    describeRequester(service, request.company_id, request.created_by),
  ])
  const started = await provider.startBankIdSignature({
    endUserIp: input.endUserIp,
    ...(input.userAgent ? { userAgent: input.userAgent } : {}),
    userVisibleData: buildUserVisibleData({
      title: request.title,
      companyName: sender.companyName,
      fileName: (doc as { file_name?: string } | null)?.file_name ?? 'dokument.pdf',
      sha256: request.document_sha256,
      signerName: signer.name,
      roleLabel: signer.role_label,
      statement: subjectStatement(subject.subject, signer, sender.companyName),
    }),
    userNonVisibleData: buildUserNonVisibleData(payloadFor(request, signer, subject.subject.contentHash)),
    ...(lock.personalNumber ? { personalNumber: lock.personalNumber } : {}),
  })
  if (!started.ok) {
    log.warn('signing start refused by the provider', { signerId: signer.id, providerCode: started.code })
    return providerFailure(started)
  }

  const { data: updated, error } = await service
    .from('signing_request_signers')
    .update({
      bankid_session_id: started.data.sessionId,
      bankid_session_started_at: new Date(now).toISOString(),
      poll_lease_until: null,
      last_error_code: null,
    })
    .eq('id', signer.id)
    .eq('status', 'pending')
    .select('id')
  if (error) throw error
  if ((updated ?? []).length !== 1) {
    await provider.cancelBankIdSignature(started.data.sessionId).catch(() => null)
    return { ok: false, code: 'SIGNING_SIGNER_NOT_PENDING' }
  }
  return {
    ok: true,
    data: {
      auto_start_token: started.data.autoStartToken,
      qr_start_token: started.data.qrStartToken,
      qr_start_secret: started.data.qrStartSecret,
      expires_at: started.data.expiresAt,
    },
  }
}

export type SignerPollAnswer =
  | { state: 'idle' }
  | { state: 'pending'; hint_code: string | null; qr_start_token: string | null; qr_start_secret: string | null }
  | { state: 'failed'; hint_code: string | null; code: string | null }
  | { state: 'signed'; signed_at: string | null; completed: boolean }

async function endSession(service: SupabaseClient, signerId: string, sessionId: string, lastErrorCode: string | null): Promise<void> {
  await service
    .from('signing_request_signers')
    .update({ bankid_session_id: null, poll_lease_until: null, last_error_code: lastErrorCode })
    .eq('id', signerId)
    .eq('status', 'pending')
    .eq('bankid_session_id', sessionId)
}

function evidenceFor(signature: CollectedBankIdSignature, visibleText: string) {
  return {
    given_name: signature.givenName,
    surname: signature.surname,
    personnummer_hash: hashPersonalNumber(signature.personalNumber),
    personnummer_masked: maskPersonalNumber(signature.personalNumber),
    completed_at: signature.completedAt,
    user_visible_data: visibleText,
    signature_xml: signature.signatureXml,
    ocsp_response: signature.ocspResponse,
  }
}

/**
 * Drive the signer's BankID session one step. The client calls it about
 * once a second while the BankID app is open; the poll that sees the
 * session complete records the signature, and when it was the last one
 * seals the request (signed PDF and evidence package into the archive).
 */
export async function pollSignature(scope: SignerScope, now: number = Date.now()): Promise<OperationOutcome<SignerPollAnswer>> {
  const { service, request, signer, log } = scope
  if (signer.status === 'signed') {
    return { ok: true, data: { state: 'signed', signed_at: signer.signed_at, completed: request.status === 'completed' } }
  }
  const closed = openForSigning(scope, now)
  if (closed) return closed
  const sessionId = signer.bankid_session_id
  if (!sessionId) return { ok: true, data: { state: 'idle' } }

  // Only one poll at a time asks TIC; the others answer pending and come back.
  const { data: leased, error: leaseError } = await service
    .from('signing_request_signers')
    .update({ poll_lease_until: new Date(now + POLL_LEASE_MS).toISOString() })
    .eq('id', signer.id)
    .eq('status', 'pending')
    .eq('bankid_session_id', sessionId)
    .or(`poll_lease_until.is.null,poll_lease_until.lt.${new Date(now).toISOString()}`)
    .select('id')
  if (leaseError) throw leaseError
  if ((leased ?? []).length !== 1) return { ok: true, data: { state: 'pending', hint_code: null, qr_start_token: null, qr_start_secret: null } }

  const provider = await resolveBankIdSigning()
  if (!provider) return { ok: false, code: 'SIGNING_UNAVAILABLE' }
  const polled = await provider.pollBankIdSignature(sessionId)
  if (!polled.ok) {
    await service.from('signing_request_signers').update({ poll_lease_until: null }).eq('id', signer.id).eq('bankid_session_id', sessionId)
    return providerFailure(polled)
  }
  const poll = polled.data
  if (poll.status === 'pending') {
    await service.from('signing_request_signers').update({ poll_lease_until: null }).eq('id', signer.id).eq('bankid_session_id', sessionId)
    return { ok: true, data: { state: 'pending', hint_code: poll.hintCode, qr_start_token: poll.qrStartToken, qr_start_secret: poll.qrStartSecret } }
  }
  if (poll.status !== 'complete') {
    const hintCode = poll.status === 'failed' ? poll.hintCode : null
    await endSession(service, signer.id, sessionId, null)
    return { ok: true, data: { state: 'failed', hint_code: hintCode, code: poll.status === 'gone' ? 'SIGNING_EVIDENCE_INCOMPLETE' : null } }
  }

  const signature = poll.signature
  const subject = await subjectForSigning(service, request)
  if (!subject.ok) {
    await endSession(service, signer.id, sessionId, subject.code)
    return { ok: false, code: subject.code }
  }
  const nonVisible = buildUserNonVisibleData(payloadFor(request, signer, subject.subject.contentHash))
  if (!signatureBindsPayload(signature.signatureXml, nonVisible)) {
    log.error('BankID signature does not bind the signing payload', new Error('signature unbound'), { signerId: signer.id })
    await endSession(service, signer.id, sessionId, 'SIGNING_SIGNATURE_UNBOUND')
    return { ok: false, code: 'SIGNING_SIGNATURE_UNBOUND' }
  }
  // The board's årsredovisning: the signer's BankID name must be the slot's,
  // or filing would fail at Bolagsverket's name check (kontrollkod 1171).
  if (request.annual_report_version_id && !bankIdNameMatchesSlot(signer.name, signature.givenName, signature.surname)) {
    log.warn('BankID name does not match the årsredovisning slot', { signerId: signer.id })
    await endSession(service, signer.id, sessionId, 'SIGNING_NAME_MISMATCH')
    return { ok: false, code: 'SIGNING_NAME_MISMATCH', details: { bankid_name: `${signature.givenName} ${signature.surname}`.trim(), slot_name: signer.name } }
  }
  const visibleText = signedVisibleText(signature.signatureXml)
  if (!visibleText) {
    await endSession(service, signer.id, sessionId, 'SIGNING_EVIDENCE_INCOMPLETE')
    return { ok: false, code: 'SIGNING_EVIDENCE_INCOMPLETE' }
  }

  const { data: recorded, error: rpcError } = await service.rpc('record_signing_signature', {
    p_signer_id: signer.id,
    p_session_id: sessionId,
    p_evidence: evidenceFor(signature, visibleText),
  })
  if (rpcError) {
    log.error('record_signing_signature failed', rpcError, { signerId: signer.id })
    await endSession(service, signer.id, sessionId, 'SIGNING_RECORD_FAILED')
    throw rpcError
  }
  const result = recorded as { ok: boolean; code?: string; signed_at?: string; completed?: boolean }
  if (!result.ok) {
    await endSession(service, signer.id, sessionId, result.code ?? 'SIGNING_RECORD_REFUSED')
    return { ok: false, code: result.code ?? 'INTERNAL_ERROR' }
  }

  log.info('signature recorded', { signingRequestId: request.id, signerId: signer.id, completed: result.completed === true })
  await eventBus.emit({
    type: 'signing.signer_signed',
    payload: {
      signingRequestId: request.id,
      signerId: signer.id,
      position: signer.position,
      signedAt: result.signed_at ?? new Date(now).toISOString(),
      userId: request.created_by,
      companyId: request.company_id,
    },
  })
  if (result.completed) {
    const sealed = await sealSigningRequest(service, request.id, log).catch((err) => {
      log.error('signing request seal failed; retried on the next read', err instanceof Error ? err : new Error(String(err)), { signingRequestId: request.id })
      return null
    })
    await eventBus.emit({
      type: 'signing.completed',
      payload: {
        signingRequestId: request.id,
        documentId: request.document_id,
        signedDocumentId: sealed?.signedDocumentId ?? null,
        evidenceDocumentId: sealed?.evidenceDocumentId ?? null,
        annualReportVersionId: request.annual_report_version_id,
        userId: request.created_by,
        companyId: request.company_id,
      },
    })
  }
  return { ok: true, data: { state: 'signed', signed_at: result.signed_at ?? null, completed: result.completed === true } }
}

/** Stop the signer's BankID signing in progress; the page can start a new one. */
export async function cancelSignatureSession(scope: SignerScope): Promise<OperationOutcome<{ cancelled: true }>> {
  const { service, signer } = scope
  const sessionId = signer.bankid_session_id
  if (!sessionId || signer.status !== 'pending') return { ok: true, data: { cancelled: true } }
  const provider = await resolveBankIdSigning()
  if (provider) await provider.cancelBankIdSignature(sessionId).catch(() => null)
  await endSession(service, signer.id, sessionId, null)
  return { ok: true, data: { cancelled: true } }
}

/**
 * The signer declines: their row and the request close, the sender sees the
 * reason. Signatures others already made stay, as evidence.
 */
export async function declineSignature(
  scope: SignerScope,
  input: { reason?: string | null; now?: number },
): Promise<OperationOutcome<{ declined: true }>> {
  const now = input.now ?? Date.now()
  const closed = openForSigning(scope, now)
  if (closed) return closed
  const { service, request, signer } = scope
  const reason = input.reason?.trim().slice(0, SIGNING_DECLINE_REASON_MAX) || null
  if (signer.bankid_session_id) await cancelSignatureSession(scope)
  const at = new Date(now).toISOString()
  // The request first, in record_signing_signature's lock order (request,
  // then signer): a signature racing the decline then sees a closed request.
  const { data: closedRequest, error: requestError } = await service
    .from('signing_requests')
    .update({ status: 'declined', declined_at: at })
    .eq('id', request.id)
    .eq('status', 'open')
    .select('id')
  if (requestError) throw requestError
  if ((closedRequest ?? []).length !== 1) return { ok: false, code: 'SIGNING_REQUEST_CLOSED' }
  const { error } = await service
    .from('signing_request_signers')
    .update({ status: 'declined', declined_at: at, decline_reason: reason, bankid_session_id: null, poll_lease_until: null })
    .eq('id', signer.id)
    .eq('status', 'pending')
  if (error) throw error
  await eventBus.emit({
    type: 'signing.declined',
    payload: { signingRequestId: request.id, signerId: signer.id, position: signer.position, userId: request.created_by, companyId: request.company_id },
  })
  return { ok: true, data: { declined: true } }
}
