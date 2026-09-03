import { describe, expect, it } from 'vitest'
import {
  CONNECTOR_ERROR_CODES,
  CONNECTOR_KEY_PREFIX,
  CONTRACT_VERSION,
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
})
