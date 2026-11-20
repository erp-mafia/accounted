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

// ---------------------------------------------------------------------------
// Sign session
// ---------------------------------------------------------------------------

/**
 * POST /auth/bankid/sign. The signer approves userVisibleData in the BankID
 * app and the signature binds it; userNonVisibleData rides in the signature
 * unseen (TIC's advice: put the document hash there).
 */
export interface BankIdSignRequest {
  endUserIp: string
  userAgent?: string
  /** Shown in the BankID app. Max 40 000 characters. */
  userVisibleData: string
  userVisibleDataFormat?: 'simpleMarkdownV1'
  /** Signed but not shown. Max 200 000 characters. */
  userNonVisibleData?: string
  /** 12 digits; only this person can sign the order. */
  personalNumber?: string
}

/** The signature a completed sign session collects. */
export interface BankIdSignatureData {
  /** XML-DSig, base64: the signed texts, the signer's certificate and the signature. */
  value: string
  /** OCSP response, base64: the certificate was valid when the signer signed. */
  ocspResponse: string
}

export interface BankIdPollResponse {
  sessionId: string
  /**
   * `collected`: TIC has already handed the completed result out (it does so
   * at most twice per session, poll and collect combined) and will not again;
   * `user` is absent. seen 2026-09-10 (#2471), not in TIC's
   * documentation. /poll answers `failed` for it unless the flow cookie holds
   * the sealed result.
   */
  status: 'pending' | 'complete' | 'failed' | 'cancelled' | 'collected'
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
  /** A sign session's signature, when the poll that completes it carries one. */
  signature?: BankIdSignatureData
}

export interface BankIdCollectResponse {
  sessionId: string
  status: 'pending' | 'complete' | 'failed' | 'cancelled' | 'collected'
  hintCode?: string
  user?: BankIdUser
  completedAt?: string
  orderCount?: number
  maxOrders?: number
  sessionExpiresInSeconds?: number
  /** Present for a completed sign session. */
  signature?: BankIdSignatureData
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
