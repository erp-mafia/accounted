import { describe, expect, it } from 'vitest'
import {
  CONNECTOR_ERROR_CODES,
  CONNECTOR_HEADERS,
  CONTRACT_VERSION,
  PAYMENTS_BASE_PATH,
  PAYMENTS_OPERATIONS,
  PAYMENTS_SCOPE,
  PAYMENTS_WRITE_OPERATIONS,
  connectorErrorSchema,
  paymentsCreateRequestSchema,
  paymentsPartySchema,
  paymentsSigningProgressSchema,
  paymentsSigningStartRequestSchema,
  paymentsStatusSchema,
} from '../index'

const PARTY = {
  orgNumber: '5595386219',
  accountContext: 'corporate',
  debtorBic: 'SWEDSESS',
  signerPersonalNumber: '199001011239',
  psuIpAddress: '203.0.113.10',
  psuUserAgent: 'Mozilla/5.0',
}

describe('payments family contract', () => {
  it('is dated and carries the version and connection headers', () => {
    expect(CONTRACT_VERSION).toBe('2026-10-17')
    expect(CONNECTOR_HEADERS.contractVersion).toBe('X-Connect-Contract-Version')
    expect(CONNECTOR_HEADERS.connection).toBe('X-Connector-Connection')
    expect(PAYMENTS_BASE_PATH).toBe('/api/connect/payments')
    expect(PAYMENTS_SCOPE).toBe('payments')
  })

  it('every operation is a company POST with request and response schemas; the writes are the four that create or cancel', () => {
    const paths = new Set<string>()
    for (const [name, op] of Object.entries(PAYMENTS_OPERATIONS)) {
      expect(op.method, name).toBe('POST')
      expect(op.company, name).toBe(true)
      expect(op.path.startsWith('/'), name).toBe(true)
      expect(paths.has(op.path), `${name} shares a path`).toBe(false)
      paths.add(op.path)
      expect(typeof op.request.safeParse).toBe('function')
      expect(typeof op.response.safeParse).toBe('function')
    }
    expect([...PAYMENTS_WRITE_OPERATIONS]).toEqual(['createPayment', 'cancelPayment', 'createBasket', 'startSigning'])
    for (const write of PAYMENTS_WRITE_OPERATIONS) {
      const result = PAYMENTS_OPERATIONS[write].request.safeParse({})
      expect(result.success).toBe(false)
      expect(JSON.stringify(result.error?.issues)).toContain('idempotencyKey')
    }
  })

  it('the party takes a 10-digit org number, a BIC, a 12-digit personnummer or null, and an optional affiliated bank', () => {
    expect(paymentsPartySchema.safeParse(PARTY).success).toBe(true)
    expect(paymentsPartySchema.safeParse({ ...PARTY, signerPersonalNumber: null }).success).toBe(true)
    expect(paymentsPartySchema.safeParse({ ...PARTY, affiliatedAspspId: '08191' }).success).toBe(true)
    expect(paymentsPartySchema.safeParse({ ...PARTY, affiliatedAspspId: null }).success).toBe(true)
    expect(paymentsPartySchema.safeParse({ ...PARTY, affiliatedAspspId: '' }).success).toBe(false)
    expect(paymentsPartySchema.safeParse({ ...PARTY, redirectPreferred: true }).success).toBe(true)
    expect(paymentsPartySchema.safeParse({ ...PARTY, redirectPreferred: 'true' }).success).toBe(false)
    expect(paymentsPartySchema.safeParse({ ...PARTY, orgNumber: '559538-6219' }).success).toBe(false)
    expect(paymentsPartySchema.safeParse({ ...PARTY, signerPersonalNumber: '9001011239' }).success).toBe(false)
    expect(paymentsPartySchema.safeParse({ ...PARTY, debtorBic: 'swedsess' }).success).toBe(false)
  })

  it('a payment instruction is validated field by field and the payee is a discriminated union', () => {
    const base = {
      idempotencyKey: 'pay:ACC-1',
      party: PARTY,
      instruction: {
        endToEndId: 'ACC-1',
        amount: 100,
        currency: 'SEK',
        requestedExecutionDate: '2026-10-13',
        debtor: { iban: 'SE6380000832798443379915', bban: null, currency: 'SEK' },
        payee: { type: 'bankgiro', bankgiro: '5050-1055', name: 'Telia' },
        reference: { type: 'ocr', value: '12345678906' },
      },
    }
    expect(paymentsCreateRequestSchema.safeParse(base).success).toBe(true)
    expect(paymentsCreateRequestSchema.safeParse({ ...base, instruction: { ...base.instruction, amount: 0 } }).success).toBe(false)
    expect(paymentsCreateRequestSchema.safeParse({ ...base, instruction: { ...base.instruction, requestedExecutionDate: '2026-02-30' } }).success).toBe(false)
    expect(paymentsCreateRequestSchema.safeParse({ ...base, instruction: { ...base.instruction, payee: { type: 'swish', number: '123' } } }).success).toBe(false)
    expect(
      paymentsCreateRequestSchema.safeParse({ ...base, instruction: { ...base.instruction, payee: { type: 'iban', iban: 'SE6380000832798443379915', bic: null, name: 'X' } } }).success,
    ).toBe(true)
  })

  it('signing starts are decoupled, or redirect with the return URL and state; status values are the ledger lifecycle', () => {
    const target = { kind: 'payment', providerPaymentId: 'pay-1', product: 'domestic' }
    expect(paymentsSigningStartRequestSchema.safeParse({ idempotencyKey: 'sign:1', party: PARTY, target, method: 'qr' }).success).toBe(true)
    expect(paymentsSigningStartRequestSchema.safeParse({ idempotencyKey: 'sign:1', party: PARTY, target, method: 'redirect' }).success).toBe(false)
    const redirect = { idempotencyKey: 'sign:1', party: PARTY, target, method: 'redirect', returnUrl: 'https://app.accounted.se/payments/return?order=1', returnState: 'ledger-state-1' }
    expect(paymentsSigningStartRequestSchema.safeParse(redirect).success).toBe(true)
    expect(paymentsSigningStartRequestSchema.safeParse({ ...redirect, returnUrl: 'http://app.accounted.se/return' }).success).toBe(false)
    expect(paymentsSigningStartRequestSchema.safeParse({ ...redirect, returnState: 'x'.repeat(129) }).success).toBe(false)
    const basket = { ...redirect, target: { kind: 'basket', providerBasketId: 'basket-1' } }
    expect(paymentsSigningStartRequestSchema.safeParse(basket).success).toBe(true)
    expect(paymentsStatusSchema.options).toEqual([
      'draft',
      'approved',
      'submitted',
      'awaiting_signature',
      'awaiting_second_signer',
      'accepted',
      'executed',
      'rejected',
      'cancelled',
      'failed',
    ])
  })

  it('the error envelope carries the provider code, and the payments codes are listed', () => {
    expect(connectorErrorSchema.safeParse({ error: 'x', code: 'CONNECTOR_PAYMENTS_REFUSED', retryable: false, detail: null, providerCode: 'OCR_REF_INVALID' }).success).toBe(true)
    for (const code of [
      'CONNECTOR_IDEMPOTENCY_MISMATCH',
      'CONNECTOR_IDEMPOTENCY_IN_FLIGHT',
      'CONNECTOR_PAYMENTS_PROVIDER_UNAVAILABLE',
      'CONNECTOR_PAYMENTS_OUTCOME_UNKNOWN',
      'CONNECTOR_PAYMENTS_REFUSED',
      'CONNECTOR_PAYMENTS_NOT_FOUND',
      'CONNECTOR_PAYMENTS_PROVIDER_FAILED',
    ]) {
      expect(CONNECTOR_ERROR_CODES, code).toContain(code)
    }
  })

  it('signing progress carries the bank SCA status when the connector knows it, and parses without it', () => {
    const base = { state: 'pending', challenge: null, failureCode: null }
    expect(paymentsSigningProgressSchema.parse(base)).toEqual(base)
    expect(paymentsSigningProgressSchema.parse({ ...base, scaStatus: 'authoriseCreditorAccountStarted' }).scaStatus).toBe('authoriseCreditorAccountStarted')
    expect(paymentsSigningProgressSchema.parse({ ...base, scaStatus: null }).scaStatus).toBeNull()
  })
})
