/**
 * Billo: the Partner and Mailbox APIs (creating a company's Billo business
 * mailbox and reading it) and the Sender API with SendEasy (sending as the
 * company). Reference: Billo's API documentation. Partner and Mailbox are
 * marked Draft by Billo.
 *
 * Two credentials:
 *   - the partner API key: exchanged at POST /partner/v1/auth/token
 *     (x-api-key) for a JWT that reaches the Partner and Mailbox APIs;
 *   - the sender OAuth client: client credentials at the identity server,
 *     a token for the Sender API and SendEasy.
 *
 * Receiving: Accounted is one partner customer at Billo, and the API key is
 * bound to it (the token's partner_customer_id claim). Each company's
 * mailbox is enrolled under it as an end customer (enrollmentId); the key
 * cannot register customers of its own. Billo shows only documents that
 * arrive after the enrolment. A company holds no BankID, so the mandate is
 * NotRequired: the company's consent, given by its admin in Accounted, is
 * recorded on our side (digital_mailbox_connections).
 */
import { safeFetch } from '@/lib/http/safe-fetch'
import { formatAmountInput } from '@/lib/money'
import {
  DigitalMailboxApiError,
  DIGITAL_MAILBOX_TIMEOUT_MS,
  createTokenCache,
  isDigitalMailboxApiError,
  providerRequest,
  toBase64,
  withToken,
  type TokenCache,
} from './http'
import { swedishVatNumber } from './identifiers'
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
  ReceiveAccount,
  SenderRegistration,
} from './types'

const PROVIDER = 'billo' as const

/**
 * SendEasy lives on the partner gateway, not on the Sender API host its spec
 * names (Billo, 2026-10-22, for the sandbox; production is taken to follow
 * the same gateway).
 */
export const BILLO_HOSTS = {
  sandbox: {
    partner: 'https://sandbox-api.billo.life/partner',
    mailbox: 'https://sandbox-api.billo.life/partner/mailbox',
    sender: 'https://sandbox-sender-api.billo.life',
    sendeasy: 'https://sandbox-api.billo.life/sendeasy',
    identity: 'https://sandbox-identity.billo.life/connect/token',
  },
  production: {
    partner: 'https://api.billo.life/partner',
    mailbox: 'https://api.billo.life/partner/mailbox',
    sender: 'https://sender-api.billo.life',
    sendeasy: 'https://api.billo.life/sendeasy',
    identity: 'https://identity.billo.life/connect/token',
  },
} as const

/** Billo answers 409 with this errorCode when the company's mailbox is already enrolled (by us or another partner). */
export const BILLO_ALREADY_ENROLLED = '13'

/** The webhook events the Inkorg acts on. */
export const BILLO_WEBHOOK_EVENTS = ['PartnerDocumentReceived'] as const

/** Pages of 100 the sync reads at most per run: newest first, so new documents are on the first page. */
const MAX_DOCUMENT_PAGES = 5
const DOCUMENT_PAGE_SIZE = 100

export interface BilloConfig {
  environment: 'sandbox' | 'production'
  hosts: (typeof BILLO_HOSTS)['sandbox' | 'production']
  partnerApiKey: string | null
  sender: { clientId: string; clientSecret: string } | null
  /** The secret registered with Billo's webhook, Standard Webhooks format (whsec_...). */
  webhookSecret: string | null
}

/**
 * The deployment's Billo configuration, or null when it holds no Billo
 * credential. BILLO_ENVIRONMENT defaults to sandbox.
 *
 *   BILLO_ENVIRONMENT                     sandbox | production
 *   BILLO_PARTNER_API_KEY                 partner + mailbox (receiving)
 *   BILLO_SENDER_CLIENT_ID / _SECRET      sender API + SendEasy (sending)
 *   BILLO_WEBHOOK_SECRET                  the secret our webhook is registered with
 */
export function readBilloConfigFromEnv(env: Record<string, string | undefined> = process.env): BilloConfig | null {
  const environment = env.BILLO_ENVIRONMENT?.trim() === 'production' ? 'production' : 'sandbox'
  const partnerApiKey = env.BILLO_PARTNER_API_KEY?.trim() || null
  const clientId = env.BILLO_SENDER_CLIENT_ID?.trim()
  const clientSecret = env.BILLO_SENDER_CLIENT_SECRET?.trim()
  const sender = clientId && clientSecret ? { clientId, clientSecret } : null
  if (!partnerApiKey && !sender) return null
  return {
    environment,
    hosts: BILLO_HOSTS[environment],
    partnerApiKey,
    sender,
    webhookSecret: env.BILLO_WEBHOOK_SECRET?.trim() || null,
  }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

// ---------------------------------------------------------------------------
// Partner + Mailbox (receiving)
// ---------------------------------------------------------------------------

export interface BilloBusinessMailboxInput {
  /** Ten digits. */
  orgNumber: string
  companyName: string
  addressLine1: string
  postalCode: string
  city: string
  representative: {
    name: string
    /** Twelve digits. */
    personnummer: string
    email: string
    /** E.164. */
    phone: string
  }
}

export interface BilloEnrolment {
  partnerCustomerId: string
  enrollmentId: string
  status: string | null
  customerNumber: string | null
  billoAddress: unknown
}

interface BilloDocumentSummary {
  id?: string
  title?: string
  type?: string
  created?: string
  publishedAt?: string | null
}

interface BilloDocumentDetail extends BilloDocumentSummary {
  /** The sender's display name, on every document. */
  sender?: string | null
  invoiceData?: Record<string, unknown> | null
}

/** The partner customer a partner token is bound to (its partner_customer_id claim), or null. */
export function billoPartnerCustomerId(token: string): string | null {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { partner_customer_id?: unknown }
    const id = claims.partner_customer_id
    return typeof id === 'string' && id.trim() ? id.trim() : null
  } catch {
    return null
  }
}

function billoKind(type: string | undefined): MailboxDocumentKind {
  switch ((type ?? '').toUpperCase()) {
    case 'INVOICE':
      return 'invoice'
    case 'RECEIPT':
      return 'receipt'
    case 'LETTER':
      return 'letter'
    default:
      return 'other'
  }
}

export class BilloMailboxClient implements MailboxReceiver {
  private readonly tokens: TokenCache

  constructor(
    private readonly hosts: BilloConfig['hosts'],
    apiKey: string,
  ) {
    this.tokens = createTokenCache(async () => {
      const res = await providerRequest(PROVIDER, {
        method: 'POST',
        url: `${hosts.partner}/v1/auth/token`,
        headers: { 'x-api-key': apiKey },
        description: 'partner token',
      })
      const body = (res.json ?? {}) as { accessToken?: unknown; expiresIn?: unknown }
      if (typeof body.accessToken !== 'string' || !body.accessToken) {
        throw new DigitalMailboxApiError(PROVIDER, 'auth', 'token answer carried no accessToken')
      }
      return { token: body.accessToken, expiresInSeconds: Number(body.expiresIn) }
    })
  }

  private call(method: 'GET' | 'POST' | 'DELETE', url: string, description: string, json?: unknown) {
    return withToken(this.tokens, (token) =>
      providerRequest(PROVIDER, { method, url, headers: bearer(token), json, description }),
    )
  }

  /** Accounted's partner customer, which the API key is bound to. */
  private async partnerCustomerId(): Promise<string> {
    const id = await withToken(this.tokens, async (token) => billoPartnerCustomerId(token))
    if (!id) throw new DigitalMailboxApiError(PROVIDER, 'auth', 'the partner token names no partner customer')
    return id
  }

  /**
   * Enrol the company's own mailbox as an end customer under Accounted's
   * partner customer. Safe to repeat: an enrolment that already exists under
   * it is looked up instead.
   */
  async createBusinessMailbox(input: BilloBusinessMailboxInput): Promise<BilloEnrolment> {
    const partnerCustomerId = await this.partnerCustomerId()
    try {
      const enrolled = await this.call(
        'POST',
        `${this.hosts.mailbox}/v1/clients/${encodeURIComponent(partnerCustomerId)}/enrollments/business`,
        'enrol business mailbox',
        {
          customer: {
            orgNumber: input.orgNumber,
            companyName: input.companyName,
            addressLine1: input.addressLine1,
            postalCode: input.postalCode,
            city: input.city,
            representativeName: input.representative.name,
            representativeSsn: input.representative.personnummer,
            representativeEmail: input.representative.email,
            representativePhone: input.representative.phone,
          },
          // A company cannot sign with BankID; its consent is recorded in Accounted.
          forordnande: { signingMethod: 'NotRequired' },
        },
      )
      const e = (enrolled.json ?? {}) as Record<string, unknown>
      if (typeof e.enrollmentId !== 'string' || !e.enrollmentId) {
        throw new DigitalMailboxApiError(PROVIDER, 'unavailable', 'enrolment answered no enrollmentId')
      }
      return {
        partnerCustomerId,
        enrollmentId: e.enrollmentId,
        status: typeof e.status === 'string' ? e.status : null,
        customerNumber: typeof e.customerNumber === 'string' ? e.customerNumber : null,
        billoAddress: e.billoAddress ?? null,
      }
    } catch (err) {
      if (isDigitalMailboxApiError(err) && err.kind === 'conflict' && err.providerCode === BILLO_ALREADY_ENROLLED) {
        // Ours from an earlier attempt, or another partner's: only our own
        // enrolment list can tell, and Billo deliberately says no more.
        const existing = await this.findEnrollment(partnerCustomerId, input.orgNumber)
        if (existing) return existing
      }
      throw err
    }
  }

  private async findEnrollment(partnerCustomerId: string, orgNumber: string): Promise<BilloEnrolment | null> {
    const res = await this.call(
      'GET',
      `${this.hosts.mailbox}/v1/clients/${encodeURIComponent(partnerCustomerId)}/enrollments?page=1&pageSize=100`,
      'list enrolments',
    )
    const items = ((res.json as { items?: unknown } | null)?.items ?? []) as Array<Record<string, unknown>>
    const hit = items.find((item) => String(item.orgNumber ?? '').replace(/\D/g, '').endsWith(orgNumber))
    const enrollmentId = hit ? String(hit.enrollmentId ?? hit.id ?? '') : ''
    if (!hit || !enrollmentId) return null
    return {
      partnerCustomerId,
      enrollmentId,
      status: typeof hit.status === 'string' ? hit.status : null,
      customerNumber: typeof hit.customerNumber === 'string' ? hit.customerNumber : null,
      billoAddress: hit.billoAddress ?? null,
    }
  }

  /** End the enrolment: Billo stops delivering and the mailbox is free to enrol again. */
  async disconnect(account: ReceiveAccount): Promise<void> {
    if (!account.mailboxRef) return
    try {
      await this.call(
        'DELETE',
        `${this.hosts.mailbox}/v1/clients/${encodeURIComponent(account.accountRef)}/enrollments/${encodeURIComponent(account.mailboxRef)}`,
        'disconnect enrolment',
      )
    } catch (err) {
      // Already gone at Billo: the disconnect has happened.
      if (isDigitalMailboxApiError(err) && err.kind === 'not_found') return
      throw err
    }
  }

  /**
   * Register (or replace) the webhook on Accounted's partner customer, which
   * fires for every company enrolled under it. The partner-wide endpoint
   * refuses a key bound to a partner customer.
   */
  async registerWebhook(callbackUrl: string, secret: string): Promise<{ id: string | null }> {
    const partnerCustomerId = await this.partnerCustomerId()
    const url = `${this.hosts.mailbox}/v1/clients/${encodeURIComponent(partnerCustomerId)}/webhook`
    const res = await this.call('POST', url, 'register webhook', {
      callbackUrl,
      secret,
      eventTypes: [...BILLO_WEBHOOK_EVENTS],
    })
    const id = (res.json as { id?: unknown } | null)?.id
    return { id: typeof id === 'string' ? id : null }
  }

  private documentsUrl(account: ReceiveAccount): string {
    if (!account.mailboxRef) throw new DigitalMailboxApiError(PROVIDER, 'rejected', 'the Billo connection has no enrolment')
    return `${this.hosts.mailbox}/v1/clients/${encodeURIComponent(account.accountRef)}/enrollments/${encodeURIComponent(account.mailboxRef)}/documents`
  }

  async listDocuments(account: ReceiveAccount, since: Date | null): Promise<MailboxDocumentSummary[]> {
    const base = this.documentsUrl(account)
    const sinceMs = since ? since.getTime() : null
    const out: MailboxDocumentSummary[] = []
    for (let page = 1; page <= MAX_DOCUMENT_PAGES; page++) {
      const res = await this.call('GET', `${base}?page=${page}&pageSize=${DOCUMENT_PAGE_SIZE}`, 'document listing')
      const body = (res.json ?? {}) as { items?: BilloDocumentSummary[]; hasNextPage?: boolean }
      const items = body.items ?? []
      let reachedOlder = false
      for (const item of items) {
        if (!item.id || !item.publishedAt) continue // not yet published to the mailbox
        if (sinceMs !== null && Date.parse(item.publishedAt) < sinceMs) {
          reachedOlder = true
          continue
        }
        out.push({ ref: item.id, receivedAt: item.publishedAt })
      }
      // Newest first: a page that reaches before `since` is the last one needed.
      if (reachedOlder || !body.hasNextPage) break
    }
    return out
  }

  async getDocument(account: ReceiveAccount, ref: string): Promise<{ document: MailboxDocument; files: MailboxFile[] }> {
    const base = `${this.documentsUrl(account)}/${encodeURIComponent(ref)}`
    const detail = (await this.call('GET', base, 'document detail')).json as BilloDocumentDetail | null
    const download = (await this.call('GET', `${base}/download`, 'document download url')).json as {
      fileName?: string
      contentType?: string
      downloadUrl?: string
    } | null
    if (!download?.downloadUrl) throw new DigitalMailboxApiError(PROVIDER, 'unavailable', 'download answered no downloadUrl')

    // A signed object-storage URL from Billo's answer: fetched without our
    // token and through the public-address guard, never following redirects.
    let res: Response
    try {
      res = await safeFetch(download.downloadUrl, { method: 'GET', signal: AbortSignal.timeout(DIGITAL_MAILBOX_TIMEOUT_MS) })
    } catch (err) {
      throw new DigitalMailboxApiError(PROVIDER, 'network', `document file: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) {
      throw new DigitalMailboxApiError(PROVIDER, res.status >= 500 ? 'unavailable' : 'rejected', `document file answered ${res.status}`, res.status)
    }
    const bytes = await res.arrayBuffer()
    const invoiceData = detail?.invoiceData ?? null
    const billerName = typeof invoiceData?.billerName === 'string' ? invoiceData.billerName : null

    return {
      document: {
        ref,
        receivedAt: detail?.publishedAt ?? detail?.created ?? null,
        subject: detail?.title ?? null,
        senderName: billerName ?? (detail?.sender?.trim() || null),
        senderOrgNumber: null,
        kind: billoKind(detail?.type),
        meta: { type: detail?.type ?? null, invoice_data: invoiceData },
      },
      files: [
        {
          name: download.fileName?.trim() || `billo-${ref}.pdf`,
          contentType: (download.contentType || 'application/pdf').toLowerCase(),
          bytes,
        },
      ],
    }
  }
}

export interface BilloWebhookEvent {
  eventType: string
  documentId: string | null
  /** The enrolment (endCustomerId), when the producer sent it. */
  enrollmentId: string | null
  /** The partner customer (clientId), when the producer sent it. */
  partnerCustomerId: string | null
}

/**
 * Billo's webhook body. The event name is in X-Billo-Event-Type; the body
 * comes in two shapes, camelCase from the Mailbox service (with the
 * enrolment) and an older snake_case one with the document only.
 */
export function parseBilloWebhook(eventType: string | null, payload: string): BilloWebhookEvent {
  let body: Record<string, unknown>
  try {
    body = (JSON.parse(payload) ?? {}) as Record<string, unknown>
  } catch {
    throw new DigitalMailboxApiError(PROVIDER, 'rejected', 'webhook body is not JSON')
  }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  return {
    eventType: eventType?.trim() || 'unknown',
    documentId: str(body.documentId) ?? str(body.document_id),
    enrollmentId: str(body.endCustomerId),
    partnerCustomerId: str(body.clientId),
  }
}

// ---------------------------------------------------------------------------
// Sender API + SendEasy (sending)
// ---------------------------------------------------------------------------

function pdfFile(pdf: { name: string; bytes: Uint8Array }) {
  return { name: pdf.name, content_type: 'application/pdf', data: toBase64(pdf.bytes) }
}

/** SendEasy statuses that mean the document did not go out. */
const SENDEASY_FAILED = new Set(['Error', 'MissingFile', 'MissingDetails'])

export class BilloSenderClient implements MailboxSender {
  readonly payslipReachesNonUsers = true
  readonly payslipNeedsEmployerContact = false
  private readonly tokens: TokenCache

  constructor(
    private readonly hosts: BilloConfig['hosts'],
    client: { clientId: string; clientSecret: string },
  ) {
    this.tokens = createTokenCache(async () => {
      const res = await providerRequest(PROVIDER, {
        method: 'POST',
        url: hosts.identity,
        form: { grant_type: 'client_credentials', client_id: client.clientId, client_secret: client.clientSecret },
        description: 'sender token',
      })
      const body = (res.json ?? {}) as { access_token?: unknown; expires_in?: unknown }
      if (typeof body.access_token !== 'string' || !body.access_token) {
        throw new DigitalMailboxApiError(PROVIDER, 'auth', 'token answer carried no access_token')
      }
      return { token: body.access_token, expiresInSeconds: Number(body.expires_in) }
    })
  }

  private post(path: string, json: unknown, description: string, base: string = this.hosts.sender) {
    return withToken(this.tokens, (token) =>
      providerRequest(PROVIDER, { method: 'POST', url: `${base}${path}`, headers: bearer(token), json, description }),
    )
  }

  async registerSender(company: { orgNumber: string; name: string }): Promise<SenderRegistration> {
    const vat = swedishVatNumber(company.orgNumber)
    if (!vat) throw new DigitalMailboxApiError(PROVIDER, 'rejected', 'company organisationsnummer is not valid')
    const res = await this.post('/v1/tenant', { name: company.name, company_id: [{ name: company.name, orgnr: vat }] }, 'tenant registration')
    const tenantRef = res.headers.get('billo-objkey')?.trim()
    if (!tenantRef) throw new DigitalMailboxApiError(PROVIDER, 'unavailable', 'tenant registration answered no billo-objkey')
    // The token's scope names the tenants it may send for: ask for a new one.
    this.tokens.invalidate()
    return { status: 'active', tenantRef }
  }

  async isReachable(tenantRef: string, recipient: MailboxRecipient): Promise<boolean> {
    const key = encodeURIComponent(tenantRef)
    if (recipient.kind === 'person') {
      const res = await this.post(`/v1/tenant/${key}/usermatch`, { ssns: [recipient.personnummer] }, 'user match')
      const ssns = (res.json as { ssns?: unknown } | null)?.ssns
      return Array.isArray(ssns) && ssns.includes(recipient.personnummer)
    }
    const vat = swedishVatNumber(recipient.orgNumber)
    if (!vat) return false
    const res = await this.post(`/v1/tenant/${key}/companymatch/vatnr`, { list: [vat] }, 'company match')
    const list = (res.json as { list?: unknown } | null)?.list
    return Array.isArray(list) && list.includes(vat)
  }

  async sendInvoice(tenantRef: string, recipient: MailboxRecipient, invoice: OutgoingInvoice) {
    let target: Record<string, string>
    if (recipient.kind === 'person') {
      target = { ssn: recipient.personnummer }
    } else {
      const vat = swedishVatNumber(recipient.orgNumber)
      if (!vat) throw new DigitalMailboxApiError(PROVIDER, 'rejected', 'recipient organisationsnummer is not valid')
      target = { vat }
    }
    const payment = invoice.payment
    const body: Record<string, unknown> = {
      ...target,
      subject: invoice.subject,
      generated_at: invoice.generatedAt,
      type: payment ? 'invoice' : 'letter',
      retain: false,
      files: [pdfFile(invoice.pdf)],
    }
    if (payment) {
      body.context = {
        invoice: {
          payment: {
            payable: true,
            currency: 'SEK',
            due_date: payment.dueDate,
            total_owed: formatAmountInput(payment.amount, '.'),
            type: payment.referenceType === 'ocr' ? 'SE_OCR' : 'TENANT_REF',
            method: payment.method === 'bankgiro' ? '1' : '2',
            account: payment.account,
            reference: payment.reference.slice(0, 25),
          },
          invoice_reference: invoice.invoiceNumber,
        },
      }
    }
    const res = await this.post(`/v1/tenant/${encodeURIComponent(tenantRef)}/content`, body, 'send content')
    return { providerRef: res.headers.get('billo-objkey')?.trim() || null }
  }

  /**
   * Through SendEasy: a Billo user gets it in the mailbox, anyone else a
   * BankID or Freja protected link by email or SMS, so every employee is
   * reached. SendEasy takes the same sender token (its spec names no auth;
   * the sandbox accepts the token).
   */
  async sendPayslip(tenantRef: string, personnummer: string, payslip: OutgoingPayslip) {
    const res = await this.post(
      '/v1/Send',
      {
        documentType: 'Payslip',
        fileName: payslip.pdf.name,
        fileContent: toBase64(payslip.pdf.bytes),
        tenantKey: tenantRef,
        receiver: {
          ssn: personnummer,
          firstName: payslip.firstName,
          lastName: payslip.lastName,
          email: payslip.email,
          phoneNumber: payslip.phone,
        },
      },
      'SendEasy send',
      this.hosts.sendeasy,
    )
    const body = (res.json ?? {}) as { id?: unknown; documentId?: unknown; status?: unknown }
    if (typeof body.status === 'string' && SENDEASY_FAILED.has(body.status)) {
      throw new DigitalMailboxApiError(PROVIDER, 'rejected', `SendEasy answered status ${body.status}`, null, body.status)
    }
    const ref = body.documentId ?? body.id
    return { providerRef: typeof ref === 'string' ? ref : null }
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface BilloProvider extends DigitalMailboxProvider {
  readonly id: 'billo'
  readonly receiver: BilloMailboxClient | null
  readonly sender: BilloSenderClient | null
  readonly config: BilloConfig
}

export function createBilloProvider(config: BilloConfig): BilloProvider {
  return {
    id: 'billo',
    config,
    receiver: config.partnerApiKey ? new BilloMailboxClient(config.hosts, config.partnerApiKey) : null,
    sender: config.sender ? new BilloSenderClient(config.hosts, config.sender) : null,
  }
}
