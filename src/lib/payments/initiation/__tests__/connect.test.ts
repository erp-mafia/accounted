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
  createConnectPaymentsProvider,
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
  it('registers nothing without a connector key', () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', '')
    expect(registerConnectPaymentsProvider()).toBe(false)
    expect(getPaymentInitiationProviderById('open_payments')).toBeNull()
  })

  it('registers the adapter from the connector configuration, once', () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    vi.stubEnv('GNUBOK_CONNECT_URL', 'https://connect.example.se')
    expect(registerConnectPaymentsProvider()).toBe(true)
    expect(registerConnectPaymentsProvider()).toBe(false)
    expect(getPaymentInitiationProviderById('open_payments')?.id).toBe('open_payments')
    expect(getPaymentInitiationProvider('co-1')?.id).toBe('open_payments')
    expect(getPaymentInitiationProvider('co-2')?.id).toBe('open_payments')
  })

  it('keeps a provider registered earlier under the same id', () => {
    const fake = { id: 'open_payments' } as unknown as PaymentInitiationProvider
    registerPaymentInitiationProvider(fake)
    expect(registerConnectPaymentsProvider({ upstream: UPSTREAM })).toBe(false)
    expect(getPaymentInitiationProviderById('open_payments')).toBe(fake)
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
    })
    expect(toConnectorParty({ ...CTX, signerPersonalNumber: '19900101-1239' }).signerPersonalNumber).toBe('199001011239')
    expect(toConnectorParty({ ...CTX, signerPersonalNumber: null, psuIpAddress: null, psuUserAgent: null })).toMatchObject({
      signerPersonalNumber: null,
      psuIpAddress: null,
      psuUserAgent: null,
    })
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

  it('startSigning sends a fresh key every time and maps the challenge without the image', async () => {
    const answer = { state: 'pending', challenge: CHALLENGE, failureCode: null, providerAuthorisationId: 'auth-1', method: 'qr' }
    const first = fetchAnswering(200, answer)
    const started = await provider(first).startSigning(CTX, { kind: 'basket', providerBasketId: 'bask-1' }, 'qr')
    expect(started).toEqual({
      providerAuthorisationId: 'auth-1',
      method: 'qr',
      state: 'pending',
      challenge: { approach: 'decoupled', autostartToken: 'tok', qrData: 'bankid.qr', redirectUrl: null },
      failureCode: null,
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

  it('pollSigning passes the authorisation and method and maps a finished signing', async () => {
    const fetchMock = fetchAnswering(200, { state: 'finalised', challenge: null, failureCode: null })
    const progress = await provider(fetchMock).pollSigning(CTX, { kind: 'payment', providerPaymentId: 'pay-1', product: 'domestic' }, 'auth-1', 'qr')
    expect(progress).toEqual({ state: 'finalised', challenge: null, failureCode: null })
    expect(sentUrl(fetchMock)).toBe('https://connect.example.se/api/connect/payments/signings/poll')
    expect(sentBody(fetchMock)).toEqual({
      party: toConnectorParty(CTX),
      target: { kind: 'payment', providerPaymentId: 'pay-1', product: 'domestic' },
      providerAuthorisationId: 'auth-1',
      method: 'qr',
    })
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
    expect(result).toEqual({ outcome: 'too_late', providerStatus: 'ACSC' })
    expect(sentUrl(fetchMock)).toBe('https://connect.example.se/api/connect/payments/payments/cancel')
    expect(sentBody(fetchMock)).toEqual({ idempotencyKey: 'cancel:pay-1', party: toConnectorParty(CTX), providerPaymentId: 'pay-1', product: 'swedish-giro' })
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
    expect(operations).toHaveLength(10)
    const unreachable = new ConnectorCallError('x', { code: CONNECTOR_UNREACHABLE_CODE, retryable: true })
    const writes = operations.filter((op) => toPaymentProviderError(unreachable, op).outcomeUnknown)
    expect(writes.sort()).toEqual(['cancelPayment', 'createBasket', 'createPayment', 'startSigning'])
  })
})
