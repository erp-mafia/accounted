import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTRACT_VERSION, PAYMENTS_OPERATIONS, type PaymentsOperation } from '@accounted/connect-contract'
import { ConnectorCallError, CONNECTOR_UNREACHABLE_CODE } from '@/lib/connect/instance/connector-fetch'
import {
  PAYMENT_NOT_FOUND,
  PaymentProviderError,
  getPaymentInitiationProvider,
  getPaymentInitiationProviderById,
  providerWriteOutcome,
  registerPaymentInitiationProvider,
  resetPaymentInitiationProviders,
  type PaymentInitiationProvider,
  type PaymentInstruction,
  type PaymentPartyContext,
} from '../provider'
import {
  PAYMENT_REFUSED,
  PAYMENTS_CONNECT_TIMEOUT_MS,
  basketIdempotencyKey,
  cancelIdempotencyKey,
  paymentIdempotencyKey,
  createConnectPaymentsProvider,
  isUnsignedProviderStatus,
  registerConnectPaymentsProvider,
  toConnectorParty,
  toPaymentProviderError,
} from '../connect'

const UPSTREAM = { baseUrl: 'https://connect.example.se/api/connect/payments', key: 'gnubok_ck_secret' }

const CTX: PaymentPartyContext = {
  companyId: 'co-1',
  companyOrgNumber: '559538-6219',
  accountContext: 'corporate',
  debtorBic: 'SWEDSESS',
  affiliatedAspspId: null,
  signerPersonalNumber: '199001011239',
  psuIpAddress: '203.0.113.10',
  psuUserAgent: 'UA',
}

const INSTRUCTION: PaymentInstruction = {
  endToEndId: 'E2E-1',
  amount: 1250.5,
  currency: 'SEK',
  requestedExecutionDate: '2026-10-12',
  debtor: { iban: 'SE6380000832798443379915', bban: null, currency: 'SEK' },
  payee: { type: 'bankgiro', bankgiro: '5050-1055', name: 'Leverantören AB' },
  reference: { type: 'ocr', value: '12345678901' },
}

const STATE = { providerStatus: 'RCVD', status: 'submitted', messages: [] }
const CHALLENGE = { approach: 'decoupled', autostartToken: 'tok', qrData: 'bankid.qr', qrImage: null, redirectUrl: null }

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function fetchAnswering(status: number, body: unknown) {
  return vi.fn().mockResolvedValue(jsonResponse(status, body))
}

function provider(fetchMock: typeof fetch): PaymentInitiationProvider {
  return createConnectPaymentsProvider(UPSTREAM, { fetch: fetchMock, timeoutMs: 1000 })
}

async function failure(promise: Promise<unknown>): Promise<PaymentProviderError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentProviderError)
    return error as PaymentProviderError
  }
  throw new Error('expected a PaymentProviderError')
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  return JSON.parse(init.body as string) as Record<string, unknown>
}

function sentUrl(fetchMock: ReturnType<typeof vi.fn>): string {
  return (fetchMock.mock.calls[0] as [string, RequestInit])[0]
}

function sentHeaders(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  return (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>
}

beforeEach(() => resetPaymentInitiationProviders())
afterEach(() => {
  vi.unstubAllEnvs()
  resetPaymentInitiationProviders()
})

describe('isAvailableFor', () => {
  it('serves every company of the installation: the paid plan and the pilot list are the domain\'s question', () => {
    const fetchMock = vi.fn()
    vi.stubEnv('OPENPAYMENTS_COMPANY_IDS', '')
    expect(provider(fetchMock).isAvailableFor('co-1')).toBe(true)
    expect(provider(fetchMock).isAvailableFor('co-2')).toBe(true)
  })
})

describe('registerConnectPaymentsProvider', () => {
  it('registers nothing without a connector key', async () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', '')
    expect(registerConnectPaymentsProvider()).toBe(false)
    expect(await getPaymentInitiationProviderById('open_payments')).toBeNull()
  })

  it('registers the adapter from the connector configuration, once', async () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    vi.stubEnv('GNUBOK_CONNECT_URL', 'https://connect.example.se')
    expect(registerConnectPaymentsProvider()).toBe(true)
    expect(registerConnectPaymentsProvider()).toBe(false)
    expect((await getPaymentInitiationProviderById('open_payments'))?.id).toBe('open_payments')
    expect((await getPaymentInitiationProvider('co-1'))?.id).toBe('open_payments')
    expect((await getPaymentInitiationProvider('co-2'))?.id).toBe('open_payments')
  })

  it('keeps a provider registered earlier under the same id', async () => {
    const fake = { id: 'open_payments' } as unknown as PaymentInitiationProvider
    registerPaymentInitiationProvider(fake)
    expect(registerConnectPaymentsProvider({ upstream: UPSTREAM })).toBe(false)
    expect(await getPaymentInitiationProviderById('open_payments')).toBe(fake)
  })

  it('takes an explicit upstream (and refuses an explicit null)', () => {
    expect(registerConnectPaymentsProvider({ upstream: null })).toBe(false)
    expect(registerConnectPaymentsProvider({ upstream: UPSTREAM })).toBe(true)
  })
})

describe('toConnectorParty', () => {
  it('sends digits only for the organisationsnummer and the personnummer, the rest as is', () => {
    expect(toConnectorParty(CTX)).toEqual({
      orgNumber: '5595386219',
      accountContext: 'corporate',
      debtorBic: 'SWEDSESS',
      signerPersonalNumber: '199001011239',
      psuIpAddress: '203.0.113.10',
      psuUserAgent: 'UA',
      affiliatedAspspId: null,
    })
    expect(toConnectorParty({ ...CTX, signerPersonalNumber: '19900101-1239' }).signerPersonalNumber).toBe('199001011239')
    expect(toConnectorParty({ ...CTX, signerPersonalNumber: null, psuIpAddress: null, psuUserAgent: null })).toMatchObject({
      signerPersonalNumber: null,
      psuIpAddress: null,
      psuUserAgent: null,
    })
  })
})

describe('toConnectorParty: the affiliated bank', () => {
  it('carries the sparbank behind a shared BIC, the account context and a redirect preference', () => {
    const party = toConnectorParty({ ...CTX, accountContext: 'private', affiliatedAspspId: '08999', redirectPreferred: true })
    expect(party).toMatchObject({ debtorBic: 'SWEDSESS', affiliatedAspspId: '08999', accountContext: 'private', redirectPreferred: true })
    expect(toConnectorParty(CTX)).not.toHaveProperty('redirectPreferred')
  })

  it('carries the signer\'s Nordea Corporate Netbank logon id when there is one, and no key otherwise', () => {
    expect(toConnectorParty({ ...CTX, debtorBic: 'NDEASESS', psuAuthoriserId: 'corp-user-1' })).toMatchObject({ debtorBic: 'NDEASESS', psuAuthoriserId: 'corp-user-1' })
    expect(toConnectorParty(CTX)).not.toHaveProperty('psuAuthoriserId')
    expect(toConnectorParty({ ...CTX, psuAuthoriserId: null })).not.toHaveProperty('psuAuthoriserId')
  })

  it('sends the affiliated bank on every operation that carries a party', async () => {
    const affiliated = { ...CTX, affiliatedAspspId: '08999' }
    const calls: Array<[string, (p: PaymentInitiationProvider) => Promise<unknown>, unknown]> = [
      ['createPayment', (p) => p.createPayment(affiliated, INSTRUCTION), { providerPaymentId: 'pay-1', product: 'swedish-giro', sentPayeeName: null, ...STATE }],
      ['getPaymentState', (p) => p.getPaymentState(affiliated, 'pay-1', 'swedish-giro'), STATE],
      ['createSigningBasket', (p) => p.createSigningBasket(affiliated, ['pay-1', 'pay-2']), { providerBasketId: 'bask-1' }],
      ['startSigning', (p) => p.startSigning(affiliated, { kind: 'basket', providerBasketId: 'bask-1' }, 'qr'), { state: 'pending', challenge: CHALLENGE, failureCode: null, providerAuthorisationId: 'auth-1', method: 'qr' }],
      ['pollSigning', (p) => p.pollSigning(affiliated, { kind: 'basket', providerBasketId: 'bask-1' }, 'auth-1', 'qr'), { state: 'pending', challenge: CHALLENGE, failureCode: null }],
      ['cancelPayment', (p) => p.cancelPayment(affiliated, 'pay-1', 'swedish-giro'), { outcome: 'cancelled', providerStatus: 'CANC' }],
    ]
    for (const [name, run, answer] of calls) {
      const fetchMock = fetchAnswering(200, answer)
      await run(provider(fetchMock))
      expect((sentBody(fetchMock).party as { affiliatedAspspId: string | null }).affiliatedAspspId, name).toBe('08999')
    }
  })
})

describe('basketIdempotencyKey', () => {
  it('names the same set of payments the same whatever the order', () => {
    const a = basketIdempotencyKey(['p-2', 'p-1', 'p-3'])
    expect(a).toBe(basketIdempotencyKey(['p-1', 'p-2', 'p-3']))
    expect(a).not.toBe(basketIdempotencyKey(['p-1', 'p-2']))
    expect(a).toMatch(/^basket:[0-9a-f]{64}$/)
    expect(a.length).toBeLessThanOrEqual(128)
  })
})

describe('the operations', () => {
  it('createPayment sends the key, party and instruction with the connector headers and maps the answer', async () => {
    const fetchMock = fetchAnswering(200, { ...STATE, providerPaymentId: 'pay-1', product: 'swedish-giro', sentPayeeName: 'LEVERANTOREN AB' })
    const created = await provider(fetchMock).createPayment(CTX, INSTRUCTION)
    expect(created).toEqual({ providerPaymentId: 'pay-1', product: 'swedish-giro', providerStatus: 'RCVD', status: 'submitted', messages: [] })
    expect(sentUrl(fetchMock)).toBe('https://connect.example.se/api/connect/payments/payments')
    expect(sentHeaders(fetchMock)).toMatchObject({
      Authorization: 'Bearer gnubok_ck_secret',
      'X-Connect-Contract-Version': CONTRACT_VERSION,
      'X-Connector-Company': 'co-1',
      'Content-Type': 'application/json',
    })
    expect(sentBody(fetchMock)).toEqual({ idempotencyKey: 'pay:E2E-1', party: toConnectorParty(CTX), instruction: INSTRUCTION })
  })

  it('keys a create by the end-to-end id, and by the attempt once a payment for the order was cancelled', async () => {
    expect(paymentIdempotencyKey({ endToEndId: 'E2E-1' })).toBe('pay:E2E-1')
    expect(paymentIdempotencyKey({ endToEndId: 'E2E-1', attempt: 1 })).toBe('pay:E2E-1')
    expect(paymentIdempotencyKey({ endToEndId: 'E2E-1', attempt: 2 })).toBe('pay:E2E-1:2')
    const fetchMock = fetchAnswering(200, { ...STATE, providerPaymentId: 'pay-2', product: 'swedish-giro', sentPayeeName: null })
    await provider(fetchMock).createPayment(CTX, { ...INSTRUCTION, attempt: 3 })
    const body = sentBody(fetchMock)
    expect(body.idempotencyKey).toBe('pay:E2E-1:3')
    // The attempt is ours; the wire instruction is the contract's alone.
    expect(body.instruction).toEqual(INSTRUCTION)
  })

  it('getPaymentState asks for the status by payment id and product', async () => {
    const fetchMock = fetchAnswering(200, { providerStatus: 'ACSC', status: 'executed', messages: ['X'] })
    const state = await provider(fetchMock).getPaymentState(CTX, 'pay-1', 'domestic')
    expect(state).toEqual({ providerStatus: 'ACSC', status: 'executed', messages: ['X'] })
    expect(sentUrl(fetchMock)).toBe('https://connect.example.se/api/connect/payments/payments/status')
    expect(sentBody(fetchMock)).toEqual({ party: toConnectorParty(CTX), providerPaymentId: 'pay-1', product: 'domestic' })
  })

  it('createSigningBasket keys the basket by its sorted payment ids', async () => {
    const fetchMock = fetchAnswering(200, { providerBasketId: 'bask-1' })
    const basket = await provider(fetchMock).createSigningBasket(CTX, ['p-2', 'p-1'])
    expect(basket).toEqual({ providerBasketId: 'bask-1' })
    expect(sentUrl(fetchMock)).toBe('https://connect.example.se/api/connect/payments/baskets')
    expect(sentBody(fetchMock)).toEqual({ idempotencyKey: basketIdempotencyKey(['p-1', 'p-2']), party: toConnectorParty(CTX), providerPaymentIds: ['p-2', 'p-1'] })
  })

  it('keys a basket by the signing it is made for: a new signing over the same payments is a new basket (crm#1282)', async () => {
    // A signing that failed while the bank kept its payments is restarted as
    // a new signing over the same payments. Keyed by the payments alone, it
    // got the dead basket of the first signing replayed, or a mismatch when
    // the party differed.
    const signingId = '3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
    const first = fetchAnswering(200, { providerBasketId: 'bask-1' })
    await provider(first).createSigningBasket(CTX, ['p-2', 'p-1'], signingId)
    const key = sentBody(first).idempotencyKey as string
    expect(key).toBe(basketIdempotencyKey(['p-1', 'p-2'], signingId))
    expect(key.startsWith(`basket:${signingId}:`)).toBe(true)
    expect(key.length).toBeLessThanOrEqual(128)
    // A retry of the same signing names the same basket, in any order.
    expect(basketIdempotencyKey(['p-2', 'p-1'], signingId)).toBe(key)
    // Another signing over the same payments does not.
    expect(basketIdempotencyKey(['p-1', 'p-2'], '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d')).not.toBe(key)
  })

  it('startSigning sends a fresh key every time and maps the challenge without the image', async () => {
    const answer = { state: 'pending', challenge: CHALLENGE, failureCode: null, providerAuthorisationId: 'auth-1', method: 'qr' }
    const first = fetchAnswering(200, answer)
    const started = await provider(first).startSigning(CTX, { kind: 'basket', providerBasketId: 'bask-1' }, 'qr')
    expect(started).toEqual({
      providerAuthorisationId: 'auth-1',
      method: 'qr',
      state: 'pending',
      challenge: { approach: 'decoupled', autostartToken: 'tok', qrData: 'bankid.qr', qrImage: null, redirectUrl: null },
      failureCode: null,
      step: null,
    })
    expect(sentUrl(first)).toBe('https://connect.example.se/api/connect/payments/signings')
    const body = sentBody(first)
    expect(body.idempotencyKey).toMatch(/^sign:bask-1:qr:[0-9a-f-]{36}$/)
    expect(body.target).toEqual({ kind: 'basket', providerBasketId: 'bask-1' })
    expect(body.method).toBe('qr')

    const second = fetchAnswering(200, answer)
    await provider(second).startSigning(CTX, { kind: 'payment', providerPaymentId: 'pay-1', product: 'domestic' }, 'same_device')
    expect(sentBody(second).idempotencyKey).toMatch(/^sign:pay-1:same_device:/)
    expect(sentBody(second).idempotencyKey).not.toBe(body.idempotencyKey)
  })

  it("startSigning on the bank's own page sends where to come back, and never for a decoupled start", async () => {
    const redirect = { approach: 'redirect', autostartToken: null, qrData: null, qrImage: null, redirectUrl: 'https://bank.example.se/sign' }
    const answer = { state: 'pending', challenge: redirect, failureCode: null, providerAuthorisationId: 'auth-2', method: 'redirect' }
    const fetchMock = fetchAnswering(200, answer)
    const started = await provider(fetchMock).startSigning(CTX, { kind: 'payment', providerPaymentId: 'pay-1', product: 'domestic' }, 'redirect', {
      returnUrl: 'https://app.accounted.se/payments?signing=batch-1',
      returnState: 'batch-1',
    })
    expect(started).toMatchObject({ method: 'redirect', challenge: { approach: 'redirect', redirectUrl: 'https://bank.example.se/sign' } })
    expect(sentBody(fetchMock)).toMatchObject({ method: 'redirect', returnUrl: 'https://app.accounted.se/payments?signing=batch-1', returnState: 'batch-1' })

    const decoupled = fetchAnswering(200, { ...answer, method: 'qr', challenge: CHALLENGE })
    await provider(decoupled).startSigning(CTX, { kind: 'payment', providerPaymentId: 'pay-1', product: 'domestic' }, 'qr', { returnUrl: 'https://app.accounted.se/payments', returnState: 'x' })
    expect(sentBody(decoupled)).not.toHaveProperty('returnUrl')
    // The contract refuses a redirect start without a way back before anything is sent.
    const never = fetchAnswering(200, answer)
    await expect(provider(never).startSigning(CTX, { kind: 'payment', providerPaymentId: 'pay-1', product: 'domestic' }, 'redirect')).rejects.toBeInstanceOf(PaymentProviderError)
    expect(never).not.toHaveBeenCalled()
  })

  it('pollSigning passes the authorisation and method and maps a finished signing', async () => {
    const fetchMock = fetchAnswering(200, { state: 'finalised', challenge: null, failureCode: null })
    const progress = await provider(fetchMock).pollSigning(CTX, { kind: 'payment', providerPaymentId: 'pay-1', product: 'domestic' }, 'auth-1', 'qr')
    expect(progress).toEqual({ state: 'finalised', challenge: null, failureCode: null, step: null })
    expect(sentUrl(fetchMock)).toBe('https://connect.example.se/api/connect/payments/signings/poll')
    expect(sentBody(fetchMock)).toEqual({
      party: toConnectorParty(CTX),
      target: { kind: 'payment', providerPaymentId: 'pay-1', product: 'domestic' },
      providerAuthorisationId: 'auth-1',
      method: 'qr',
    })
  })

  it('pollSigning turns the bank SCA status into the step the person is at', async () => {
    const target = { kind: 'payment', providerPaymentId: 'pay-1', product: 'swedish-giro' } as const
    for (const [scaStatus, step] of [
      ['authenticationStarted', 'identify'],
      ['authoriseCreditorAccountStarted', 'approve_payee'],
      ['started', 'sign'],
      ['somethingNew', null],
    ] as const) {
      const fetchMock = fetchAnswering(200, { state: 'pending', challenge: CHALLENGE, failureCode: null, scaStatus })
      const progress = await provider(fetchMock).pollSigning(CTX, target, 'auth-1', 'qr')
      expect(progress.step).toBe(step)
    }
  })

  it('pollSigning keeps the failure code of a failed signing', async () => {
    const fetchMock = fetchAnswering(200, { state: 'failed', challenge: null, failureCode: 'SCA_REDIRECT_UNSUPPORTED' })
    const progress = await provider(fetchMock).pollSigning(CTX, { kind: 'basket', providerBasketId: 'b' }, 'auth-1', 'redirect')
    expect(progress.state).toBe('failed')
    expect(progress.failureCode).toBe('SCA_REDIRECT_UNSUPPORTED')
  })

  it('cancelPayment keys the cancel by payment id and returns the bank answer', async () => {
    const fetchMock = fetchAnswering(200, { outcome: 'too_late', providerStatus: 'ACSC' })
    const result = await provider(fetchMock).cancelPayment(CTX, 'pay-1', 'swedish-giro')
    expect(result).toEqual({ outcome: 'too_late', providerStatus: 'ACSC', unsigned: false })
    expect(sentUrl(fetchMock)).toBe('https://connect.example.se/api/connect/payments/payments/cancel')
    const body = sentBody(fetchMock)
    expect(body).toEqual({ idempotencyKey: expect.any(String), party: toConnectorParty(CTX), providerPaymentId: 'pay-1', product: 'swedish-giro' })
    expect(body.idempotencyKey).toMatch(/^cancel:pay-1:[0-9a-f-]{36}$/)
  })

  it('asks the bank again on every cancel of a payment, whoever asks (crm#1282)', async () => {
    // A person's cancel was answered "too late" while the payment's signing
    // was open; the agent's cancel minutes later carried another party (no
    // IP, another user agent). Under one key per payment the service refused
    // it as CONNECTOR_IDEMPOTENCY_MISMATCH without asking the bank, for the
    // 30 days it keeps the key, and replayed the first answer to a caller
    // that sent the same body.
    const person = fetchAnswering(200, { outcome: 'too_late', providerStatus: 'RCVD' })
    await provider(person).cancelPayment(CTX, 'pay-1', 'swedish-giro')
    const agent = fetchAnswering(200, { outcome: 'cancelled', providerStatus: 'CANC' })
    const result = await provider(agent).cancelPayment({ ...CTX, psuIpAddress: null, psuUserAgent: null }, 'pay-1', 'swedish-giro')
    expect(result).toEqual({ outcome: 'cancelled', providerStatus: 'CANC', unsigned: false })
    expect(sentBody(agent).idempotencyKey).toMatch(/^cancel:pay-1:/)
    expect(sentBody(agent).idempotencyKey).not.toBe(sentBody(person).idempotencyKey)
    // The same caller asking again is a new cancel too: the first answer is not replayed.
    const again = fetchAnswering(200, { outcome: 'cancelled', providerStatus: 'CANC' })
    await provider(again).cancelPayment(CTX, 'pay-1', 'swedish-giro')
    expect(sentBody(again).idempotencyKey).not.toBe(sentBody(person).idempotencyKey)
  })

  it('says whether the bank holds the payment unsigned when it refuses a cancel (crm#1282)', async () => {
    for (const [providerStatus, unsigned] of [
      ['RCVD', true],
      ['PDNG', true],
      ['rcvd', true],
      ['ACTC', false],
      ['PATC', false],
      ['ACSC', false],
      [null, false],
    ] as const) {
      const result = await provider(fetchAnswering(200, { outcome: 'too_late', providerStatus })).cancelPayment(CTX, 'pay-1', 'swedish-giro')
      expect(result, String(providerStatus)).toEqual({ outcome: 'too_late', providerStatus, unsigned })
    }
    expect(isUnsignedProviderStatus(undefined)).toBe(false)
  })

  it('keeps a cancel key for an Open Payments payment id inside the contract', () => {
    const key = cancelIdempotencyKey('7b0e2c1a-5d4f-4e8a-9c3b-2a1f0e9d8c7b')
    expect(key.length).toBeLessThanOrEqual(128)
  })

  it('getBankCapabilities asks for the debtor bank and keeps only what the port needs', async () => {
    const fetchMock = fetchAnswering(200, {
      bic: 'SWEDSESS',
      name: 'Swedbank',
      decoupled: true,
      redirect: true,
      basket: { supported: true, maxPayments: 100 },
      swedishGiro: true,
    })
    const capabilities = await provider(fetchMock).getBankCapabilities(CTX)
    expect(capabilities).toEqual({ decoupled: true, redirect: true, basket: { supported: true, maxPayments: 100 } })
    expect(sentUrl(fetchMock)).toBe('https://connect.example.se/api/connect/payments/bank')
    expect(sentBody(fetchMock)).toEqual({ bic: 'SWEDSESS' })
  })

  it('getCompanyVerification and startCompanyVerification address the company by its digits', async () => {
    const status = fetchAnswering(200, { status: 'valid', validUntil: '2027-10-03', providerStatus: 'Valid' })
    expect(await provider(status).getCompanyVerification(CTX)).toEqual({ status: 'valid', validUntil: '2027-10-03' })
    expect(sentUrl(status)).toBe('https://connect.example.se/api/connect/payments/verification')
    expect(sentBody(status)).toEqual({ orgNumber: '5595386219' })

    const start = fetchAnswering(200, { url: 'https://kyc.openbankingplatform.com/form/abc' })
    expect(await provider(start).startCompanyVerification(CTX)).toEqual({ url: 'https://kyc.openbankingplatform.com/form/abc' })
    expect(sentUrl(start)).toBe('https://connect.example.se/api/connect/payments/verification/start')
    expect(sentBody(start)).toEqual({ orgNumber: '5595386219', countryCode: 'SE' })
  })

  it('uses the 30 s default timeout unless told otherwise', () => {
    expect(PAYMENTS_CONNECT_TIMEOUT_MS).toBe(30_000)
  })

  it('refuses a request that breaks the contract before sending it', async () => {
    const fetchMock = vi.fn()
    const error = await failure(provider(fetchMock).createPayment({ ...CTX, debtorBic: '' }, INSTRUCTION))
    expect(error.code).toBe('CONNECTOR_REQUEST_INVALID')
    expect(error.retryable).toBe(false)
    expect(error.outcomeUnknown).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats an answer that breaks the contract as a protocol error, never retried', async () => {
    const error = await failure(provider(fetchAnswering(200, { nope: 1 })).getPaymentState(CTX, 'pay-1', 'domestic'))
    expect(error.code).toBe('CONNECTOR_PROTOCOL_ERROR')
    expect(error.retryable).toBe(false)
    expect(error.httpStatus).toBe(200)
  })
})

describe('toPaymentProviderError', () => {
  const call = (code: string, options: { status?: number; retryable?: boolean; providerCode?: string | null } = {}) =>
    new ConnectorCallError(`Connector: ${code}`, { code, retryable: options.retryable ?? false, status: options.status ?? 400, providerCode: options.providerCode })

  it('holds the order when the service lost a write', () => {
    const error = toPaymentProviderError(call('CONNECTOR_PAYMENTS_OUTCOME_UNKNOWN', { status: 502 }), 'createPayment')
    expect(error).toMatchObject({ code: 'CONNECTOR_PAYMENTS_OUTCOME_UNKNOWN', retryable: false, outcomeUnknown: true, httpStatus: 502 })
    expect(providerWriteOutcome(error)).toBe('unknown')
  })

  it('holds the order when the service was unreachable after a write, and retries after a read', () => {
    const unreachable = new ConnectorCallError('Connector: could not reach the service', { code: CONNECTOR_UNREACHABLE_CODE, retryable: true })
    for (const operation of ['createPayment', 'cancelPayment', 'createBasket', 'startSigning'] as const) {
      const error = toPaymentProviderError(unreachable, operation)
      expect(error.outcomeUnknown, operation).toBe(true)
      expect(error.retryable, operation).toBe(false)
      expect(providerWriteOutcome(error)).toBe('unknown')
    }
    for (const operation of ['paymentStatus', 'basketStatus', 'pollSigning', 'bank', 'verification', 'startVerification'] as const) {
      const error = toPaymentProviderError(unreachable, operation)
      expect(error.outcomeUnknown, operation).toBe(false)
      expect(error.retryable, operation).toBe(true)
    }
  })

  it('holds the order while another attempt holds the idempotency lease', () => {
    const error = toPaymentProviderError(call('CONNECTOR_IDEMPOTENCY_IN_FLIGHT', { status: 409, retryable: true }), 'createPayment')
    expect(error).toMatchObject({ outcomeUnknown: true, retryable: false })
  })

  it('names a payment the bank does not know with the port constant', () => {
    const error = toPaymentProviderError(call('CONNECTOR_PAYMENTS_NOT_FOUND', { status: 404 }), 'paymentStatus')
    expect(error).toMatchObject({ code: PAYMENT_NOT_FOUND, retryable: false, outcomeUnknown: false, httpStatus: 404 })
  })

  it('carries the provider code of a refusal, or PAYMENT_REFUSED without one', () => {
    expect(toPaymentProviderError(call('CONNECTOR_PAYMENTS_REFUSED', { status: 422, providerCode: 'OCR_REF_INVALID' }), 'createPayment')).toMatchObject({
      code: 'OCR_REF_INVALID',
      retryable: false,
      outcomeUnknown: false,
    })
    expect(toPaymentProviderError(call('CONNECTOR_PAYMENTS_REFUSED', { status: 422 }), 'createPayment').code).toBe(PAYMENT_REFUSED)
    expect(providerWriteOutcome(toPaymentProviderError(call('CONNECTOR_PAYMENTS_REFUSED', { status: 422 }), 'createPayment'))).toBe('refused')
  })

  it('retries later after a provider failure, a rate limit or a bare 5xx', () => {
    for (const code of ['CONNECTOR_PAYMENTS_PROVIDER_FAILED', 'CONNECTOR_RATE_LIMITED', 'HTTP_502', 'HTTP_503', 'HTTP_429']) {
      const error = toPaymentProviderError(call(code, { status: 502 }), 'createPayment')
      expect(error.retryable, code).toBe(true)
      expect(error.outcomeUnknown, code).toBe(false)
      expect(providerWriteOutcome(error)).toBe('not_sent')
    }
  })

  it('retries after a short wait when the bank throttles, a write included: nothing reached the bank', () => {
    for (const operation of ['createPayment', 'paymentStatus', 'startSigning', 'cancelPayment'] as const) {
      const error = toPaymentProviderError(call('CONNECTOR_BANK_THROTTLED', { status: 429, retryable: true }), operation)
      expect(error.code, operation).toBe('CONNECTOR_BANK_THROTTLED')
      expect(error.retryable, operation).toBe(true)
      expect(error.outcomeUnknown, operation).toBe(false)
      expect(providerWriteOutcome(error), operation).toBe('not_sent')
    }
  })

  it('leaves configuration, scope, key, mismatch and request errors final', () => {
    for (const code of [
      'CONNECTOR_PAYMENTS_PROVIDER_UNAVAILABLE',
      'CONNECTOR_SCOPE_MISSING',
      'CONNECTOR_KEY_INVALID',
      'CONNECTOR_CONTRACT_VERSION_UNSUPPORTED',
      'CONNECTOR_IDEMPOTENCY_MISMATCH',
      'CONNECTOR_REQUEST_INVALID',
      'CONNECTOR_PROTOCOL_ERROR',
      'HTTP_400',
    ]) {
      const error = toPaymentProviderError(call(code, { status: 503 }), 'createPayment')
      expect(error.code, code).toBe(code)
      expect(error.retryable, code).toBe(false)
      expect(error.outcomeUnknown, code).toBe(false)
    }
  })

  it('passes a PaymentProviderError through and holds a write after an unexpected error', () => {
    const own = new PaymentProviderError('x', 'X', true)
    expect(toPaymentProviderError(own, 'createPayment')).toBe(own)
    const write = toPaymentProviderError(new TypeError('boom'), 'createPayment')
    expect(write).toMatchObject({ code: 'CONNECTOR_FAILED', retryable: false, outcomeUnknown: true })
    const read = toPaymentProviderError(new TypeError('boom'), 'paymentStatus')
    expect(read).toMatchObject({ code: 'CONNECTOR_FAILED', retryable: false, outcomeUnknown: false })
  })

  it('maps every operation of the contract to a write or a read', () => {
    const operations = Object.keys(PAYMENTS_OPERATIONS) as PaymentsOperation[]
    expect(operations).toHaveLength(12)
    const unreachable = new ConnectorCallError('x', { code: CONNECTOR_UNREACHABLE_CODE, retryable: true })
    const writes = operations.filter((op) => toPaymentProviderError(unreachable, op).outcomeUnknown)
    expect(writes.sort()).toEqual(['cancelPayment', 'createBasket', 'createPayment', 'startSigning'])
  })
})
