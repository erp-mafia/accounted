/**
 * Signing requests: create, read, cancel and remind. The one implementation
 * behind the app's session routes and (later) the v1 and MCP doors; the
 * signer's side (the BankID ceremony) is ./ceremony.ts.
 *
 * Every write is the service role's, after the door authenticated the
 * sender: the tables have no browser write policy (migration
 * 20261025200000_signing_requests.sql). Reads take the caller's client and
 * still filter by company, so the session's RLS and the service role's
 * explicit filter say the same.
 *
 * A signer may be locked to a person: a member with a BankID login is locked
 * to that identity (never copied); a personnummer the sender typed in the app
 * is stored hashed and encrypted in signing_signer_private and sent to TIC so
 * only that person can sign. The v1 and MCP doors never carry a personnummer
 * (their inputs are strict, and staging refuses personnummer keys).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { encryptPersonalNumberForStorage, hashPersonalNumber } from '@/lib/auth/bankid'
import { hasBankIdLogin, normalizeSignerPersonalNumber } from '@/lib/auth/bankid-signer'
import { getCompanyRole } from '@/lib/auth/require-write'
import { actingByraName } from '@/lib/attribution/acting-byra'
import { getBaseUrlForCompany } from '@/lib/email/brand-sender'
import { sendSigningRequestMail } from '@/lib/email/send-signing-request'
import { eventBus } from '@/lib/events/bus'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { arsredovisningSigningEnabledFor, signingEnabledFor } from '@/lib/env/signing-switch'
import { COMPANY_ADMIN_ROLES } from '@/lib/operations/access'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { createServiceClient } from '@/lib/supabase/server'
import { resolveBankIdSigning } from './bankid-provider'
import { loadSignableDocument } from './document'
import { generateSigningToken, signingUrl } from './tokens'
import {
  SIGNING_DEFAULT_TTL_DAYS,
  SIGNING_MAX_SIGNERS,
  SIGNING_MAX_TTL_DAYS,
  SIGNING_REMIND_INTERVAL_MS,
  requestState,
  type SignerLockKind,
  type SigningCreatedVia,
  type SigningRequestRow,
  type SigningRequestState,
  type SigningSignerRow,
} from './types'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

/** A BankID start in the last few minutes means the signer may be signing right now. */
const SESSION_ACTIVE_MS = 5 * 60 * 1000

export interface SigningAvailability {
  /** Signing is offered to this company: the rollout includes it and a BankID provider is wired. */
  offered: boolean
  /** It may send a document for signing: offered, and its plan (or trial) holds the signing capability. */
  available: boolean
  /** It may send a locked årsredovisning to its board: available, and the årsredovisning rollout includes it. */
  arsredovisning: boolean
}

/**
 * Whether this company may start a signing, the one answer every door asks
 * (the app, v1, MCP, the årsredovisning request): the SIGNING_ENABLED
 * rollout, a wired BankID provider and the paid capability. Signing a
 * request already sent and reading what was signed never ask it.
 */
export async function signingAvailability(supabase: SupabaseClient, companyId: string): Promise<SigningAvailability> {
  const off = { offered: false, available: false, arsredovisning: false }
  if (!signingEnabledFor(companyId)) return off
  if ((await resolveBankIdSigning()) === null) return off
  if (!(await hasCapability(supabase, companyId, CAPABILITY.signing))) return { ...off, offered: true }
  return { offered: true, available: true, arsredovisning: arsredovisningSigningEnabledFor(companyId) }
}

/** Why this company may not start a signing, or null when it may. */
export async function signingStartRefusal(
  supabase: SupabaseClient,
  companyId: string,
  { arsredovisning = false }: { arsredovisning?: boolean } = {},
): Promise<'SIGNING_UNAVAILABLE' | 'SIGNING_CAPABILITY_BLOCKED' | null> {
  const state = await signingAvailability(supabase, companyId)
  if (!state.offered) return 'SIGNING_UNAVAILABLE'
  if (!state.available) return 'SIGNING_CAPABILITY_BLOCKED'
  if (arsredovisning && !state.arsredovisning) return 'SIGNING_UNAVAILABLE'
  return null
}

export interface SignerInput {
  name: string
  email?: string | null
  roleLabel?: string | null
  /** A member of the company; locked to their BankID login when they have one. */
  userId?: string | null
  /** Typed in the app's dialog only; locks the signer to this person. */
  personalNumber?: string | null
  /** The årsredovisning slot this signer fills (annual-report requests only). */
  annualReportSignatureId?: string | null
}

export interface CreateSigningRequestInput {
  documentId: string
  title: string
  message?: string | null
  signers: SignerInput[]
  expiresInDays?: number | null
  /** Mail each signer who has an email address (default true). */
  sendEmail?: boolean
  createdVia: SigningCreatedVia
  /** The board's signatures on a locked årsredovisning version. */
  annualReportVersionId?: string | null
  now?: number
}

export interface CreatedSigner {
  signer_id: string
  position: number
  name: string
  email: string | null
  /** The årsredovisning slot this signer fills, on a request over a locked version. */
  annual_report_signature_id: string | null
  lock: SignerLockKind
  email_sent: boolean
  /** The signer's link: answered only when no mail carried it. The URL is the credential. */
  url: string | null
}

export interface CreatedSigningRequest {
  signing_request_id: string
  status: 'open'
  title: string
  document_id: string
  document_sha256: string
  expires_at: string
  signers: CreatedSigner[]
}

export interface CheckedSigner {
  position: number
  name: string
  email: string | null
  roleLabel: string | null
  userId: string | null
  lock: SignerLockKind
  personalNumber: string | null
  annualReportSignatureId: string | null
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function invalidSigners(reason: string): Failure {
  return { ok: false, code: 'SIGNING_SIGNERS_INVALID', details: { reason } }
}

/** The signer rules createSigningRequest applies (names, duplicates, membership, personnummer, the lock), without writing. */
export async function checkSigners(
  service: SupabaseClient,
  companyId: string,
  signers: SignerInput[],
  options: { samePersonMaySignTwice?: boolean } = {},
): Promise<{ ok: true; signers: CheckedSigner[] } | Failure> {
  // On an årsredovisning one person may hold two slots (styrelseledamot and
  // VD): each slot is its own signature, so the same address, member or
  // personnummer may appear twice there and nowhere else.
  const repeatable = options.samePersonMaySignTwice === true
  if (signers.length < 1 || signers.length > SIGNING_MAX_SIGNERS) return invalidSigners('count')
  const emails = new Set<string>()
  const users = new Set<string>()
  const numbers = new Set<string>()
  const memberIds = signers.map((s) => clean(s.userId)).filter((id): id is string => id !== null)
  let members = new Set<string>()
  if (memberIds.length > 0) {
    const { data, error } = await service.from('company_members').select('user_id').eq('company_id', companyId).in('user_id', memberIds)
    if (error) throw error
    members = new Set(((data ?? []) as Array<{ user_id: string }>).map((m) => m.user_id))
  }

  const checked: CheckedSigner[] = []
  for (const [index, signer] of signers.entries()) {
    const name = clean(signer.name)
    if (!name) return invalidSigners('name')
    const email = clean(signer.email)?.toLowerCase() ?? null
    if (email) {
      if (emails.has(email) && !repeatable) return invalidSigners('duplicate_email')
      emails.add(email)
    }
    const userId = clean(signer.userId)
    if (userId) {
      if (!members.has(userId)) return invalidSigners('not_a_member')
      if (users.has(userId) && !repeatable) return invalidSigners('duplicate_member')
      users.add(userId)
    }
    let personalNumber: string | null = null
    if (clean(signer.personalNumber)) {
      personalNumber = normalizeSignerPersonalNumber(signer.personalNumber)
      if (!personalNumber) return invalidSigners('personnummer')
      if (numbers.has(personalNumber) && !repeatable) return invalidSigners('duplicate_personnummer')
      numbers.add(personalNumber)
    }
    let lock: SignerLockKind = 'none'
    if (personalNumber) lock = 'personnummer'
    else if (userId && (await hasBankIdLogin(userId))) lock = 'member'
    checked.push({
      position: index + 1,
      name,
      email,
      roleLabel: clean(signer.roleLabel),
      userId,
      lock,
      personalNumber,
      annualReportSignatureId: clean(signer.annualReportSignatureId),
    })
  }
  return { ok: true, signers: checked }
}

function expiresAt(input: CreateSigningRequestInput, now: number): string {
  const days = Math.min(Math.max(Math.trunc(input.expiresInDays ?? SIGNING_DEFAULT_TTL_DAYS), 1), SIGNING_MAX_TTL_DAYS)
  return new Date(now + days * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Who asks, for the mail and the signer's page: the byrå's team name when
 * the sender acts through the company's byrå team, else the sender's own
 * name, else the company's.
 */
export async function describeRequester(service: SupabaseClient, companyId: string, userId: string): Promise<{ companyName: string; requester: string }> {
  const { data: companyRow } = await service.from('companies').select('name, team_id').eq('id', companyId).maybeSingle()
  const company = (companyRow as { name: string | null; team_id: string | null } | null) ?? null
  const companyName = company?.name?.trim() || 'Företaget'
  const byra = await actingByraName(service, company?.team_id, userId)
  if (byra) return { companyName, requester: byra }
  const { data: profile } = await service.from('profiles').select('full_name').eq('id', userId).maybeSingle()
  const name = (profile as { full_name?: string | null } | null)?.full_name?.trim()
  return { companyName, requester: name || companyName }
}

/**
 * Create a signing request over an archived PDF and mail the signers who
 * have an address. Refused when signing is not open here, the document is
 * not a signable PDF, or a signer is wrong.
 */
export async function createSigningRequest(ctx: OperationContext, input: CreateSigningRequestInput): Promise<OperationOutcome<CreatedSigningRequest>> {
  const refusal = await signingStartRefusal(ctx.supabase, ctx.companyId, { arsredovisning: Boolean(input.annualReportVersionId) })
  if (refusal) return { ok: false, code: refusal }
  const title = clean(input.title)
  if (!title) return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'title' } }
  const service = createServiceClient()
  const now = input.now ?? Date.now()

  const document = await loadSignableDocument(service, ctx.companyId, input.documentId)
  if (!document.ok) return { ok: false, code: document.code }
  const checkedSigners = await checkSigners(service, ctx.companyId, input.signers, { samePersonMaySignTwice: Boolean(input.annualReportVersionId) })
  if (!checkedSigners.ok) return checkedSigners
  const signers = checkedSigners.signers
  // An annual-report request has one slot per signer; any other request none.
  const withSlot = signers.filter((s) => s.annualReportSignatureId !== null).length
  if (input.annualReportVersionId ? withSlot !== signers.length : withSlot > 0) return invalidSigners('annual_report_slots')

  const expires = expiresAt(input, now)
  const { data: created, error: createError } = await service
    .from('signing_requests')
    .insert({
      company_id: ctx.companyId,
      created_by: ctx.userId,
      created_via: input.createdVia,
      document_id: document.document.id,
      document_sha256: document.document.sha256_hash,
      title,
      message: clean(input.message),
      annual_report_version_id: input.annualReportVersionId ?? null,
      expires_at: expires,
    })
    .select('id')
    .single()
  if (createError || !created) return { ok: false, code: 'INTERNAL_ERROR', error: createError ?? new Error('Signing request not stored') }
  const requestId = (created as { id: string }).id

  const tokens = signers.map(() => generateSigningToken())
  const { data: signerRows, error: signerError } = await service
    .from('signing_request_signers')
    .insert(signers.map((s, i) => ({
      company_id: ctx.companyId,
      signing_request_id: requestId,
      position: s.position,
      name: s.name,
      email: s.email,
      role_label: s.roleLabel,
      user_id: s.userId,
      lock_kind: s.lock,
      annual_report_signature_id: s.annualReportSignatureId,
      token_hash: tokens[i]!.hash,
    })))
    .select('id, position')
  const locked = signers.filter((s) => s.personalNumber)
  let privateError: unknown = null
  if (!signerError && locked.length > 0) {
    const byPosition = new Map(((signerRows ?? []) as Array<{ id: string; position: number }>).map((r) => [r.position, r.id]))
    const { error } = await service.from('signing_signer_private').insert(locked.map((s) => ({
      signer_id: byPosition.get(s.position),
      company_id: ctx.companyId,
      lock_personnummer_hash: hashPersonalNumber(s.personalNumber!),
      lock_personnummer_encrypted: encryptPersonalNumberForStorage(s.personalNumber!),
    })))
    privateError = error
  }
  if (signerError || privateError || !signerRows) {
    // Nobody has signed anything: the request goes again, signers with it.
    await service.from('signing_requests').delete().eq('id', requestId)
    return { ok: false, code: 'INTERNAL_ERROR', error: signerError ?? privateError ?? new Error('Signers not stored') }
  }
  const idByPosition = new Map(((signerRows ?? []) as Array<{ id: string; position: number }>).map((r) => [r.position, r.id]))

  const baseUrl = await getBaseUrlForCompany(ctx.companyId)
  const sendEmail = input.sendEmail ?? true
  const sender = sendEmail && signers.some((s) => s.email) ? await describeRequester(service, ctx.companyId, ctx.userId) : null
  const results: CreatedSigner[] = []
  for (const [i, s] of signers.entries()) {
    const signerId = idByPosition.get(s.position)!
    const url = signingUrl(baseUrl, tokens[i]!.token)
    let emailSent = false
    if (sender && s.email) {
      const sent = await sendSigningRequestMail({
        companyId: ctx.companyId,
        companyName: sender.companyName,
        requester: sender.requester,
        title,
        email: s.email,
        url,
        expiresAt: expires,
        message: clean(input.message),
        log: ctx.log,
      })
      emailSent = sent.emailSent
      if (emailSent) {
        await service.from('signing_request_signers').update({ link_sent_at: new Date(now).toISOString() }).eq('id', signerId).then(({ error }) => {
          if (error) ctx.log.warn('signing link mail not logged on the signer', { message: error.message })
        })
      }
    }
    results.push({
      signer_id: signerId,
      position: s.position,
      name: s.name,
      email: s.email,
      annual_report_signature_id: s.annualReportSignatureId,
      lock: s.lock,
      email_sent: emailSent,
      url: emailSent ? null : url,
    })
  }

  await eventBus.emit({
    type: 'signing.requested',
    payload: {
      signingRequestId: requestId,
      documentId: document.document.id,
      signerCount: signers.length,
      createdVia: input.createdVia,
      annualReportVersionId: input.annualReportVersionId ?? null,
      userId: ctx.userId,
      companyId: ctx.companyId,
    },
  })

  return {
    ok: true,
    created: true,
    data: {
      signing_request_id: requestId,
      status: 'open',
      title,
      document_id: document.document.id,
      document_sha256: document.document.sha256_hash,
      expires_at: expires,
      signers: results,
    },
  }
}

/**
 * What createSigningRequest would do, with every rule it applies and nothing
 * stored, minted or mailed: the staging preview an approver reads and the
 * ?dry_run=true answer. The links are the credential, so they exist only
 * after the real call. Deterministic for unchanged state (no expiry instant,
 * the validity in days instead), so a pinned preview stays valid.
 */
export async function previewSigningRequest(ctx: OperationContext, input: CreateSigningRequestInput): Promise<OperationOutcome<never>> {
  const refusal = await signingStartRefusal(ctx.supabase, ctx.companyId, { arsredovisning: Boolean(input.annualReportVersionId) })
  if (refusal) return { ok: false, code: refusal }
  const title = clean(input.title)
  if (!title) return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'title' } }
  // Reads only, on the caller's client: the file's bytes are checked when the
  // request is made (createSigningRequest), never by a preview.
  const document = await loadSignableDocument(ctx.supabase, ctx.companyId, input.documentId, { checkBytes: false })
  if (!document.ok) return { ok: false, code: document.code }
  const checkedSigners = await checkSigners(ctx.supabase, ctx.companyId, input.signers, { samePersonMaySignTwice: Boolean(input.annualReportVersionId) })
  if (!checkedSigners.ok) return checkedSigners
  const signers = checkedSigners.signers
  const withSlot = signers.filter((s) => s.annualReportSignatureId !== null).length
  if (input.annualReportVersionId ? withSlot !== signers.length : withSlot > 0) return invalidSigners('annual_report_slots')
  const sendEmail = input.sendEmail ?? true
  return {
    ok: true,
    dryRun: true,
    preview: {
      document_id: document.document.id,
      file_name: document.document.file_name,
      document_sha256: document.document.sha256_hash,
      title,
      message: clean(input.message),
      valid_days: Math.min(Math.max(Math.trunc(input.expiresInDays ?? SIGNING_DEFAULT_TTL_DAYS), 1), SIGNING_MAX_TTL_DAYS),
      signers: signers.map((s) => ({
        position: s.position,
        name: s.name,
        email: s.email,
        role_label: s.roleLabel,
        lock: s.lock,
        email_will_be_sent: sendEmail && s.email !== null,
      })),
      urls: null,
    },
  }
}

export interface SignerView {
  signer_id: string
  position: number
  name: string
  email: string | null
  role_label: string | null
  user_id: string | null
  /** The årsredovisning slot this signer fills, on a request over a locked version. */
  annual_report_signature_id: string | null
  lock: SignerLockKind
  status: SigningSignerRow['status']
  signed_at: string | null
  /** The name in the BankID the signer signed with. */
  bankid_name: string | null
  declined_at: string | null
  decline_reason: string | null
  last_error_code: string | null
  link_sent_at: string | null
  last_reminded_at: string | null
}

export interface SigningRequestView {
  signing_request_id: string
  title: string
  message: string | null
  state: SigningRequestState
  document_id: string
  document_sha256: string
  annual_report_version_id: string | null
  created_by: string
  created_via: SigningCreatedVia
  created_at: string
  expires_at: string
  completed_at: string | null
  declined_at: string | null
  cancelled_at: string | null
  signed_document_id: string | null
  evidence_document_id: string | null
  signers: SignerView[]
}

type SignerViewRow = Pick<
  SigningSignerRow,
  'id' | 'signing_request_id' | 'position' | 'name' | 'email' | 'role_label' | 'user_id' | 'lock_kind' | 'annual_report_signature_id' | 'status' | 'signed_at' |
  'bankid_given_name' | 'bankid_surname' | 'declined_at' | 'decline_reason' | 'last_error_code' | 'link_sent_at' | 'last_reminded_at'
>

function signerView(row: SignerViewRow): SignerView {
  const bankidName = [row.bankid_given_name, row.bankid_surname].filter(Boolean).join(' ').trim()
  return {
    signer_id: row.id,
    position: row.position,
    name: row.name,
    email: row.email,
    annual_report_signature_id: row.annual_report_signature_id,
    role_label: row.role_label,
    user_id: row.user_id,
    lock: row.lock_kind,
    status: row.status,
    signed_at: row.signed_at,
    bankid_name: bankidName || null,
    declined_at: row.declined_at,
    decline_reason: row.decline_reason,
    last_error_code: row.last_error_code,
    link_sent_at: row.link_sent_at,
    last_reminded_at: row.last_reminded_at,
  }
}

function requestView(row: SigningRequestRow, signers: SignerViewRow[], now: number): SigningRequestView {
  return {
    signing_request_id: row.id,
    title: row.title,
    message: row.message,
    state: requestState(row, now),
    document_id: row.document_id,
    document_sha256: row.document_sha256,
    annual_report_version_id: row.annual_report_version_id,
    created_by: row.created_by,
    created_via: row.created_via,
    created_at: row.created_at,
    expires_at: row.expires_at,
    completed_at: row.completed_at,
    declined_at: row.declined_at,
    cancelled_at: row.cancelled_at,
    signed_document_id: row.signed_document_id,
    evidence_document_id: row.evidence_document_id,
    signers: signers.filter((s) => s.signing_request_id === row.id).sort((a, b) => a.position - b.position).map(signerView),
  }
}

export interface ListSigningRequestsInput {
  documentId?: string | null
  annualReportVersionId?: string | null
  status?: SigningRequestStatusFilter | null
  limit?: number
  now?: number
}

export type SigningRequestStatusFilter = 'open' | 'completed' | 'declined' | 'cancelled'

/** The company's requests, newest first, with their signers. */
export async function listSigningRequests(
  ctx: Pick<OperationContext, 'supabase' | 'companyId'>,
  input: ListSigningRequestsInput = {},
): Promise<SigningRequestView[]> {
  let query = ctx.supabase
    .from('signing_requests')
    .select('id, company_id, created_by, created_via, document_id, document_sha256, title, message, annual_report_version_id, status, expires_at, completed_at, declined_at, cancelled_at, signed_document_id, evidence_document_id, created_at')
    .eq('company_id', ctx.companyId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 200))
  if (input.documentId) query = query.or(`document_id.eq.${input.documentId},signed_document_id.eq.${input.documentId},evidence_document_id.eq.${input.documentId}`)
  if (input.annualReportVersionId) query = query.eq('annual_report_version_id', input.annualReportVersionId)
  if (input.status) query = query.eq('status', input.status)
  const { data, error } = await query
  if (error) throw error
  const requests = (data ?? []) as SigningRequestRow[]
  if (requests.length === 0) return []
  const { data: signerData, error: signerError } = await ctx.supabase
    .from('signing_request_signers')
    .select('id, signing_request_id, position, name, email, role_label, user_id, lock_kind, annual_report_signature_id, status, signed_at, bankid_given_name, bankid_surname, declined_at, decline_reason, last_error_code, link_sent_at, last_reminded_at')
    .eq('company_id', ctx.companyId)
    .in('signing_request_id', requests.map((r) => r.id))
  if (signerError) throw signerError
  const now = input.now ?? Date.now()
  return requests.map((r) => requestView(r, (signerData ?? []) as SignerViewRow[], now))
}

export async function getSigningRequest(
  ctx: Pick<OperationContext, 'supabase' | 'companyId'>,
  signingRequestId: string,
  now: number = Date.now(),
): Promise<OperationOutcome<SigningRequestView>> {
  const { data, error } = await ctx.supabase
    .from('signing_requests')
    .select('id, company_id, created_by, created_via, document_id, document_sha256, title, message, annual_report_version_id, status, expires_at, completed_at, declined_at, cancelled_at, signed_document_id, evidence_document_id, created_at')
    .eq('company_id', ctx.companyId)
    .eq('id', signingRequestId)
    .maybeSingle()
  if (error) throw error
  const row = data as SigningRequestRow | null
  if (!row) return { ok: false, code: 'SIGNING_REQUEST_NOT_FOUND' }
  const { data: signerData, error: signerError } = await ctx.supabase
    .from('signing_request_signers')
    .select('id, signing_request_id, position, name, email, role_label, user_id, lock_kind, annual_report_signature_id, status, signed_at, bankid_given_name, bankid_surname, declined_at, decline_reason, last_error_code, link_sent_at, last_reminded_at')
    .eq('company_id', ctx.companyId)
    .eq('signing_request_id', row.id)
  if (signerError) throw signerError
  return { ok: true, data: requestView(row, (signerData ?? []) as SignerViewRow[], now) }
}

async function loadRequestForWrite(service: SupabaseClient, companyId: string, signingRequestId: string): Promise<SigningRequestRow | null> {
  const { data, error } = await service.from('signing_requests').select('id, company_id, created_by, created_via, document_id, document_sha256, title, message, annual_report_version_id, status, expires_at, completed_at, declined_at, cancelled_at, signed_document_id, evidence_document_id, created_at').eq('company_id', companyId).eq('id', signingRequestId).maybeSingle()
  if (error) throw error
  return (data as SigningRequestRow | null) ?? null
}

/** The sender, an owner or an admin may cancel or chase a request. */
async function mayManage(ctx: OperationContext, request: SigningRequestRow): Promise<boolean> {
  if (request.created_by === ctx.userId) return true
  const role = await getCompanyRole(ctx.supabase, ctx.userId, { companyId: ctx.companyId })
  return role.ok && (COMPANY_ADMIN_ROLES as readonly string[]).includes(role.role)
}

const MANAGE_FORBIDDEN: Failure = {
  ok: false,
  code: 'FORBIDDEN',
  messageSv: 'Bara den som skickade signeringen, företagets ägare eller en administratör kan ändra den.',
}

/**
 * Cancel an open request: its links stop working and a BankID signing in
 * progress is stopped at TIC. Cancelling twice answers the same; a request
 * that completed or was declined cannot be cancelled. Signatures already
 * made stay, as evidence.
 */
export async function cancelSigningRequest(
  ctx: OperationContext,
  input: { signingRequestId: string; now?: number; dryRun?: boolean },
): Promise<OperationOutcome<{ signing_request_id: string; cancelled: true }>> {
  // A dry run reads on the caller's client; the cancel itself writes as the service role.
  const service = input.dryRun ? ctx.supabase : createServiceClient()
  const request = await loadRequestForWrite(service, ctx.companyId, input.signingRequestId)
  if (!request) return { ok: false, code: 'SIGNING_REQUEST_NOT_FOUND' }
  if (!(await mayManage(ctx, request))) return MANAGE_FORBIDDEN
  if (request.status === 'cancelled') return { ok: true, data: { signing_request_id: request.id, cancelled: true } }
  if (request.status !== 'open') return { ok: false, code: 'SIGNING_REQUEST_CLOSED' }
  if (input.dryRun) return { ok: true, dryRun: true, preview: { signing_request_id: request.id, title: request.title, will_cancel: true } }

  const { data: updated, error } = await service
    .from('signing_requests')
    .update({ status: 'cancelled', cancelled_at: new Date(input.now ?? Date.now()).toISOString() })
    .eq('id', request.id)
    .eq('company_id', ctx.companyId)
    .eq('status', 'open')
    .select('id')
  if (error) throw error
  if ((updated ?? []).length !== 1) return { ok: false, code: 'SIGNING_REQUEST_CLOSED' }

  // Best effort: a session still open at TIC can no longer be recorded anyway.
  const provider = await resolveBankIdSigning()
  const { data: sessions } = await service
    .from('signing_request_signers')
    .select('id, bankid_session_id')
    .eq('signing_request_id', request.id)
    .eq('status', 'pending')
    .not('bankid_session_id', 'is', null)
  for (const s of (sessions ?? []) as Array<{ id: string; bankid_session_id: string }>) {
    if (provider) await provider.cancelBankIdSignature(s.bankid_session_id).catch(() => null) // best effort: an order not cancelled expires on its own
    await service.from('signing_request_signers').update({ bankid_session_id: null, poll_lease_until: null }).eq('id', s.id).eq('status', 'pending')
  }
  await eventBus.emit({ type: 'signing.cancelled', payload: { signingRequestId: request.id, userId: request.created_by, companyId: ctx.companyId } })
  return { ok: true, data: { signing_request_id: request.id, cancelled: true } }
}

export interface RemindedSigner {
  signing_request_id: string
  signer_id: string
  email_sent: boolean
  /** The signer's new link when the mail did not go out (the old link stopped working). */
  url: string | null
}

/**
 * Mail a pending signer again, at most once per SIGNING_REMIND_INTERVAL_MS.
 * The reminder carries a new link and the old one stops working (only its
 * hash is kept), so it is refused while the signer may be in a BankID
 * signing right now. A signer without an address gets a new link instead,
 * answered for the sender to hand over (the first one was shown only once).
 */
export async function remindSigner(
  ctx: OperationContext,
  input: { signingRequestId: string; signerId: string; now?: number; dryRun?: boolean },
): Promise<OperationOutcome<RemindedSigner>> {
  const now = input.now ?? Date.now()
  // A dry run reads on the caller's client; the reminder itself writes as the service role.
  const service = input.dryRun ? ctx.supabase : createServiceClient()
  const request = await loadRequestForWrite(service, ctx.companyId, input.signingRequestId)
  if (!request) return { ok: false, code: 'SIGNING_REQUEST_NOT_FOUND' }
  if (!(await mayManage(ctx, request))) return MANAGE_FORBIDDEN
  if (requestState(request, now) !== 'open') return { ok: false, code: 'SIGNING_REQUEST_CLOSED' }

  const { data, error } = await service
    .from('signing_request_signers')
    .select('id, company_id, signing_request_id, position, name, email, role_label, user_id, lock_kind, annual_report_signature_id, link_sent_at, last_reminded_at, status, bankid_session_id, bankid_session_started_at, signed_at, bankid_given_name, bankid_surname, declined_at, decline_reason, last_error_code, created_at')
    .eq('signing_request_id', request.id)
    .eq('id', input.signerId)
    .maybeSingle()
  if (error) throw error
  const signer = data as SigningSignerRow | null
  if (!signer) return { ok: false, code: 'SIGNING_SIGNER_NOT_FOUND' }
  if (signer.status !== 'pending') return { ok: false, code: 'SIGNING_SIGNER_NOT_PENDING' }
  const lastMail = Math.max(
    signer.link_sent_at ? new Date(signer.link_sent_at).getTime() : 0,
    signer.last_reminded_at ? new Date(signer.last_reminded_at).getTime() : 0,
  )
  if (signer.email && lastMail > 0 && now - lastMail < SIGNING_REMIND_INTERVAL_MS) return { ok: false, code: 'SIGNING_REMIND_TOO_SOON' }
  if (signer.bankid_session_id && signer.bankid_session_started_at && now - new Date(signer.bankid_session_started_at).getTime() < SESSION_ACTIVE_MS) {
    return { ok: false, code: 'SIGNING_SESSION_ACTIVE' }
  }
  // The new link is the credential: it exists only after the real call.
  if (input.dryRun) {
    return { ok: true, dryRun: true, preview: { signing_request_id: request.id, signer_id: signer.id, signer_name: signer.name, email: signer.email, url: null } }
  }

  const { token, hash } = generateSigningToken()
  const { data: rotated, error: rotateError } = await service
    .from('signing_request_signers')
    .update({ token_hash: hash, last_reminded_at: new Date(now).toISOString(), bankid_session_id: null, poll_lease_until: null })
    .eq('id', signer.id)
    .eq('status', 'pending')
    .select('id')
  if (rotateError) throw rotateError
  if ((rotated ?? []).length !== 1) return { ok: false, code: 'SIGNING_SIGNER_NOT_PENDING' }

  const url = signingUrl(await getBaseUrlForCompany(ctx.companyId), token)
  if (!signer.email) return { ok: true, data: { signing_request_id: request.id, signer_id: signer.id, email_sent: false, url } }
  const sender = await describeRequester(service, ctx.companyId, request.created_by)
  const sent = await sendSigningRequestMail({
    companyId: ctx.companyId,
    companyName: sender.companyName,
    requester: sender.requester,
    title: request.title,
    email: signer.email,
    url,
    expiresAt: request.expires_at,
    message: request.message,
    reminder: true,
    log: ctx.log,
  })
  return { ok: true, data: { signing_request_id: request.id, signer_id: signer.id, email_sent: sent.emailSent, url: sent.emailSent ? null : url } }
}
