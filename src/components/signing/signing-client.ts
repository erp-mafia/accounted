/**
 * The browser side of BankID document signing (lib/signing).
 *
 * Two halves:
 *   - The signer's calls, behind one base path so the same page serves both
 *     doors: /api/signera/<token> (anyone holding the mailed link; the token
 *     is the credential, so it travels in the path and never in a header or
 *     a log line) and /api/signing/me/<signerId> (a logged-in member who is
 *     the signer). Both answer the same shapes (lib/signing/ceremony-routes.ts).
 *   - The sender's session calls: availability, create, list, cancel, remind.
 *
 * Every failure is thrown as a SigningClientError carrying the canonical
 * envelope ({ error: { code, message, message_en } }), so a caller maps it
 * with getErrorMessage and branches on `code`.
 */

import type { SignerPageData, SignerPollAnswer, StartedSigning } from '@/lib/signing/ceremony'
import type { CreatedSigningRequest, RemindedSigner, SigningRequestStatusFilter, SigningRequestView } from '@/lib/signing/requests'

export class SigningClientError extends Error {
  constructor(
    readonly body: unknown,
    readonly status: number,
  ) {
    super(`signing request failed (${status})`)
    this.name = 'SigningClientError'
  }

  get code(): string | null {
    const code = (this.body as { error?: { code?: unknown } } | null)?.error?.code
    return typeof code === 'string' ? code : null
  }
}

/** The error envelope of a thrown call, for getErrorMessage; null for a network failure. */
export function signingErrorBody(error: unknown): unknown {
  return error instanceof SigningClientError ? error.body : null
}

/** The structured code of a thrown call, or null. */
export function signingErrorCode(error: unknown): string | null {
  return error instanceof SigningClientError ? error.code : null
}

async function send<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) throw new SigningClientError(body, res.status)
  return (body as { data: T }).data
}

// ---------------------------------------------------------------------------
// The signer: /api/signera/<token> or /api/signing/me/<signerId>
// ---------------------------------------------------------------------------

/** The public door: the mailed link's token routes. */
export function signerTokenBase(token: string): string {
  return `/api/signera/${encodeURIComponent(token)}`
}

/** The member door: the logged-in member who is the signer. */
export function memberSignerBase(signerId: string): string {
  return `/api/signing/me/${encodeURIComponent(signerId)}`
}

export interface SignerClient {
  /** Where the PDF being signed is served inline (the page embeds it and links it). */
  documentUrl: string
  /** Where the signed copy is served once everyone has signed. */
  signedCopyUrl: string
  describe(): Promise<SignerPageData>
  start(): Promise<StartedSigning>
  poll(signal?: AbortSignal): Promise<SignerPollAnswer>
  cancel(): Promise<void>
  decline(reason: string | null): Promise<void>
}

/** The signer's calls through one door; `base` is signerTokenBase or memberSignerBase. */
export function createSignerClient(base: string): SignerClient {
  return {
    documentUrl: `${base}/document`,
    signedCopyUrl: `${base}/document?copy=signed`,
    describe: () => send<SignerPageData>(base),
    start: () => send<StartedSigning>(`${base}/start`, { method: 'POST' }),
    poll: (signal) => send<SignerPollAnswer>(`${base}/poll`, { method: 'POST', signal }),
    cancel: async () => {
      await send<{ cancelled: true }>(`${base}/cancel`, { method: 'POST' })
    },
    decline: async (reason) => {
      await send<{ declined: true }>(`${base}/decline`, { method: 'POST', body: JSON.stringify({ reason }) })
    },
  }
}

// ---------------------------------------------------------------------------
// The sender: the session routes
// ---------------------------------------------------------------------------

export interface SigningAvailabilityView {
  /** Signing exists for the active company (the rollout and a wired provider). */
  offered: boolean
  /** It may send documents for signing (offered, and in its plan or trial). */
  available: boolean
  /** It may send a locked årsredovisning to its board. */
  arsredovisning: boolean
}

export const SIGNING_UNAVAILABLE_VIEW: SigningAvailabilityView = { offered: false, available: false, arsredovisning: false }

/** What the active company may do with BankID signing (GET /api/signing/availability). */
export async function fetchSigningAvailability(): Promise<SigningAvailabilityView> {
  const data = await send<Partial<SigningAvailabilityView>>('/api/signing/availability')
  return { offered: data.offered === true, available: data.available === true, arsredovisning: data.arsredovisning === true }
}

export interface CreateSigningRequestInput {
  documentId: string
  title: string
  message: string | null
  expiresInDays: number
  signers: Array<{
    name: string
    email: string | null
    roleLabel: string | null
    userId: string | null
    personalNumber: string | null
  }>
}

export function createSigningRequest(input: CreateSigningRequestInput): Promise<CreatedSigningRequest> {
  return send<CreatedSigningRequest>('/api/signing-requests', {
    method: 'POST',
    body: JSON.stringify({
      document_id: input.documentId,
      title: input.title,
      message: input.message,
      expires_in_days: input.expiresInDays,
      send_email: true,
      signers: input.signers.map((s) => ({
        name: s.name,
        email: s.email,
        role_label: s.roleLabel,
        user_id: s.userId,
        personal_number: s.personalNumber,
      })),
    }),
  })
}

export function listSigningRequests(
  params: { documentId?: string | null; annualReportVersionId?: string | null; status?: SigningRequestStatusFilter | null } = {},
): Promise<SigningRequestView[]> {
  const query = new URLSearchParams()
  if (params.documentId) query.set('document_id', params.documentId)
  if (params.annualReportVersionId) query.set('annual_report_version_id', params.annualReportVersionId)
  if (params.status) query.set('status', params.status)
  const qs = query.toString()
  return send<SigningRequestView[]>(`/api/signing-requests${qs ? `?${qs}` : ''}`)
}

export interface ArsredovisningSigningInput {
  signers: Array<{ signatureId: string; email: string | null; userId: string | null; personalNumber: string | null }>
  message: string | null
  expiresInDays: number
  /** False for the one-sitting signing: the signer is the person at the screen, nobody is mailed. */
  sendEmail: boolean
}

/**
 * Send a locked årsredovisning version to the board for BankID signing: one
 * signer per pending slot, each slot's name and role from the roster.
 */
export function requestArsredovisningSigning(fiscalPeriodId: string, versionId: string, input: ArsredovisningSigningInput): Promise<CreatedSigningRequest> {
  return send<CreatedSigningRequest>(
    `/api/bookkeeping/fiscal-periods/${encodeURIComponent(fiscalPeriodId)}/arsredovisning/versions/${encodeURIComponent(versionId)}/signing-request`,
    {
      method: 'POST',
      body: JSON.stringify({
        signers: input.signers.map((s) => ({ signature_id: s.signatureId, email: s.email, user_id: s.userId, personal_number: s.personalNumber })),
        message: input.message,
        expires_in_days: input.expiresInDays,
        send_email: input.sendEmail,
      }),
    },
  )
}

/**
 * One request. A completed request whose signed copy and evidence package
 * never landed is sealed again by this read, so a list that sees one asks here.
 */
export function getSigningRequest(signingRequestId: string): Promise<SigningRequestView> {
  return send<SigningRequestView>(`/api/signing-requests/${encodeURIComponent(signingRequestId)}`)
}

export function cancelSigningRequest(signingRequestId: string): Promise<{ signing_request_id: string; cancelled: true }> {
  return send(`/api/signing-requests/${encodeURIComponent(signingRequestId)}/cancel`, { method: 'POST' })
}

export function remindSigner(signingRequestId: string, signerId: string): Promise<RemindedSigner> {
  return send<RemindedSigner>(`/api/signing-requests/${encodeURIComponent(signingRequestId)}/signers/${encodeURIComponent(signerId)}/remind`, { method: 'POST' })
}

/** The members of the active company (GET /api/company/members), as the signer picker needs them. */
export interface CompanyMemberOption {
  user_id: string
  email: string
  is_current_user: boolean
}

export async function fetchCompanyMemberOptions(): Promise<CompanyMemberOption[]> {
  const data = await send<{ members?: Array<{ user_id: string; email: string; is_current_user?: boolean }> }>('/api/company/members')
  return (data.members ?? [])
    .filter((m) => m.user_id && m.email)
    .map((m) => ({ user_id: m.user_id, email: m.email, is_current_user: m.is_current_user === true }))
}
