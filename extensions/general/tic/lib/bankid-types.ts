/**
 * TIC Identity API types for BankID authentication.
 * API reference: https://id.tic.io/api/v1
 */

// ---------------------------------------------------------------------------
// Auth session
// ---------------------------------------------------------------------------

export interface BankIdStartRequest {
  endUserIp: string
  userAgent?: string
  personalNumber?: string
  callbackUrl?: string
  webhookUrl?: string
  state?: string
}

export interface BankIdStartResponse {
  sessionId: string
  provider: string
  orderRef: string
  autoStartToken: string
  qrStartToken: string
  qrStartSecret: string
  subscriptionToken: string
  sessionExpiresAt: string
  endUserIp: string
}

export interface BankIdUser {
  personalNumber: string
  givenName: string
  surname: string
  name: string
}

export interface BankIdPollResponse {
  sessionId: string
  status: 'pending' | 'complete' | 'failed' | 'cancelled'
  hintCode?: string
  message?: string
  messageEn?: string
  orderCount?: number
  maxOrders?: number
  sessionExpiresInSeconds?: number
  /** Present when status is 'complete' */
  user?: BankIdUser
  completedAt?: string
  /** Updated tokens on order regeneration (~25s) */
  qrStartToken?: string
  qrStartSecret?: string
  /** Present when status is 'failed' */
  error?: string
}

export interface BankIdCollectResponse {
  sessionId: string
  status: 'pending' | 'complete' | 'failed' | 'cancelled'
  hintCode?: string
  user?: BankIdUser
  completedAt?: string
  orderCount?: number
  maxOrders?: number
  sessionExpiresInSeconds?: number
}

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

export type EnrichmentType =
  | 'SPAR'
  | 'CompanyRoles'
  | 'PropertyOwnership'
  | 'Income'
  | 'IpIntelligence'
  | 'Full'

export interface EnrichmentRequest {
  sessionId: string
  types: EnrichmentType[]
  webhookUrl?: string
  state?: string
}

export interface EnrichmentResponse {
  enrichmentId: string
  sessionId: string
  status: 'Pending' | 'Processing' | 'Completed' | 'PartiallyCompleted' | 'Failed'
  requestedTypes: EnrichmentType[]
  completedTypes: EnrichmentType[]
  secureUrl: string
  secureUrlExpiresAtUtc: string
}

export interface SparData {
  Person_IdNummer: string
  Person_PersonIdTyp: string
  Skydd_Sekretessmarkering: boolean
  Skydd_SkyddadFolkbokforing: boolean
  Namn_Fornamn: string
  Namn_Mellannamn?: string
  Namn_Efternamn: string
  Namn_Tilltalsnamn?: string
  PersonDetaljer_Kon: string
  PersonDetaljer_Fodelsedatum: string
  Folkbokforing_FolkbokfordLanKod?: string
  Folkbokforing_FolkbokfordKommunKod?: string
  Folkbokforingsadress_SvenskAdress_CareOf?: string
  Folkbokforingsadress_SvenskAdress_Utdelningsadress1?: string
  Folkbokforingsadress_SvenskAdress_Utdelningsadress2?: string
  Folkbokforingsadress_SvenskAdress_PostNr?: string
  Folkbokforingsadress_SvenskAdress_Postort?: string
}

export interface CompanyRole {
  companyId: number
  companyRegistrationNumber: string
  legalName: string
  legalEntityType: string
  positionTypes: string[]
  positionDescriptions: string[]
  positionStart: string
  positionEnd: string | null
  companyStatus: string
  signatureDescription?: string
}

export interface EnrichmentData {
  personalNumber: string
  name: string
  enrichedAtUtc: string
  spar?: SparData
  companyRoles?: CompanyRole[]
}

// ---------------------------------------------------------------------------
// Complete endpoint request/response (Accounted internal)
// ---------------------------------------------------------------------------

export interface BankIdCompleteRequest {
  sessionId: string
  mode: 'login' | 'signup'
  email?: string
}

export interface BankIdCompleteResponse {
  tokenHash: string
  type: string
  isNewUser: boolean
  enrichmentData?: EnrichmentData
}

export interface BankIdCompleteErrorResponse {
  error: 'no_account' | 'already_linked' | 'account_exists' | 'session_invalid' | 'session_expired'
  givenName?: string
  surname?: string
}
