import { describe, expect, it } from 'vitest'
import {
  CONNECTOR_ERROR_CODES,
  CONNECTOR_HEADERS,
  CONNECTOR_KEY_PREFIX,
  CONTRACT_VERSION,
  PAYMENTS_BASE_PATH,
  PAYMENTS_OPERATIONS,
  PAYMENTS_SCOPE,
  PAYMENTS_WRITE_OPERATIONS,
  PEPPOL_OPERATIONS,
  bankSyncRequestSchema,
  bankSyncResponseSchema,
  connectorEntitlementsSchema,
  connectorErrorSchema,
  connectorSyncReportSchema,
  peppolInboundMessageSchema,
  peppolLookupResultSchema,
  peppolParticipantSchema,
  peppolRecipientRegistrationRequestSchema,
  peppolSubmissionSchema,
  paymentsCreateRequestSchema,
  paymentsCreatedSchema,
  paymentsPartySchema,
  paymentsSigningStartRequestSchema,
  paymentsSigningStartedSchema,
  paymentsVerificationStartRequestSchema,
} from '../index'

const participant = { scheme: '0007', identifier: '5561234567' }

describe('contract constants', () => {
  it('pins the version as a date and the key prefix as the frozen wire format', () => {
    expect(CONTRACT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(CONNECTOR_KEY_PREFIX).toBe('gnubok_ck_')
  })

  it('lists every operation with a method, path and schemas', () => {
    for (const [name, op] of Object.entries(PEPPOL_OPERATIONS)) {
      expect(op.path.startsWith('/'), name).toBe(true)
      expect(['POST', 'PUT', 'DELETE']).toContain(op.method)
      expect(typeof op.request.safeParse).toBe('function')
      expect(typeof op.response.safeParse).toBe('function')
    }
    expect(new Set(CONNECTOR_ERROR_CODES).size).toBe(CONNECTOR_ERROR_CODES.length)
  })

  it('names the unreadable upstream answer and the duplicate invoice number', () => {
    expect(CONNECTOR_ERROR_CODES).toContain('CONNECTOR_UPSTREAM_SHAPE')
    expect(CONNECTOR_ERROR_CODES).toContain('PEPPOL_DUPLICATE_INVOICE_NUMBER')
  })
})

describe('entitlements and errors', () => {
  it('round-trips the entitlements and sync payloads', () => {
    expect(
      connectorEntitlementsSchema.safeParse({
        status: 'active',
        scopes: ['bank_sync', 'peppol'],
        current_period_end: null,
        org_number: '5561234567',
        instance_url: null,
        server_time: '2026-09-02T12:00:00Z',
      }).success,
    ).toBe(true)
    expect(connectorEntitlementsSchema.safeParse({ status: 'gone', scopes: [] }).success).toBe(false)
    expect(connectorSyncReportSchema.safeParse({ active_company_count: 3 }).success).toBe(true)
    expect(connectorSyncReportSchema.safeParse({ active_company_count: -1 }).success).toBe(false)
  })

  it('accepts the error envelope with or without the retry hint', () => {
    expect(connectorErrorSchema.safeParse({ error: 'x', code: 'CONNECTOR_NOT_OWNED' }).success).toBe(true)
    expect(connectorErrorSchema.safeParse({ error: 'x', code: 'CONNECTOR_UPSTREAM_ERROR', retryable: true, detail: null }).success).toBe(true)
    expect(connectorErrorSchema.safeParse({ code: 'x' }).success).toBe(false)
  })
})

describe('peppol schemas', () => {
  it('validates participants as four-digit ICD scheme plus identifier', () => {
    expect(peppolParticipantSchema.safeParse(participant).success).toBe(true)
    expect(peppolParticipantSchema.safeParse({ scheme: '007', identifier: 'x' }).success).toBe(false)
    expect(peppolParticipantSchema.safeParse({ scheme: 'abcd', identifier: 'x' }).success).toBe(false)
    expect(peppolParticipantSchema.safeParse({ scheme: '0007', identifier: '' }).success).toBe(false)
  })

  it('discriminates lookup results on reachable', () => {
    expect(peppolLookupResultSchema.safeParse({ reachable: true, participant, capabilities: [], checkedAt: 't' }).success).toBe(true)
    expect(peppolLookupResultSchema.safeParse({ reachable: false, participant, reasonCode: 'participant_not_found', checkedAt: 't' }).success).toBe(true)
    expect(peppolLookupResultSchema.safeParse({ reachable: false, participant, checkedAt: 't' }).success).toBe(false)
  })

  it('requires an XML submission with a hex sha256 and rejects non-xml content types', () => {
    const base = {
      idempotencyKey: 'k',
      tenantReference: 'c',
      sender: participant,
      recipient: participant,
      documentTypeId: 'd',
      processId: 'p',
      filename: 'f.xml',
      contentType: 'application/xml',
      document: '<Invoice/>',
      documentSha256: 'a'.repeat(64),
    }
    expect(peppolSubmissionSchema.safeParse(base).success).toBe(true)
    expect(peppolSubmissionSchema.safeParse({ ...base, contentType: 'application/json' }).success).toBe(false)
    expect(peppolSubmissionSchema.safeParse({ ...base, documentSha256: 'zz' }).success).toBe(false)
  })

  it('accepts an optional replacesSubmissionId for a resend, bounded like a submission id', () => {
    const base = {
      idempotencyKey: 'k',
      tenantReference: 'c',
      sender: participant,
      recipient: participant,
      documentTypeId: 'd',
      processId: 'p',
      filename: 'f.xml',
      contentType: 'application/xml',
      document: '<Invoice/>',
      documentSha256: 'a'.repeat(64),
    }
    const resend = peppolSubmissionSchema.safeParse({ ...base, replacesSubmissionId: 'int-1' })
    expect(resend.success).toBe(true)
    expect(resend.data?.replacesSubmissionId).toBe('int-1')
    expect(peppolSubmissionSchema.safeParse(base).data).not.toHaveProperty('replacesSubmissionId')
    expect(peppolSubmissionSchema.safeParse({ ...base, replacesSubmissionId: '' }).success).toBe(false)
    expect(peppolSubmissionSchema.safeParse({ ...base, replacesSubmissionId: 'x'.repeat(129) }).success).toBe(false)
    expect(peppolSubmissionSchema.safeParse({ ...base, replacesSubmissionId: null }).success).toBe(false)
  })

  it('validates registrations and inbound messages', () => {
    expect(
      peppolRecipientRegistrationRequestSchema.safeParse({
        participant,
        businessCard: { companyName: 'AB', countryCode: 'SE' },
        documentTypes: [{ processId: 'p', documentTypeId: 'd' }],
      }).success,
    ).toBe(true)
    expect(
      peppolRecipientRegistrationRequestSchema.safeParse({ participant, businessCard: { companyName: 'AB', countryCode: 'SWE' }, documentTypes: [] }).success,
    ).toBe(false)
    expect(
      peppolInboundMessageSchema.safeParse({ provider: 'qvalia', providerDocumentId: 'doc-1', documentType: 'Invoice', payload: {}, receivedAt: null }).success,
    ).toBe(true)
    expect(peppolInboundMessageSchema.safeParse({ provider: 'qvalia', providerDocumentId: 'doc-1', documentType: 'Order', payload: {} }).success).toBe(false)
  })

  it('accepts an optional receivedAfter cursor on the inbound listing and strips keys it does not know', () => {
    const schema = PEPPOL_OPERATIONS.inboundList.request
    expect(schema.safeParse({ documentType: 'Invoice' }).success).toBe(true)
    expect(schema.safeParse({ documentType: 'Invoice', receivedAfter: '2026-09-01T00:00:00.000Z' }).success).toBe(true)
    expect(schema.safeParse({ documentType: 'Invoice', receivedAfter: '2026-09-01T00:00:00+02:00' }).success).toBe(true)
    expect(schema.safeParse({ documentType: 'Invoice', receivedAfter: '2026-09-01' }).success).toBe(false)
    expect(schema.safeParse({ documentType: 'Invoice', receivedAfter: 'yesterday' }).success).toBe(false)
    // A service on an older contract ignores the cursor rather than refusing the call.
    const parsed = schema.safeParse({ documentType: 'Invoice', someFutureField: 1 })
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual({ documentType: 'Invoice' })
  })
})

describe('bank sync operation', () => {
  it('validates the request and response shapes', () => {
    expect(bankSyncRequestSchema.safeParse({ session_id: 's', account_uid: 'a', account_currency: 'SEK', date_from: '2026-08-01', date_to: '2026-09-03', strategy: 'longest' }).success).toBe(true)
    expect(bankSyncRequestSchema.safeParse({ session_id: 's', account_uid: 'a', account_currency: 'SEKK' }).success).toBe(false)
    expect(bankSyncRequestSchema.safeParse({ session_id: 's', account_uid: 'a', account_currency: 'SEK', date_from: '2026/08/01' }).success).toBe(false)
    expect(bankSyncRequestSchema.safeParse({ session_id: 's', account_uid: 'a', account_currency: 'SEK', date_from: '2026-02-30' }).success).toBe(false)
    expect(bankSyncResponseSchema.safeParse({ transactions: [{ booking_date: '', amount: 1, currency: 'SEK', description: 'x', counterparty_name: null, counterparty_account: null, reference: null, merchant_category_code: null, bank_transaction_code: null, proprietary_bank_transaction_code: null }], raw_pages: [], skipped_pending: 0, returned_min_booking_date: null, returned_max_booking_date: null, effective_date_from: null, pages: 0 }).success).toBe(false)
    expect(
      bankSyncResponseSchema.safeParse({
        transactions: [{ booking_date: '2026-09-01', amount: -12.5, currency: 'SEK', description: 'x', counterparty_name: null, counterparty_account: null, reference: null, merchant_category_code: null, bank_transaction_code: null, proprietary_bank_transaction_code: null }],
        raw_pages: ['{}'], skipped_pending: 0, returned_min_booking_date: '2026-09-01', returned_max_booking_date: '2026-09-01', effective_date_from: null, pages: 1,
      }).success,
    ).toBe(true)
  })

  it('takes the value date, the bank id and the raw page index, and still takes a row without them', () => {
    const row = { booking_date: '2026-09-01', amount: -12.5, currency: 'SEK', description: 'x', counterparty_name: null, counterparty_account: null, reference: '1001000000017', merchant_category_code: null, bank_transaction_code: null, proprietary_bank_transaction_code: null }
    const response = (extra: Record<string, unknown>) => ({
      transactions: [{ ...row, ...extra }],
      raw_pages: ['{}'], skipped_pending: 0, returned_min_booking_date: '2026-09-01', returned_max_booking_date: '2026-09-01', effective_date_from: null, pages: 1,
    })
    const full = bankSyncResponseSchema.safeParse(response({ value_date: '2026-09-02', provider_transaction_id: 'ENTRY-1', raw_page_index: 0 }))
    expect(full.success && full.data.transactions[0]).toMatchObject({ value_date: '2026-09-02', provider_transaction_id: 'ENTRY-1', raw_page_index: 0 })
    expect(bankSyncResponseSchema.safeParse(response({})).success).toBe(true)
    expect(bankSyncResponseSchema.safeParse(response({ value_date: null, provider_transaction_id: null, raw_page_index: null })).success).toBe(true)
    expect(bankSyncResponseSchema.safeParse(response({ value_date: '2026-09-31' })).success).toBe(false)
    expect(bankSyncResponseSchema.safeParse(response({ raw_page_index: -1 })).success).toBe(false)
    expect(bankSyncResponseSchema.safeParse(response({ raw_page_index: 0.5 })).success).toBe(false)
  })
})

describe('payments family', () => {
  const party = {
    orgNumber: '5595386219',
    accountContext: 'corporate',
    debtorBic: 'SWEDSESS',
    signerPersonalNumber: '199001011239',
    psuIpAddress: '203.0.113.10',
    psuUserAgent: 'UA',
  }
  const instruction = {
    endToEndId: 'E2E-1',
    amount: 100,
    currency: 'SEK',
    requestedExecutionDate: '2026-10-12',
    debtor: { iban: 'SE6380000832798443379915', bban: null, currency: 'SEK' },
    payee: { type: 'bankgiro', bankgiro: '5050-1055', name: 'Leverantören AB' },
    reference: { type: 'ocr', value: '12345678901' },
  }

  it('names the family, its scope, the version header and the connection header', () => {
    expect(PAYMENTS_BASE_PATH).toBe('/api/connect/payments')
    expect(PAYMENTS_SCOPE).toBe('payments')
    expect(CONNECTOR_HEADERS.contractVersion).toBe('X-Connect-Contract-Version')
    expect(CONNECTOR_HEADERS.connection).toBe('X-Connector-Connection')
    expect(CONTRACT_VERSION).toBe('2026-10-13')
  })

  it('lists every operation as a company POST with schemas, and the writes among them', () => {
    expect(Object.keys(PAYMENTS_OPERATIONS)).toHaveLength(10)
    for (const [name, op] of Object.entries(PAYMENTS_OPERATIONS)) {
      expect(op.method, name).toBe('POST')
      expect(op.company, name).toBe(true)
      expect(op.path.startsWith('/'), name).toBe(true)
      expect(typeof op.request.safeParse).toBe('function')
      expect(typeof op.response.safeParse).toBe('function')
    }
    for (const write of PAYMENTS_WRITE_OPERATIONS) {
      expect(Object.keys(PAYMENTS_OPERATIONS[write].request.shape as object)).toContain('idempotencyKey')
    }
    for (const code of ['CONNECTOR_PAYMENTS_OUTCOME_UNKNOWN', 'CONNECTOR_PAYMENTS_REFUSED', 'CONNECTOR_PAYMENTS_NOT_FOUND', 'CONNECTOR_IDEMPOTENCY_IN_FLIGHT']) {
      expect(CONNECTOR_ERROR_CODES).toContain(code)
    }
  })

  it('validates the party: digits-only identifiers, a BIC, nullable signer details', () => {
    expect(paymentsPartySchema.safeParse(party).success).toBe(true)
    expect(paymentsPartySchema.safeParse({ ...party, signerPersonalNumber: null, psuIpAddress: null, psuUserAgent: null }).success).toBe(true)
    expect(paymentsPartySchema.safeParse({ ...party, orgNumber: '559538-6219' }).success).toBe(false)
    expect(paymentsPartySchema.safeParse({ ...party, signerPersonalNumber: '19900101-1239' }).success).toBe(false)
    expect(paymentsPartySchema.safeParse({ ...party, debtorBic: 'swedsess' }).success).toBe(false)
    expect(paymentsPartySchema.safeParse({ ...party, accountContext: 'business' }).success).toBe(false)
  })

  it('validates a create request and refuses a bad payee, amount or date', () => {
    expect(paymentsCreateRequestSchema.safeParse({ idempotencyKey: 'pay:E2E-1', party, instruction }).success).toBe(true)
    expect(paymentsCreateRequestSchema.safeParse({ party, instruction }).success).toBe(false)
    expect(paymentsCreateRequestSchema.safeParse({ idempotencyKey: 'k', party, instruction: { ...instruction, amount: 0 } }).success).toBe(false)
    expect(paymentsCreateRequestSchema.safeParse({ idempotencyKey: 'k', party, instruction: { ...instruction, requestedExecutionDate: '2026-02-30' } }).success).toBe(false)
    expect(paymentsCreateRequestSchema.safeParse({ idempotencyKey: 'k', party, instruction: { ...instruction, payee: { type: 'swish', number: '123' } } }).success).toBe(false)
    expect(
      paymentsCreateRequestSchema.safeParse({ idempotencyKey: 'k', party, instruction: { ...instruction, payee: { type: 'iban', iban: 'SE1', bic: null, name: 'X' } } }).success,
    ).toBe(true)
  })

  it('validates created payments and started signings, and keeps the status vocabulary closed', () => {
    const created = { providerStatus: 'RCVD', status: 'submitted', messages: [], providerPaymentId: 'p-1', product: 'swedish-giro', sentPayeeName: null }
    expect(paymentsCreatedSchema.safeParse(created).success).toBe(true)
    expect(paymentsCreatedSchema.safeParse({ ...created, status: 'pending' }).success).toBe(false)
    const started = {
      state: 'pending',
      challenge: { approach: 'decoupled', autostartToken: 't', qrData: 'q', qrImage: null, redirectUrl: null },
      failureCode: null,
      providerAuthorisationId: 'a-1',
      method: 'qr',
    }
    expect(paymentsSigningStartedSchema.safeParse(started).success).toBe(true)
    expect(paymentsSigningStartedSchema.safeParse({ ...started, challenge: null }).success).toBe(true)
    expect(paymentsSigningStartedSchema.safeParse({ ...started, method: 'sms' }).success).toBe(false)
  })

  it('offers decoupled signing only in a start request, and defaults the verification country to SE', () => {
    const target = { kind: 'basket', providerBasketId: 'b-1' }
    expect(paymentsSigningStartRequestSchema.safeParse({ idempotencyKey: 'k', party, target, method: 'qr' }).success).toBe(true)
    expect(paymentsSigningStartRequestSchema.safeParse({ idempotencyKey: 'k', party, target, method: 'redirect' }).success).toBe(false)
    const start = paymentsVerificationStartRequestSchema.safeParse({ orgNumber: '5595386219' })
    expect(start.success).toBe(true)
    expect(start.data?.countryCode).toBe('SE')
  })
})
