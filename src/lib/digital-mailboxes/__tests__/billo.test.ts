import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const safeFetchMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/http/safe-fetch', () => ({ safeFetch: safeFetchMock }))

import { BILLO_HOSTS, BilloMailboxClient, BilloSenderClient, parseBilloWebhook, readBilloConfigFromEnv } from '../billo'

const HOSTS = BILLO_HOSTS.sandbox
type Call = { url: string; init: RequestInit }
let calls: Call[]
let responder: (url: string, init: RequestInit) => Response

function json(body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })
}

beforeEach(() => {
  calls = []
  safeFetchMock.mockReset()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.endsWith('/v1/auth/token')) return json({ accessToken: 'jwt', expiresIn: 900, refreshToken: 'r' })
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
    expect(config?.sender).toBeNull()
  })

  it('reads the sender client and production hosts', () => {
    const config = readBilloConfigFromEnv({ BILLO_ENVIRONMENT: 'production', BILLO_SENDER_CLIENT_ID: 'c', BILLO_SENDER_CLIENT_SECRET: 's' })
    expect(config?.hosts.sender).toBe('https://sender-api.billo.life')
    expect(config?.partnerApiKey).toBeNull()
  })
})

const mailboxInput = {
  orgNumber: '5560160680',
  companyName: 'Säljare AB',
  externalCustomerId: 'company-1',
  addressLine1: 'Storgatan 1',
  postalCode: '11122',
  city: 'Stockholm',
  representative: { name: 'Anna Andersson', personnummer: '199001011234', email: 'anna@example.test', phone: '+46701234567' },
}

describe('BilloMailboxClient', () => {
  it('exchanges the API key, registers the business customer and enrols its mailbox with no mandate', async () => {
    responder = (url) => {
      if (url.endsWith('/v1/clients/business')) return json({ id: 'pc-1', alreadyRegistered: false })
      return json({ enrollmentId: 'en-1', status: 'Active', customerNumber: '123', billoAddress: { line1: 'Billo' } })
    }
    const client = new BilloMailboxClient(HOSTS, 'api-key')
    const result = await client.createBusinessMailbox(mailboxInput)
    expect(result).toEqual({ partnerCustomerId: 'pc-1', enrollmentId: 'en-1', status: 'Active', customerNumber: '123', billoAddress: { line1: 'Billo' } })
    expect(calls[0]!.init.headers).toMatchObject({ 'x-api-key': 'api-key' })
    const [register, enrol] = apiCalls()
    expect(register!.init.headers).toMatchObject({ authorization: 'Bearer jwt' })
    expect(bodyOf(register!)).toEqual({
      name: 'Säljare AB',
      orgNumber: '5560160680',
      externalCustomerId: 'company-1',
      email: 'anna@example.test',
      phoneNumber: '+46701234567',
    })
    expect(enrol!.url).toBe(`${HOSTS.mailbox}/v1/clients/pc-1/enrollments/business`)
    expect(bodyOf(enrol!)).toMatchObject({
      customer: { orgNumber: '5560160680', representativeSsn: '199001011234', representativePhone: '+46701234567' },
      forordnande: { signingMethod: 'NotRequired' },
    })
  })

  it('takes over its own earlier enrolment when Billo answers 409 errorCode 13', async () => {
    responder = (url) => {
      if (url.endsWith('/v1/clients/business')) return json({ id: 'pc-1', alreadyRegistered: true })
      if (url.endsWith('/enrollments/business')) return json({ title: 'End customer is already onboarded', errorCode: 13 }, { status: 409 })
      return json({ items: [{ enrollmentId: 'en-9', orgNumber: '556016-0680', status: 'Active' }] })
    }
    const client = new BilloMailboxClient(HOSTS, 'api-key')
    await expect(client.createBusinessMailbox(mailboxInput)).resolves.toMatchObject({ enrollmentId: 'en-9' })
  })

  it('rethrows a 409 that is another partner\'s enrolment', async () => {
    responder = (url) => {
      if (url.endsWith('/v1/clients/business')) return json({ id: 'pc-1' })
      if (url.endsWith('/enrollments/business')) return json({ errorCode: 13 }, { status: 409 })
      return json({ items: [] })
    }
    const client = new BilloMailboxClient(HOSTS, 'api-key')
    await expect(client.createBusinessMailbox(mailboxInput)).rejects.toMatchObject({ kind: 'conflict', providerCode: '13' })
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
    const listed = await client.listDocuments({ accountRef: 'pc-1', mailboxRef: 'en-1' }, new Date('2026-10-01T00:00:00Z'))
    expect(listed).toEqual([{ ref: 'd3', receivedAt: '2026-10-10T00:00:00Z' }])
  })

  it('downloads the PDF through the guarded fetch of the signed URL', async () => {
    responder = (url) =>
      url.endsWith('/download')
        ? json({ documentId: 'd3', fileName: 'faktura.pdf', contentType: 'application/pdf', downloadUrl: 'https://storage.example/signed' })
        : json({ id: 'd3', title: 'Faktura från Telia', type: 'Invoice', publishedAt: '2026-10-10T00:00:00Z', invoiceData: { billerName: 'Telia', amount: 499 } })
    safeFetchMock.mockResolvedValue(new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 }))
    const client = new BilloMailboxClient(HOSTS, 'api-key')
    const { document, files } = await client.getDocument({ accountRef: 'pc-1', mailboxRef: 'en-1' }, 'd3')
    expect(safeFetchMock).toHaveBeenCalledWith('https://storage.example/signed', expect.objectContaining({ method: 'GET' }))
    expect(files).toEqual([{ name: 'faktura.pdf', contentType: 'application/pdf', bytes: expect.any(ArrayBuffer) }])
    expect(document).toMatchObject({ kind: 'invoice', senderName: 'Telia', subject: 'Faktura från Telia' })
  })
})

describe('BilloSenderClient', () => {
  const pdf = { name: 'faktura.pdf', bytes: new Uint8Array([37, 80, 68, 70]) }

  it('takes an OAuth token and registers the tenant from billo-objkey', async () => {
    responder = () => json({}, { status: 201, headers: { 'billo-objkey': 'tenant-1' } })
    const client = new BilloSenderClient(HOSTS, { clientId: 'c', clientSecret: 's' })
    await expect(client.registerSender({ orgNumber: '5560160680', name: 'Säljare AB' })).resolves.toEqual({ tenantRef: 'tenant-1' })
    expect(String(calls[0]!.init.body)).toBe('grant_type=client_credentials&client_id=c&client_secret=s')
    expect(bodyOf(apiCalls()[0]!)).toEqual({ name: 'Säljare AB', company_id: [{ name: 'Säljare AB', orgnr: 'SE556016068001' }] })
  })

  it('sends an invoice to a business by vat with the payment in context', async () => {
    responder = () => json({}, { status: 201, headers: { 'billo-objkey': 'content-1' } })
    const client = new BilloSenderClient(HOSTS, { clientId: 'c', clientSecret: 's' })
    await client.sendInvoice('tenant-1', { kind: 'company', orgNumber: '5560160680' }, {
      subject: 'Faktura 1042',
      generatedAt: '2026-10-19',
      invoiceNumber: '1042',
      pdf,
      payment: { amount: 12500, dueDate: '2026-11-18', method: 'bankgiro', account: '991-2346', reference: '10426', referenceType: 'ocr' },
    })
    const body = bodyOf(apiCalls()[0]!)
    expect(body).toMatchObject({
      vat: 'SE556016068001',
      type: 'invoice',
      retain: false,
      context: { invoice: { payment: { total_owed: '12500.00', type: 'SE_OCR', method: '1', account: '991-2346' }, invoice_reference: '1042' } },
    })
    expect(body.files[0]).toEqual({ name: 'faktura.pdf', content_type: 'application/pdf', data: 'JVBERg==' })
  })

  it('sends a payslip through SendEasy and treats an Error status as a failure', async () => {
    responder = () => json({ id: 'x', documentId: 'doc-1', status: 'Published' })
    const client = new BilloSenderClient(HOSTS, { clientId: 'c', clientSecret: 's' })
    // Billo shows the PDF only: an employer without contact details sends all the same.
    const statement = {
      employer: { name: 'Exempel AB', orgNumber: '5560160680', streetAddress: null, postalCode: null, city: null, country: null, email: null, phone: null },
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      payoutDate: '2026-10-25',
      grossPay: 30000,
      taxDeducted: 6500,
      netPay: 23500,
      yearToDateGrossPay: 300000,
      yearToDateTax: 65000,
    }
    const payslip = { subject: 'Lönebesked', generatedAt: '2026-10-25', pdf, statement, firstName: 'Anna', lastName: 'A', email: 'a@example.test', phone: '+46701234567' }
    await expect(client.sendPayslip('tenant-1', '199001011234', payslip)).resolves.toEqual({ providerRef: 'doc-1' })
    const send = apiCalls()[0]!
    expect(send.url).toBe(`${HOSTS.sender}/api/v1/Send`)
    expect(bodyOf(send)).toMatchObject({ documentType: 'Payslip', tenantKey: 'tenant-1', receiver: { ssn: '199001011234', email: 'a@example.test' } })

    responder = () => json({ id: 'x', status: 'MissingDetails' })
    await expect(client.sendPayslip('tenant-1', '199001011234', payslip)).rejects.toMatchObject({ kind: 'rejected' })
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
