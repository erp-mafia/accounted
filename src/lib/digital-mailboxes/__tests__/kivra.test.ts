import { createHash, createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  KivraPartnerClient,
  KivraTenantClient,
  createKivraProvider,
  parseKivraWebhook,
  readKivraConfigFromEnv,
  verifyKivraWebhookSignature,
} from '../kivra'

const BASE = 'https://sender.sandbox-api.kivra.com'
const CLIENT = { clientId: 'id', clientSecret: 'secret' }

type Call = { url: string; init: RequestInit }
let calls: Call[]
let responder: (url: string, init: RequestInit) => Response

function json(body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })
}

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.endsWith('/v1/auth')) return json({ access_token: 'tok', expires_in: 3600 })
    return responder(url, init)
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readKivraConfigFromEnv', () => {
  it('is null without any client', () => {
    expect(readKivraConfigFromEnv({})).toBeNull()
  })

  it('defaults to sandbox and keeps the two clients apart', () => {
    const config = readKivraConfigFromEnv({
      KIVRA_CLIENT_ID: 't',
      KIVRA_CLIENT_SECRET: 'ts',
      KIVRA_PARTNER_CLIENT_ID: 'p',
      KIVRA_PARTNER_CLIENT_SECRET: 'ps',
    })
    expect(config?.environment).toBe('sandbox')
    expect(config?.baseUrl).toBe(BASE)
    expect(config?.tenant).toEqual({ clientId: 't', clientSecret: 'ts' })
    expect(config?.partner).toEqual({ clientId: 'p', clientSecret: 'ps' })
    // The onboarding link is Kivra's partner-only flow: settings, never a default in the code.
    expect(config?.onboardingUrl).toBeNull()
  })

  it('uses production only when asked to', () => {
    const config = readKivraConfigFromEnv({ KIVRA_ENVIRONMENT: 'production', KIVRA_CLIENT_ID: 't', KIVRA_CLIENT_SECRET: 'ts' })
    expect(config?.baseUrl).toBe('https://sender.api.kivra.com')
    expect(config?.partner).toBeNull()
  })

  it('receives only with the onboarding link Kivra gave the partner, which must be https', () => {
    const env = { KIVRA_PARTNER_CLIENT_ID: 'p', KIVRA_PARTNER_CLIENT_SECRET: 'ps' }
    expect(createKivraProvider(readKivraConfigFromEnv(env)!).receiver).toBeNull()
    expect(readKivraConfigFromEnv({ ...env, KIVRA_ONBOARDING_URL: 'http://example.test/onboard' })?.onboardingUrl).toBeNull()
    const config = readKivraConfigFromEnv({ ...env, KIVRA_ONBOARDING_URL: 'https://example.test/onboard' })!
    expect(config.onboardingUrl).toBe('https://example.test/onboard')
    expect(createKivraProvider(config).receiver).not.toBeNull()
  })
})

describe('KivraPartnerClient', () => {
  it('authenticates with Basic client credentials and finds a company by VAT number', async () => {
    responder = () => json([{ key: 'ck1', vat_number: 'SE442005920801' }])
    const client = new KivraPartnerClient(BASE, CLIENT)
    await expect(client.findCompanyKey('442005-9208')).resolves.toBe('ck1')
    const auth = calls[0]!
    expect(auth.init.headers).toMatchObject({ authorization: `Basic ${Buffer.from('id:secret').toString('base64')}` })
    expect(String(auth.init.body)).toBe('grant_type=client_credentials')
    expect(calls[1]!.url).toBe(`${BASE}/v3/partner/company?vat_number=SE442005920801`)
    expect(calls[1]!.init.headers).toMatchObject({ authorization: 'Bearer tok' })
  })

  it('lists content since a moment, leaving out what the company trashed', async () => {
    responder = () =>
      json([
        { key: 'old', received_at: '2026-01-01T00:00:00Z', labels: {} },
        { key: 'new', received_at: '2026-10-10T00:00:00Z', labels: {} },
        { key: 'trash', received_at: '2026-10-11T00:00:00Z', labels: { trashed: true } },
      ])
    const client = new KivraPartnerClient(BASE, CLIENT)
    const listed = await client.listDocuments({ accountRef: 'ck1', mailboxRef: null }, new Date('2026-10-01T00:00:00Z'))
    expect(listed).toEqual([{ ref: 'new', receivedAt: '2026-10-10T00:00:00Z' }])
  })

  it('downloads the file parts, checks their sha256 and maps the metadata', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.4 test')
    const sha = createHash('sha256').update(pdf).digest('hex')
    responder = (url) => {
      if (url.includes('?part=1')) return new Response(pdf, { headers: { 'content-type': 'application/pdf' } })
      return json({
        key: 'c1',
        type: 'invoice',
        subject: 'Faktura 12345',
        received_at: '2026-10-10T09:00:00Z',
        sender_name: 'Lenas Konditori AB',
        sender_vat_numbers: ['SE442005921601'],
        labels: { reminder: false },
        parts: [
          { content_type: 'application/pdf', name: 'faktura.pdf', sha256: sha, size: pdf.byteLength },
          { content_type: 'text/html', name: 'body.html', sha256: null, size: 10 },
        ],
        payment_options: [{ amount: 150000, reference: '123', type: 'bankgiro' }],
      })
    }
    const client = new KivraPartnerClient(BASE, CLIENT)
    const { document, files } = await client.getDocument({ accountRef: 'ck1', mailboxRef: null }, 'c1')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ name: 'faktura.pdf', contentType: 'application/pdf' })
    expect(document).toMatchObject({
      ref: 'c1',
      kind: 'invoice',
      subject: 'Faktura 12345',
      senderName: 'Lenas Konditori AB',
      senderOrgNumber: '4420059216',
    })
    expect(document.meta.payment_options).toEqual([{ amount: 150000, reference: '123', type: 'bankgiro' }])
    // Only the PDF part is downloaded.
    expect(calls.filter((c) => c.url.includes('?part=')).map((c) => c.url)).toEqual([`${BASE}/v3/partner/company/ck1/content/c1?part=1`])
  })

  it('refuses a part whose sha256 does not match', async () => {
    responder = (url) =>
      url.includes('?part=1')
        ? new Response('%PDF-tampered', { headers: { 'content-type': 'application/pdf' } })
        : json({ key: 'c1', parts: [{ content_type: 'application/pdf', name: 'x.pdf', sha256: 'a'.repeat(64), size: 1 }] })
    const client = new KivraPartnerClient(BASE, CLIENT)
    await expect(client.getDocument({ accountRef: 'ck1', mailboxRef: null }, 'c1')).rejects.toThrow(/sha256/)
  })

  it('retries once with a fresh token after a 401', async () => {
    let first = true
    responder = () => {
      if (first) {
        first = false
        return json({ code: 401 }, { status: 401 })
      }
      return json([])
    }
    const client = new KivraPartnerClient(BASE, CLIENT)
    await expect(client.listDocuments({ accountRef: 'ck1', mailboxRef: null }, null)).resolves.toEqual([])
    expect(calls.filter((c) => c.url.endsWith('/v1/auth'))).toHaveLength(2)
  })
})

describe('KivraTenantClient', () => {
  const pdf = { name: 'faktura.pdf', bytes: new Uint8Array([37, 80, 68, 70]) }

  it('registers a tenant by VAT number and takes the key from kivra-objkey', async () => {
    responder = () => json({}, { status: 201, headers: { 'kivra-objkey': 'tk1' } })
    const client = new KivraTenantClient(BASE, CLIENT)
    await expect(client.registerSender({ orgNumber: '4420059208', name: 'Säljare AB' })).resolves.toEqual({ tenantRef: 'tk1' })
    const body = JSON.parse(String(calls[1]!.init.body))
    expect(body).toEqual({ name: 'Säljare AB', company_id: [{ name: 'Säljare AB', orgnr: 'SE442005920801' }] })
  })

  it('matches a company recipient by VAT number', async () => {
    responder = () => json({ list: ['SE442005920801'] })
    const client = new KivraTenantClient(BASE, CLIENT)
    await expect(client.isReachable('tk1', { kind: 'company', orgNumber: '4420059208' })).resolves.toBe(true)
    expect(calls[1]!.url).toBe(`${BASE}/v2/tenant/tk1/companymatch/vatnr`)
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ list: ['SE442005920801'] })
  })

  it('sends an invoice to a person as payable, with the OCR as an SE_OCR option', async () => {
    responder = () => json({}, { status: 201, headers: { 'kivra-objkey': 'content-1' } })
    const client = new KivraTenantClient(BASE, CLIENT)
    const receipt = await client.sendInvoice('tk1', { kind: 'person', personnummer: '195001182046' }, {
      subject: 'Faktura 1042',
      generatedAt: '2026-10-19',
      invoiceNumber: '1042',
      pdf,
      payment: { amount: 1250, dueDate: '2026-11-18', method: 'bankgiro', account: '991-2346', reference: '10426', referenceType: 'ocr' },
    })
    expect(receipt).toEqual({ providerRef: 'content-1' })
    const body = JSON.parse(String(calls[1]!.init.body))
    expect(body).toMatchObject({
      ssn: '195001182046',
      type: 'invoice',
      payment_multiple_options: {
        payable: true,
        currency: 'SEK',
        method: '1',
        account: '991-2346',
        options: [{ due_date: '2026-11-18', amount: '1250.00', type: 'SE_OCR', reference: '10426' }],
      },
    })
    expect(body.parts[0]).toEqual({ name: 'faktura.pdf', content_type: 'application/pdf', data: 'JVBERg==' })
  })

  it('sends to a company as not payable in Kivra, and without a giro as a letter', async () => {
    responder = () => json({}, { status: 201 })
    const client = new KivraTenantClient(BASE, CLIENT)
    await client.sendInvoice('tk1', { kind: 'company', orgNumber: '4420059208' }, {
      subject: 'Faktura 1',
      generatedAt: '2026-10-19',
      invoiceNumber: '1',
      pdf,
      payment: { amount: 10, dueDate: '2026-11-18', method: 'plusgiro', account: '12345-6', reference: '1', referenceType: 'invoice_number' },
    })
    await client.sendInvoice('tk1', { kind: 'company', orgNumber: '4420059208' }, {
      subject: 'Faktura 2',
      generatedAt: '2026-10-19',
      invoiceNumber: '2',
      pdf,
      payment: null,
    })
    const withPayment = JSON.parse(String(calls[1]!.init.body))
    expect(withPayment.vat_number).toBe('SE442005920801')
    expect(withPayment.payment_multiple_options).toMatchObject({ payable: false, method: '2', options: [{ type: 'TENANT_REF' }] })
    const letter = JSON.parse(String(calls[2]!.init.body))
    expect(letter.type).toBe('letter')
    expect(letter.payment_multiple_options).toBeUndefined()
  })

  const statement = {
    employer: {
      name: 'Säljare AB',
      orgNumber: '442005-9208',
      streetAddress: 'Storgatan 1',
      postalCode: '111 22',
      city: 'Stockholm',
      country: 'SE',
      email: 'lon@example.test',
      phone: '08-465 004 05',
    },
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    payoutDate: '2026-10-25',
    grossPay: 32500,
    taxDeducted: 6962.5,
    netPay: 25537.5,
    yearToDateGrossPay: 325000,
    yearToDateTax: 69625,
  }
  const payslip = { subject: 'Lönebesked 2026-10', generatedAt: '2026-10-25', pdf, statement, firstName: 'Anna', lastName: 'Andersson', email: null, phone: null }

  it('sends a payslip as salaryslip with the structured salaryslip object Kivra requires, the PDF as its part', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T08:15:30.123Z'))
    responder = () => json({}, { status: 201, headers: { 'kivra-objkey': 'slip-1' } })
    const client = new KivraTenantClient(BASE, CLIENT)
    try {
      await expect(client.sendPayslip('tk1', '195001182046', payslip)).resolves.toEqual({ providerRef: 'slip-1' })
    } finally {
      vi.useRealTimers()
    }
    expect(calls[1]!.url).toBe(`${BASE}/v2/tenant/tk1/content`)
    const body = JSON.parse(String(calls[1]!.init.body))
    expect(body).toMatchObject({ ssn: '195001182046', subject: 'Lönebesked 2026-10', generated_at: '2026-10-25', type: 'salaryslip' })
    expect(body.salaryslip).toEqual({
      document_metadata: { creation_timestamp: '2026-10-20T08:15:30Z', source_system: 'Accounted' },
      employment: {
        employer: {
          legal_name: 'Säljare AB',
          legal_identifiers: { vat_number: 'SE442005920801', org_number: '442005-9208' },
          contact_information: {
            address: { street_address: 'Storgatan 1', postal_code: '111 22', city: 'Stockholm', country: 'Sweden' },
            email_address: 'lon@example.test',
            telephone_number: '0846500405',
          },
        },
      },
      yearly_accumulated_gross_pay: { monetary_amount: '325000.00', currency: 'SEK' },
      yearly_accumulated_taxes: { monetary_amount: '69625.00', currency: 'SEK' },
      pay_period: {
        start_date: '2026-10-01',
        end_date: '2026-10-31',
        payout_date: '2026-10-25',
        gross_pay: { monetary_amount: '32500.00', currency: 'SEK' },
        tax_deducted: { monetary_amount: '6962.50', currency: 'SEK' },
        net_pay: { monetary_amount: '25537.50', currency: 'SEK' },
      },
    })
    expect(body.parts).toEqual([{ name: 'faktura.pdf', content_type: 'application/pdf', data: 'JVBERg==' }])
  })

  it('refuses a payslip without the employer contact or over the 1 MB limit before calling', async () => {
    responder = () => json({}, { status: 201 })
    const client = new KivraTenantClient(BASE, CLIENT)
    await expect(
      client.sendPayslip('tk1', '195001182046', { ...payslip, statement: { ...statement, employer: { ...statement.employer, phone: null } } }),
    ).rejects.toMatchObject({ kind: 'rejected', providerCode: 'employer_contact_missing' })

    const big = { name: 'big.pdf', bytes: new Uint8Array(900_000) }
    await expect(client.sendPayslip('tk1', '195001182046', { ...payslip, pdf: big })).rejects.toMatchObject({ status: 413 })
    expect(calls).toHaveLength(0)
  })
})

describe('verifyKivraWebhookSignature', () => {
  const secret = 'shared-secret'
  const payload = '{"id":"event_1"}'
  const now = 1_790_000_000
  const sign = (t: number, key = secret) => createHmac('sha256', key).update(`${t}:${payload}`).digest('hex')

  it('accepts a fresh signature, also as one of several during a rotation', () => {
    expect(verifyKivraWebhookSignature({ secret, payload, timestamp: String(now), signatures: [`v1=${sign(now)}`], nowMs: now * 1000 })).toBe(true)
    expect(
      verifyKivraWebhookSignature({
        secret,
        payload,
        timestamp: String(now),
        signatures: [`v1=${sign(now, 'old')}`, `v1=${sign(now)}`],
        nowMs: now * 1000,
      }),
    ).toBe(true)
  })

  it('refuses a wrong secret, a stale timestamp and a missing header', () => {
    expect(verifyKivraWebhookSignature({ secret, payload, timestamp: String(now), signatures: [`v1=${sign(now, 'x')}`], nowMs: now * 1000 })).toBe(false)
    expect(verifyKivraWebhookSignature({ secret, payload, timestamp: String(now - 600), signatures: [`v1=${sign(now - 600)}`], nowMs: now * 1000 })).toBe(false)
    expect(verifyKivraWebhookSignature({ secret, payload, timestamp: null, signatures: [], nowMs: now * 1000 })).toBe(false)
  })
})

describe('parseKivraWebhook', () => {
  it('reads the three partner events and ignores others', () => {
    expect(
      parseKivraWebhook(JSON.stringify({ id: 'event_1', event_type: 'content.created', data: { company_key: 'ck', content_key: 'cc', vat_number: 'SE442005920801' } })),
    ).toEqual({ id: 'event_1', type: 'content.created', companyKey: 'ck', contentKey: 'cc', vatNumber: 'SE442005920801' })
    expect(parseKivraWebhook(JSON.stringify({ id: 'event_2', event_type: 'something.else', data: {} }))).toBeNull()
    expect(() => parseKivraWebhook('not json')).toThrow()
    expect(() => parseKivraWebhook(JSON.stringify({ event_type: 'integration.created', data: {} }))).toThrow()
  })
})
