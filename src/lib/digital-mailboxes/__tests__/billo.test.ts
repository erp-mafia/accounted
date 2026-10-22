import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const safeFetchMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/http/safe-fetch', () => ({ safeFetch: safeFetchMock }))

import {
  BILLO_HOSTS,
  BilloMailboxClient,
  BilloSenderClient,
  billoPartnerCustomerId,
  parseBilloWebhook,
  readBilloConfigFromEnv,
} from '../billo'

// Synthetic test data only: Kivra's sandbox test company number, a
// personnummer from Skatteverket's published test list, and a phone number
// from PTS's range for fiction.
const ORG = '4420059208'
const VAT = 'SE442005920801'
const PNR = '195001182046'
const PHONE = '+46701740605'

const HOSTS = BILLO_HOSTS.sandbox
type Call = { url: string; init: RequestInit }
let calls: Call[]
let responder: (url: string, init: RequestInit) => Response
let partnerToken: string

function json(body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })
}

/** A JWT-shaped partner token carrying the given claims (the signature is not read). */
function jwt(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${part({ alg: 'RS256' })}.${part(claims)}.sig`
}

beforeEach(() => {
  calls = []
  safeFetchMock.mockReset()
  partnerToken = jwt({ partner_customer_id: 'pc-accounted', scope: ['mailbox.all', 'partner.all'] })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.endsWith('/v1/auth/token')) return json({ accessToken: partnerToken, expiresIn: 900, refreshToken: 'r' })
    if (url === HOSTS.identity) return json({ access_token: 'oauth', expires_in: 28800 })
    return responder(url, init)
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const bodyOf = (call: Call) => JSON.parse(String(call.init.body))
const apiCalls = () => calls.filter((c) => !c.url.endsWith('/v1/auth/token') && c.url !== HOSTS.identity)

describe('readBilloConfigFromEnv', () => {
  it('is null without credentials and sandbox by default', () => {
    expect(readBilloConfigFromEnv({})).toBeNull()
    const config = readBilloConfigFromEnv({ BILLO_PARTNER_API_KEY: 'k' })
    expect(config?.environment).toBe('sandbox')
    expect(config?.hosts.partner).toBe('https://sandbox-api.billo.life/partner')
    expect(config?.hosts.sendeasy).toBe('https://sandbox-api.billo.life/sendeasy')
    expect(config?.sender).toBeNull()
  })

  it('reads the sender client and production hosts', () => {
    const config = readBilloConfigFromEnv({ BILLO_ENVIRONMENT: 'production', BILLO_SENDER_CLIENT_ID: 'c', BILLO_SENDER_CLIENT_SECRET: 's' })
    expect(config?.hosts.sender).toBe('https://sender-api.billo.life')
    expect(config?.hosts.sendeasy).toBe('https://api.billo.life/sendeasy')
    expect(config?.partnerApiKey).toBeNull()
  })
})

describe('billoPartnerCustomerId', () => {
  it('reads the partner customer a token is bound to, or null', () => {
    expect(billoPartnerCustomerId(jwt({ partner_customer_id: 'pc-accounted' }))).toBe('pc-accounted')
    expect(billoPartnerCustomerId(jwt({ sub: 'x' }))).toBeNull()
    expect(billoPartnerCustomerId('not-a-jwt')).toBeNull()
  })
})

const mailboxInput = {
  orgNumber: ORG,
  companyName: 'Testbolaget AB',
  addressLine1: 'Testgatan 1',
  postalCode: '11122',
  city: 'Stockholm',
  representative: { name: 'Test Testsson', personnummer: PNR, email: 'test@example.test', phone: PHONE },
}

describe('BilloMailboxClient', () => {
  it('enrols the company as an end customer under the partner customer its key is bound to, with no mandate', async () => {
    responder = () => json({ enrollmentId: 'en-1', status: 'Active', customerNumber: '123', billoAddress: { line2: 'BILLO' } })
    const client = new BilloMailboxClient(HOSTS, 'api-key')
    const result = await client.createBusinessMailbox(mailboxInput)
    expect(result).toEqual({ partnerCustomerId: 'pc-accounted', enrollmentId: 'en-1', status: 'Active', customerNumber: '123', billoAddress: { line2: 'BILLO' } })
    expect(calls[0]!.init.headers).toMatchObject({ 'x-api-key': 'api-key' })
    // No customer registration: the key may not create clients of its own.
    const [enrol, ...rest] = apiCalls()
    expect(rest).toEqual([])
    expect(enrol!.url).toBe(`${HOSTS.mailbox}/v1/clients/pc-accounted/enrollments/business`)
    expect(enrol!.init.headers).toMatchObject({ authorization: `Bearer ${partnerToken}` })
    expect(bodyOf(enrol!)).toMatchObject({
      customer: { orgNumber: ORG, companyName: 'Testbolaget AB', representativeSsn: PNR, representativePhone: PHONE },
      forordnande: { signingMethod: 'NotRequired' },
    })
  })

  it('refuses a key whose token names no partner customer, before enrolling anything', async () => {
    partnerToken = jwt({ sub: 'someone' })
    responder = () => json({})
    const client = new BilloMailboxClient(HOSTS, 'api-key')
    await expect(client.createBusinessMailbox(mailboxInput)).rejects.toMatchObject({ kind: 'auth' })
    expect(apiCalls()).toEqual([])
  })

  it('takes over its own earlier enrolment when Billo answers 409 errorCode 13', async () => {
    responder = (url) => {
      if (url.endsWith('/enrollments/business')) return json({ title: 'End customer is already onboarded', errorCode: 13 }, { status: 409 })
      return json({ items: [{ enrollmentId: 'en-9', orgNumber: '442005-9208', status: 'Active' }] })
    }
    const client = new BilloMailboxClient(HOSTS, 'api-key')
    await expect(client.createBusinessMailbox(mailboxInput)).resolves.toMatchObject({ partnerCustomerId: 'pc-accounted', enrollmentId: 'en-9' })
    expect(apiCalls()[1]!.url).toBe(`${HOSTS.mailbox}/v1/clients/pc-accounted/enrollments?page=1&pageSize=100`)
  })

  it('rethrows a 409 that is another partner\'s enrolment', async () => {
    responder = (url) => {
      if (url.endsWith('/enrollments/business')) return json({ errorCode: 13 }, { status: 409 })
      return json({ items: [] })
    }
    const client = new BilloMailboxClient(HOSTS, 'api-key')
    await expect(client.createBusinessMailbox(mailboxInput)).rejects.toMatchObject({ kind: 'conflict', providerCode: '13' })
  })

  it('registers the webhook on the partner customer, not partner-wide', async () => {
    responder = () => json({ id: 'wh-1' })
    const client = new BilloMailboxClient(HOSTS, 'api-key')
    await expect(client.registerWebhook('https://app.example/api/webhooks/billo', 'whsec_x')).resolves.toEqual({ id: 'wh-1' })
    const [register] = apiCalls()
    expect(register!.url).toBe(`${HOSTS.mailbox}/v1/clients/pc-accounted/webhook`)
    expect(bodyOf(register!)).toEqual({ callbackUrl: 'https://app.example/api/webhooks/billo', secret: 'whsec_x', eventTypes: ['PartnerDocumentReceived'] })
  })

  it('lists published documents newest first and stops at the first page reaching before since', async () => {
    responder = (url) => {
      if (url.includes('page=1')) {
        return json({
          items: [
            { id: 'd3', publishedAt: '2026-10-10T00:00:00Z' },
            { id: 'draft', publishedAt: null },
            { id: 'd1', publishedAt: '2026-09-01T00:00:00Z' },
          ],
          hasNextPage: true,
        })
      }
      throw new Error('page 2 must not be read')
    }
    const client = new BilloMailboxClient(HOSTS, 'api-key')
    const listed = await client.listDocuments({ accountRef: 'pc-accounted', mailboxRef: 'en-1' }, new Date('2026-10-01T00:00:00Z'))
    expect(listed).toEqual([{ ref: 'd3', receivedAt: '2026-10-10T00:00:00Z' }])
    expect(apiCalls()[0]!.url).toContain(`${HOSTS.mailbox}/v1/clients/pc-accounted/enrollments/en-1/documents?`)
  })

  it('downloads the PDF through the guarded fetch of the signed URL', async () => {
    responder = (url) =>
      url.endsWith('/download')
        ? json({ documentId: 'd3', fileName: 'faktura.pdf', contentType: 'application/pdf', downloadUrl: 'https://storage.example/signed' })
        : json({ id: 'd3', title: 'Faktura 1001', type: 'Invoice', sender: 'Leverantören AB', publishedAt: '2026-10-10T00:00:00Z', invoiceData: { billerName: 'Leverantören AB', amount: 499 } })
    safeFetchMock.mockResolvedValue(new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 }))
    const client = new BilloMailboxClient(HOSTS, 'api-key')
    const { document, files } = await client.getDocument({ accountRef: 'pc-accounted', mailboxRef: 'en-1' }, 'd3')
    expect(safeFetchMock).toHaveBeenCalledWith('https://storage.example/signed', expect.objectContaining({ method: 'GET' }))
    expect(files).toEqual([{ name: 'faktura.pdf', contentType: 'application/pdf', bytes: expect.any(ArrayBuffer) }])
    expect(document).toMatchObject({ kind: 'invoice', senderName: 'Leverantören AB', subject: 'Faktura 1001' })
  })

  it('names the sender of a letter, which carries no invoice data', async () => {
    responder = (url) =>
      url.endsWith('/download')
        ? json({ fileName: 'brev.pdf', contentType: 'application/pdf', downloadUrl: 'https://storage.example/signed' })
        : json({ id: 'd4', title: 'Testbrev', type: 'LETTER', sender: 'Testbolaget AB', publishedAt: '2026-10-22T07:59:41Z', invoiceData: null })
    safeFetchMock.mockResolvedValue(new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 }))
    const client = new BilloMailboxClient(HOSTS, 'api-key')
    const { document } = await client.getDocument({ accountRef: 'pc-accounted', mailboxRef: 'en-1' }, 'd4')
    expect(document).toMatchObject({ kind: 'letter', senderName: 'Testbolaget AB', subject: 'Testbrev' })
  })
})

describe('BilloSenderClient', () => {
  const pdf = { name: 'faktura.pdf', bytes: new Uint8Array([37, 80, 68, 70]) }

  it('takes an OAuth token and registers the tenant from billo-objkey', async () => {
    responder = () => json({}, { status: 201, headers: { 'billo-objkey': 'tenant-1' } })
    const client = new BilloSenderClient(HOSTS, { clientId: 'c', clientSecret: 's' })
    await expect(client.registerSender({ orgNumber: ORG, name: 'Testbolaget AB' })).resolves.toEqual({ tenantRef: 'tenant-1' })
    expect(String(calls[0]!.init.body)).toBe('grant_type=client_credentials&client_id=c&client_secret=s')
    expect(bodyOf(apiCalls()[0]!)).toEqual({ name: 'Testbolaget AB', company_id: [{ name: 'Testbolaget AB', orgnr: VAT }] })
  })

  it('sends an invoice to a business by vat with the payment in context', async () => {
    responder = () => json({}, { status: 201, headers: { 'billo-objkey': 'content-1' } })
    const client = new BilloSenderClient(HOSTS, { clientId: 'c', clientSecret: 's' })
    await client.sendInvoice('tenant-1', { kind: 'company', orgNumber: ORG }, {
      subject: 'Faktura 1042',
      generatedAt: '2026-10-19',
      invoiceNumber: '1042',
      pdf,
      payment: { amount: 12500, dueDate: '2026-11-18', method: 'bankgiro', account: '991-2346', reference: '10426', referenceType: 'ocr' },
    })
    const body = bodyOf(apiCalls()[0]!)
    expect(body).toMatchObject({
      vat: VAT,
      type: 'invoice',
      retain: false,
      context: { invoice: { payment: { total_owed: '12500.00', type: 'SE_OCR', method: '1', account: '991-2346' }, invoice_reference: '1042' } },
    })
    expect(body.files[0]).toEqual({ name: 'faktura.pdf', content_type: 'application/pdf', data: 'JVBERg==' })
  })

  it('sends a payslip through SendEasy on the partner gateway and treats an Error status as a failure', async () => {
    responder = () => json({ id: 'x', documentId: 'doc-1', status: 'Published' })
    const client = new BilloSenderClient(HOSTS, { clientId: 'c', clientSecret: 's' })
    // Billo shows the PDF only: an employer without contact details sends all the same.
    const statement = {
      employer: { name: 'Testbolaget AB', orgNumber: ORG, streetAddress: null, postalCode: null, city: null, country: null, email: null, phone: null },
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      payoutDate: '2026-10-25',
      grossPay: 30000,
      taxDeducted: 6500,
      netPay: 23500,
      yearToDateGrossPay: 300000,
      yearToDateTax: 65000,
    }
    const payslip = { subject: 'Lönebesked', generatedAt: '2026-10-25', pdf, statement, firstName: 'Test', lastName: 'T', email: 'test@example.test', phone: PHONE }
    await expect(client.sendPayslip('tenant-1', PNR, payslip)).resolves.toEqual({ providerRef: 'doc-1' })
    const send = apiCalls()[0]!
    expect(send.url).toBe('https://sandbox-api.billo.life/sendeasy/v1/Send')
    expect(send.init.headers).toMatchObject({ authorization: 'Bearer oauth' })
    expect(bodyOf(send)).toMatchObject({ documentType: 'Payslip', tenantKey: 'tenant-1', receiver: { ssn: PNR, email: 'test@example.test' } })

    responder = () => json({ id: 'x', status: 'MissingDetails' })
    await expect(client.sendPayslip('tenant-1', PNR, payslip)).rejects.toMatchObject({ kind: 'rejected' })
  })
})

describe('parseBilloWebhook', () => {
  it('reads the camelCase body with its enrolment and the older snake_case one without', () => {
    expect(
      parseBilloWebhook('PartnerDocumentReceived', JSON.stringify({ documentId: 'd', endCustomerId: 'en', clientId: 'pc', occurredAt: 'x' })),
    ).toEqual({ eventType: 'PartnerDocumentReceived', documentId: 'd', enrollmentId: 'en', partnerCustomerId: 'pc' })
    expect(parseBilloWebhook('PartnerDocumentReceived', JSON.stringify({ document_id: 'd', event_time: 'x' }))).toEqual({
      eventType: 'PartnerDocumentReceived',
      documentId: 'd',
      enrollmentId: null,
      partnerCustomerId: null,
    })
    expect(() => parseBilloWebhook('PartnerDocumentReceived', 'nope')).toThrow()
  })
})
