/**
 * Shapes and limits of BankID document signing (migration
 * 20261025200000_signing_requests.sql). A signing request is one archived PDF,
 * frozen by its SHA-256, and the people who should sign it; every write is the
 * server's, as the service role.
 */

export const SIGNING_DEFAULT_TTL_DAYS = 14
export const SIGNING_MAX_TTL_DAYS = 90
/** A document sent for signing has at most this many signers. */
export const SIGNING_MAX_SIGNERS = 5
/** An årsredovisning is signed by the board, the VD and the auditor: its signer slots have their own cap. */
export const SIGNING_MAX_ANNUAL_REPORT_SIGNERS = 20
export const SIGNING_TITLE_MAX = 200
export const SIGNING_MESSAGE_MAX = 1000
export const SIGNING_NAME_MAX = 200
export const SIGNING_ROLE_MAX = 100
export const SIGNING_DECLINE_REASON_MAX = 500
/** The largest PDF that can be sent for signing (the signer's page loads it whole). */
export const SIGNING_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
/** A signer is reminded at most this often. */
export const SIGNING_REMIND_INTERVAL_MS = 24 * 60 * 60 * 1000

export type SigningRequestStatus = 'open' | 'completed' | 'declined' | 'cancelled'
/** What a reader sees: an open request past its expiry reads as expired. */
export type SigningRequestState = SigningRequestStatus | 'expired'
export type SignerStatus = 'pending' | 'signed' | 'declined'
export type SignerLockKind = 'none' | 'member' | 'personnummer'
export type SigningCreatedVia = 'app' | 'api' | 'mcp'

export interface SigningRequestRow {
  id: string
  company_id: string
  created_by: string
  created_via: SigningCreatedVia
  document_id: string
  document_sha256: string
  title: string
  message: string | null
  annual_report_version_id: string | null
  status: SigningRequestStatus
  expires_at: string
  completed_at: string | null
  declined_at: string | null
  cancelled_at: string | null
  signed_document_id: string | null
  evidence_document_id: string | null
  created_at: string
}


/**
 * A signer as the server reads it; never token_hash (the session has no grant
 * for it either). Reads name their columns as literal select strings, so the
 * phantom-column guard (tests/schema/no-phantom-columns.test.ts) checks them.
 */
export interface SigningSignerRow {
  id: string
  company_id: string
  signing_request_id: string
  position: number
  name: string
  email: string | null
  role_label: string | null
  user_id: string | null
  lock_kind: SignerLockKind
  annual_report_signature_id: string | null
  link_sent_at: string | null
  last_reminded_at: string | null
  status: SignerStatus
  bankid_session_id: string | null
  bankid_session_started_at: string | null
  signed_at: string | null
  bankid_given_name: string | null
  bankid_surname: string | null
  declined_at: string | null
  decline_reason: string | null
  last_error_code: string | null
  created_at: string
}


/** The request's state as a reader sees it at `now`. */
export function requestState(request: Pick<SigningRequestRow, 'status' | 'expires_at'>, now: number = Date.now()): SigningRequestState {
  if (request.status === 'open' && new Date(request.expires_at).getTime() <= now) return 'expired'
  return request.status
}
