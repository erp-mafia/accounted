/**
 * Kivra: the Partner API (reading a company's Kivra Företag inbox) and the
 * Tenant API (sending as the company). Reference: Kivra's API documentation.
 *
 * Both APIs live on one host per environment and authenticate with OAuth 2.0
 * client credentials at POST /v1/auth (HTTP Basic). Kivra issues the Partner
 * API its own client, so the two keep separate token caches; a deployment
 * that holds only one of them gets only that direction.
 *
 * Receiving is pull: a company activates Accounted as its partner in Kivra
 * (Kivra then knows the company by its company_key), and the sync lists the
 * company's inbox and downloads each new content's file parts. Nothing is
 * marked handled at Kivra: those labels are the company's own (Kivra shows
 * them to its users), and what Accounted already filed is known from the
 * arrivals.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { formatAmountInput } from '@/lib/money'
import {
  DigitalMailboxApiError,
  createTokenCache,
  isDigitalMailboxApiError,
  providerDownload,
  providerRequest,
  toBase64,
  withToken,
  type DigitalMailboxErrorKind,
  type TokenCache,
} from './http'
import { orgNumberFromVatNumber, payslipEmployerContact, swedishVatNumber } from './identifiers'
import type {
  DigitalMailboxProvider,
  MailboxDocument,
  MailboxDocumentKind,
  MailboxDocumentSummary,
  MailboxFile,
  MailboxReceiver,
  MailboxRecipient,
  MailboxSender,
  OutgoingInvoice,
  OutgoingPayslip,
  PayslipStatement,
  ReceiveAccount,
  SenderRegistration,
} from './types'

const PROVIDER = 'kivra' as const

export const KIVRA_BASE_URLS = {
  sandbox: 'https://sender.sandbox-api.kivra.com',
  production: 'https://sender.api.kivra.com',
} as const

/** File parts the Inkorg can file. Text and HTML letters have no file to archive. */
const FILABLE_PART_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png'])

/**
 * Kivra refuses a content body over 1 MB, base64 included. Checked before
 * sending, so the person reads why instead of a bare 413.
 */
export const KIVRA_MAX_CONTENT_BYTES = 1_000_000

export interface KivraClientCredentials {
  clientId: string
  clientSecret: string
}

export interface KivraConfig {
  environment: 'sandbox' | 'production'
  baseUrl: string
  /** Partner API client (receiving). */
  partner: KivraClientCredentials | null
  /** Tenant API client (sending). */
  tenant: KivraClientCredentials | null
  /** The secret Kivra signs partner webhooks with. */
  webhookSecret: string | null
  /**
   * The onboarding link Kivra gives a partner (Kivra creates or finds the
   * company account and activates the partner on it). Kivra's partner-only
   * flow, so it lives in the deployment's settings, not in the code; without
   * it the deployment does not receive from Kivra.
   */
  onboardingUrl: string | null
}

function credentials(id: string | undefined, secret: string | undefined): KivraClientCredentials | null {
  const clientId = id?.trim()
  const clientSecret = secret?.trim()
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

/**
 * The deployment's Kivra configuration, or null when it holds no Kivra
 * client at all. KIVRA_ENVIRONMENT defaults to sandbox, so a stray client id
 * never reaches production by omission.
 *
 *   KIVRA_ENVIRONMENT            sandbox | production
 *   KIVRA_CLIENT_ID / _SECRET    Tenant API client (sending)
 *   KIVRA_PARTNER_CLIENT_ID / _SECRET   Partner API client (receiving)
 *   KIVRA_ONBOARDING_URL         the partner onboarding link Kivra gives us (receiving)
 *   KIVRA_WEBHOOK_SECRET         partner webhook signing secret
 */
export function readKivraConfigFromEnv(env: Record<string, string | undefined> = process.env): KivraConfig | null {
  const environment = env.KIVRA_ENVIRONMENT?.trim() === 'production' ? 'production' : 'sandbox'
  const tenant = credentials(env.KIVRA_CLIENT_ID, env.KIVRA_CLIENT_SECRET)
  const partner = credentials(env.KIVRA_PARTNER_CLIENT_ID, env.KIVRA_PARTNER_CLIENT_SECRET)
  if (!tenant && !partner) return null
  const onboarding = env.KIVRA_ONBOARDING_URL?.trim()
  return {
    environment,
    baseUrl: KIVRA_BASE_URLS[environment],
    partner,
    tenant,
    webhookSecret: env.KIVRA_WEBHOOK_SECRET?.trim() || null,
    onboardingUrl: onboarding && /^https:\/\//i.test(onboarding) ? onboarding : null,
  }
}

function tokenCacheFor(baseUrl: string, client: KivraClientCredentials): TokenCache {
  return createTokenCache(async () => {
    const basic = Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')
    const res = await providerRequest(PROVIDER, {
      method: 'POST',
      url: `${baseUrl}/v1/auth`,
      headers: { authorization: `Basic ${basic}` },
      form: { grant_type: 'client_credentials' },
      description: 'token',
    })
    const body = (res.json ?? {}) as { access_token?: unknown; expires_in?: unknown }
    if (typeof body.access_token !== 'string' || !body.access_token) {
      throw new DigitalMailboxApiError(PROVIDER, 'auth', 'token answer carried no access_token')
    }
    return { token: body.access_token, expiresInSeconds: Number(body.expires_in) }
  })
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

/**
 * The providerCode on the conflict registerSender throws when the company is
 * a sender through another service and Kivra would not take the access
 * request: trying again does not help, so it is not reported as a failure to
 * retry.
 */
export const KIVRA_SENDER_ELSEWHERE = 'sender_elsewhere'

/** Refusals that say nothing about the request itself: the provider was down, slow or busy. */
const TRANSIENT_KINDS: ReadonlySet<DigitalMailboxErrorKind> = new Set(['network', 'unavailable', 'rate_limited'])

// ---------------------------------------------------------------------------
// Partner API (receiving)
// ---------------------------------------------------------------------------

interface KivraPart {
  content_type?: string
  name?: string
  sha256?: string | null
  size?: number
}

interface KivraContentMetadata {
  key?: string
  type?: string
  origin?: string
  subject?: string
  created_at?: string
  received_at?: string
  transaction_at?: string | null
  sender_name?: string | null
  sender_vat_numbers?: string[] | null
  labels?: Record<string, boolean>
  parts?: KivraPart[]
  payment_options?: unknown
  references?: unknown
  accounting?: unknown
}

function documentKind(type: string | undefined): MailboxDocumentKind {
  return type === 'invoice' ? 'invoice' : 'other'
}

export class KivraPartnerClient implements MailboxReceiver {
  private readonly tokens: TokenCache

  constructor(
    private readonly baseUrl: string,
    client: KivraClientCredentials,
  ) {
    this.tokens = tokenCacheFor(baseUrl, client)
  }

  /** The company_key of a company that has activated Accounted, found by its organisationsnummer. */
  async findCompanyKey(orgNumber: string): Promise<string | null> {
    const vat = swedishVatNumber(orgNumber)
    if (!vat) return null
    const res = await withToken(this.tokens, (token) =>
      providerRequest(PROVIDER, {
        method: 'GET',
        url: `${this.baseUrl}/v3/partner/company?vat_number=${encodeURIComponent(vat)}`,
        headers: bearer(token),
        description: 'company lookup',
      }),
    )
    const companies = Array.isArray(res.json) ? (res.json as Array<{ key?: unknown; vat_number?: unknown }>) : []
    const hit = companies.find((c) => typeof c.key === 'string' && (c.vat_number === undefined || c.vat_number === vat))
    return (hit?.key as string | undefined) ?? null
  }

  async listDocuments(account: ReceiveAccount, since: Date | null): Promise<MailboxDocumentSummary[]> {
    const res = await withToken(this.tokens, (token) =>
      providerRequest(PROVIDER, {
        method: 'GET',
        url: `${this.baseUrl}/v3/partner/company/${encodeURIComponent(account.accountRef)}/content`,
        headers: bearer(token),
        description: 'inbox listing',
      }),
    )
    const items = Array.isArray(res.json) ? (res.json as KivraContentMetadata[]) : []
    const sinceMs = since ? since.getTime() : null
    return items
      .filter((item) => typeof item.key === 'string' && item.key.length > 0)
      // What the company threw away in Kivra is not underlag it wants filed.
      .filter((item) => item.labels?.trashed !== true)
      .map((item) => ({ ref: item.key as string, receivedAt: item.received_at ?? item.created_at ?? null }))
      .filter((item) => sinceMs === null || item.receivedAt === null || Date.parse(item.receivedAt) >= sinceMs)
  }

  async getDocument(account: ReceiveAccount, ref: string): Promise<{ document: MailboxDocument; files: MailboxFile[] }> {
    const base = `${this.baseUrl}/v3/partner/company/${encodeURIComponent(account.accountRef)}/content/${encodeURIComponent(ref)}`
    const res = await withToken(this.tokens, (token) =>
      providerRequest(PROVIDER, { method: 'GET', url: base, headers: bearer(token), description: 'content metadata' }),
    )
    const meta = (res.json ?? {}) as KivraContentMetadata
    const senderVat = (meta.sender_vat_numbers ?? []).find((v) => orgNumberFromVatNumber(v) !== null) ?? null

    const files: MailboxFile[] = []
    const parts = meta.parts ?? []
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!
      const contentType = (part.content_type ?? '').toLowerCase()
      if (!FILABLE_PART_TYPES.has(contentType)) continue
      const download = await withToken(this.tokens, (token) =>
        providerDownload(PROVIDER, `${base}?part=${index + 1}`, bearer(token), `content part ${index + 1}`),
      )
      if (part.sha256) {
        const actual = createHash('sha256').update(new Uint8Array(download.bytes)).digest('hex')
        if (actual !== part.sha256.toLowerCase()) {
          throw new DigitalMailboxApiError(PROVIDER, 'rejected', `content part ${index + 1} failed its sha256 check`)
        }
      }
      files.push({
        name: part.name?.trim() || `kivra-${ref}-${index + 1}.${contentType === 'application/pdf' ? 'pdf' : contentType.split('/')[1]}`,
        contentType,
        bytes: download.bytes,
      })
    }

    return {
      document: {
        ref,
        receivedAt: meta.received_at ?? meta.created_at ?? null,
        subject: meta.subject ?? null,
        senderName: meta.sender_name ?? null,
        senderOrgNumber: orgNumberFromVatNumber(senderVat),
        kind: documentKind(meta.type),
        meta: {
          type: meta.type ?? null,
          origin: meta.origin ?? null,
          transaction_at: meta.transaction_at ?? null,
          sender_vat_numbers: meta.sender_vat_numbers ?? null,
          reminder: meta.labels?.reminder ?? null,
          governmental: meta.labels?.governmental ?? null,
          payment_options: meta.payment_options ?? null,
          references: meta.references ?? null,
          accounting: meta.accounting ?? null,
          parts: parts.map((p) => ({ name: p.name ?? null, content_type: p.content_type ?? null, size: p.size ?? null })),
        },
      },
      files,
    }
  }
}

// ---------------------------------------------------------------------------
// Tenant API (sending)
// ---------------------------------------------------------------------------

function recipientField(recipient: MailboxRecipient): Record<string, string> {
  if (recipient.kind === 'person') return { ssn: recipient.personnummer }
  const vat = swedishVatNumber(recipient.orgNumber)
  if (!vat) throw new DigitalMailboxApiError(PROVIDER, 'rejected', 'recipient organisationsnummer is not valid')
  return { vat_number: vat }
}

function pdfPart(pdf: { name: string; bytes: Uint8Array }) {
  return { name: pdf.name, content_type: 'application/pdf', data: toBase64(pdf.bytes) }
}

const sek = (amount: number) => ({ monetary_amount: formatAmountInput(amount, '.'), currency: 'SEK' })

/** Kivra's country field is a name (its example: "Sweden"); company_settings holds ISO codes. */
function countryName(code: string | null): string {
  const iso = code?.trim().toUpperCase() || 'SE'
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(iso) ?? iso
  } catch {
    return code?.trim() || 'Sweden'
  }
}

/**
 * The `salaryslip` object a Kivra payslip requires (schema
 * se.kivra.com/schemas/json/salaryslip/v1.0): the employer with its contact
 * details, the pay period and its gross, tax and net, and the year to date.
 * Every object in the schema refuses unknown fields, so nothing else goes in.
 */
export function kivraSalaryslip(statement: PayslipStatement, createdAt: Date): Record<string, unknown> {
  const { employer } = statement
  const vat = swedishVatNumber(employer.orgNumber)
  const ten = orgNumberFromVatNumber(vat)
  if (!vat || !ten) throw new DigitalMailboxApiError(PROVIDER, 'rejected', 'employer organisationsnummer is not valid')
  const contact = payslipEmployerContact(employer)
  if (!contact) {
    throw new DigitalMailboxApiError(PROVIDER, 'rejected', 'the employer address, email or phone is missing', null, 'employer_contact_missing')
  }
  return {
    document_metadata: {
      creation_timestamp: createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      source_system: 'Accounted',
    },
    employment: {
      employer: {
        legal_name: employer.name,
        legal_identifiers: { vat_number: vat, org_number: `${ten.slice(0, 6)}-${ten.slice(6)}` },
        contact_information: {
          address: {
            street_address: contact.streetAddress,
            postal_code: contact.postalCode,
            city: contact.city,
            country: countryName(employer.country),
          },
          email_address: contact.email,
          telephone_number: contact.phone,
        },
      },
    },
    yearly_accumulated_gross_pay: sek(statement.yearToDateGrossPay),
    yearly_accumulated_taxes: sek(statement.yearToDateTax),
    pay_period: {
      start_date: statement.periodStart,
      end_date: statement.periodEnd,
      payout_date: statement.payoutDate,
      gross_pay: sek(statement.grossPay),
      tax_deducted: sek(statement.taxDeducted),
      net_pay: sek(statement.netPay),
    },
  }
}

export class KivraTenantClient implements MailboxSender {
  readonly payslipReachesNonUsers = false
  readonly payslipNeedsEmployerContact = true
  private readonly tokens: TokenCache

  constructor(
    private readonly baseUrl: string,
    client: KivraClientCredentials,
  ) {
    this.tokens = tokenCacheFor(baseUrl, client)
  }

  /**
   * Kivra answers 409 when the organisationsnummer is already a tenant
   * outside this client's scope (the company sends through another service).
   * Retrying never changes that: access to the existing tenant is asked for
   * instead (request_access), Kivra approves or rejects it, and
   * checkSenderRequest follows it up.
   */
  async registerSender(company: { orgNumber: string; name: string }): Promise<SenderRegistration> {
    const vat = swedishVatNumber(company.orgNumber)
    if (!vat) throw new DigitalMailboxApiError(PROVIDER, 'rejected', 'company organisationsnummer is not valid')
    let res
    try {
      res = await withToken(this.tokens, (token) =>
        providerRequest(PROVIDER, {
          method: 'POST',
          url: `${this.baseUrl}/v2/tenant`,
          headers: bearer(token),
          json: { name: company.name, company_id: [{ name: company.name, orgnr: vat }] },
          description: 'tenant registration',
        }),
      )
    } catch (err) {
      if (isDigitalMailboxApiError(err) && err.kind === 'conflict') return this.requestAccess(vat)
      throw err
    }
    const tenantRef = res.headers.get('kivra-objkey')?.trim()
    if (!tenantRef) throw new DigitalMailboxApiError(PROVIDER, 'unavailable', 'tenant registration answered no kivra-objkey')
    // The new tenant joins the client's scope only in a token issued after it.
    this.tokens.invalidate()
    return { status: 'active', tenantRef }
  }

  /** Ask Kivra for access to the tenant that already holds the organisationsnummer. */
  private async requestAccess(vat: string): Promise<SenderRegistration> {
    let res
    try {
      res = await withToken(this.tokens, (token) =>
        providerRequest(PROVIDER, {
          method: 'POST',
          url: `${this.baseUrl}/v2/tenant/request_access`,
          headers: bearer(token),
          json: { vat_number: vat },
          description: 'tenant access request',
        }),
      )
    } catch (err) {
      // A provider that is down or slow is worth trying again; any other refusal leaves the conflict standing.
      if (isDigitalMailboxApiError(err) && !TRANSIENT_KINDS.has(err.kind)) {
        throw new DigitalMailboxApiError(PROVIDER, 'conflict', err.message, err.status, KIVRA_SENDER_ELSEWHERE)
      }
      throw err
    }
    const requestRef = res.headers.get('kivra-objkey')?.trim()
    if (!requestRef) throw new DigitalMailboxApiError(PROVIDER, 'unavailable', 'tenant access request answered no kivra-objkey')
    // The request's own status scope comes with a token issued after it.
    this.tokens.invalidate()
    return this.accessRequestOutcome(res.json, requestRef)
  }

  async checkSenderRequest(requestRef: string): Promise<SenderRegistration> {
    const res = await withToken(this.tokens, (token) =>
      providerRequest(PROVIDER, {
        method: 'GET',
        url: `${this.baseUrl}/v2/tenant/request_access/${encodeURIComponent(requestRef)}`,
        headers: bearer(token),
        description: 'tenant access request status',
      }),
    )
    return this.accessRequestOutcome(res.json, requestRef)
  }

  /** Kivra's request object: accepted carries the tenant to send as, which joins the scope only in a new token. */
  private accessRequestOutcome(body: unknown, requestRef: string): SenderRegistration {
    const request = (body ?? {}) as { status?: unknown; tenant_key?: unknown }
    const status = typeof request.status === 'string' ? request.status.trim().toLowerCase() : ''
    const tenantKey = typeof request.tenant_key === 'string' ? request.tenant_key.trim() : ''
    if (status === 'accepted' && tenantKey) {
      this.tokens.invalidate()
      return { status: 'active', tenantRef: tenantKey }
    }
    if (status === 'rejected') return { status: 'rejected', requestRef }
    return { status: 'pending', requestRef }
  }

  async isReachable(tenantRef: string, recipient: MailboxRecipient): Promise<boolean> {
    const isPerson = recipient.kind === 'person'
    const value = isPerson ? recipient.personnummer : swedishVatNumber(recipient.orgNumber)
    if (!value) return false
    const res = await withToken(this.tokens, (token) =>
      providerRequest(PROVIDER, {
        method: 'POST',
        url: `${this.baseUrl}/v2/tenant/${encodeURIComponent(tenantRef)}/${isPerson ? 'usermatch/ssn' : 'companymatch/vatnr'}`,
        headers: bearer(token),
        json: { list: [value] },
        description: isPerson ? 'user match' : 'company match',
      }),
    )
    const list = (res.json as { list?: unknown } | null)?.list
    return Array.isArray(list) && list.includes(value)
  }

  async sendInvoice(tenantRef: string, recipient: MailboxRecipient, invoice: OutgoingInvoice) {
    const payment = invoice.payment
    const body: Record<string, unknown> = {
      ...recipientField(recipient),
      subject: invoice.subject,
      generated_at: invoice.generatedAt,
      // An invoice needs a payment block; one with no Swedish giro to pay
      // to goes as a letter, the PDF itself carrying how to pay.
      type: payment ? 'invoice' : 'letter',
      parts: [pdfPart(invoice.pdf)],
    }
    if (payment) {
      body.payment_multiple_options = {
        // Payable in Kivra for a person; a company pays from its own bank
        // (Kivra's own example for a company recipient is not payable).
        payable: recipient.kind === 'person',
        currency: 'SEK',
        method: payment.method === 'bankgiro' ? '1' : '2',
        account: payment.account,
        options: [
          {
            due_date: payment.dueDate,
            amount: formatAmountInput(payment.amount, '.'),
            type: payment.referenceType === 'ocr' ? 'SE_OCR' : 'TENANT_REF',
            reference: payment.reference.slice(0, 25),
          },
        ],
      }
    }
    return this.postContent(tenantRef, body)
  }

  async sendPayslip(tenantRef: string, personnummer: string, payslip: OutgoingPayslip) {
    return this.postContent(tenantRef, {
      ssn: personnummer,
      subject: payslip.subject,
      generated_at: payslip.generatedAt,
      // letter.salary is deprecated since 2026-10-01; salaryslip carries the
      // figures as data, and the PDF stays the payslip itself.
      type: 'salaryslip',
      salaryslip: kivraSalaryslip(payslip.statement, new Date()),
      parts: [pdfPart(payslip.pdf)],
    })
  }

  private async postContent(tenantRef: string, body: Record<string, unknown>) {
    const size = Buffer.byteLength(JSON.stringify(body))
    if (size > KIVRA_MAX_CONTENT_BYTES) {
      throw new DigitalMailboxApiError(PROVIDER, 'rejected', `content is ${size} bytes, Kivra takes at most ${KIVRA_MAX_CONTENT_BYTES}`, 413, 'too_large')
    }
    const res = await withToken(this.tokens, (token) =>
      providerRequest(PROVIDER, {
        method: 'POST',
        url: `${this.baseUrl}/v2/tenant/${encodeURIComponent(tenantRef)}/content`,
        headers: bearer(token),
        json: body,
        description: 'send content',
      }),
    )
    return { providerRef: res.headers.get('kivra-objkey')?.trim() || null }
  }
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** How old a partner webhook delivery may be before it is refused as a replay. */
const KIVRA_WEBHOOK_TOLERANCE_SECONDS = 300

/**
 * Verify a partner webhook: X-KIVRA-TIMESTAMP and one or more
 * X-KIVRA-SIGNATURE: v1=<hex HMAC-SHA256 of "<timestamp>:<raw body>">
 * (several during a secret rotation; any match is enough). Never throws.
 */
export function verifyKivraWebhookSignature(input: {
  secret: string
  payload: string
  timestamp: string | null
  /** Every X-KIVRA-SIGNATURE value; a joined header ("v1=a, v1=b") is split too. */
  signatures: string[]
  nowMs?: number
}): boolean {
  const { secret, payload, timestamp } = input
  if (!secret || !timestamp || input.signatures.length === 0) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  if (Math.abs((input.nowMs ?? Date.now()) / 1000 - ts) > KIVRA_WEBHOOK_TOLERANCE_SECONDS) return false

  const expected = createHmac('sha256', secret).update(`${timestamp}:${payload}`).digest()
  const candidates = input.signatures.flatMap((header) => header.split(/[,\s]+/))
  for (const candidate of candidates) {
    const match = /^v1=([0-9a-f]+)$/i.exec(candidate.trim())
    if (!match) continue
    const given = Buffer.from(match[1]!, 'hex')
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true
  }
  return false
}

export interface KivraWebhookEvent {
  id: string
  type: 'integration.created' | 'integration.deleted' | 'content.created'
  companyKey: string
  vatNumber: string | null
  contentKey: string | null
}

/** The partner webhook body, or null for an event type this integration does not act on. */
export function parseKivraWebhook(payload: string): KivraWebhookEvent | null {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new DigitalMailboxApiError(PROVIDER, 'rejected', 'webhook body is not JSON')
  }
  const b = (body ?? {}) as { id?: unknown; event_type?: unknown; data?: Record<string, unknown> }
  const type = b.event_type
  if (type !== 'integration.created' && type !== 'integration.deleted' && type !== 'content.created') return null
  const companyKey = b.data?.company_key
  if (typeof b.id !== 'string' || typeof companyKey !== 'string' || !companyKey) {
    throw new DigitalMailboxApiError(PROVIDER, 'rejected', 'webhook body lacks id or company_key')
  }
  return {
    id: b.id,
    type,
    companyKey,
    vatNumber: typeof b.data?.vat_number === 'string' ? b.data.vat_number : null,
    contentKey: typeof b.data?.content_key === 'string' ? b.data.content_key : null,
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface KivraProvider extends DigitalMailboxProvider {
  readonly id: 'kivra'
  readonly receiver: KivraPartnerClient | null
  readonly sender: KivraTenantClient | null
  readonly config: KivraConfig
}

export function createKivraProvider(config: KivraConfig): KivraProvider {
  return {
    id: 'kivra',
    config,
    // Receiving needs the onboarding link as well as the client: without it
    // no company could be brought to activate Accounted.
    receiver: config.partner && config.onboardingUrl ? new KivraPartnerClient(config.baseUrl, config.partner) : null,
    sender: config.tenant ? new KivraTenantClient(config.baseUrl, config.tenant) : null,
  }
}
