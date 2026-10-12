import { describe, expect, it } from 'vitest'
import {
  AIS_BASE_PATH,
  AIS_COUNTED_READ_OPERATIONS,
  AIS_ERROR_CODES,
  AIS_OPERATIONS,
  AIS_SCOPE,
  CONNECTIONS_CALLBACK_URL,
  CONNECTOR_ERROR_CODES,
  CONTRACT_VERSION,
  aisAccountSchema,
  aisConsentSigningProgressSchema,
  aisCreateConsentRequestSchema,
  aisPartySchema,
  bankSyncResponseSchema,
  normalizedBankTransactionSchema,
  signingReturnQuerySchema,
} from '../index'

const party = {
  orgNumber: '5595386219',
  accountContext: 'corporate',
  bic: 'SWEDSESS',
  personalNumber: '199001011239',
  psuIpAddress: null,
  psuUserAgent: null,
}

describe('AIS family', () => {
  it('is the 2026-10-13 contract under /api/connect/ais with the bank_sync scope', () => {
    expect(CONTRACT_VERSION).toBe('2026-10-13')
    expect(AIS_BASE_PATH).toBe('/api/connect/ais')
    expect(AIS_SCOPE).toBe('bank_sync')
  })

  it('names every operation as a company-scoped POST under the agreed paths', () => {
    expect(Object.fromEntries(Object.entries(AIS_OPERATIONS).map(([name, op]) => [name, op.path]))).toEqual({
      banks: '/banks',
      bank: '/bank',
      createConsent: '/consents',
      startConsentSigning: '/consents/signings',
      pollConsentSigning: '/consents/signings/poll',
      consentStatus: '/consents/status',
      accounts: '/accounts',
      balances: '/accounts/balances',
      syncTransactions: '/sync',
      revokeConsent: '/consents/revoke',
    })
    for (const [name, op] of Object.entries(AIS_OPERATIONS)) {
      expect(op.method, name).toBe('POST')
      expect(op.company, name).toBe(true)
      expect(typeof op.request.safeParse).toBe('function')
      expect(typeof op.response.safeParse).toBe('function')
    }
    expect(AIS_COUNTED_READ_OPERATIONS).toEqual(['accounts', 'balances', 'syncTransactions'])
    for (const code of AIS_ERROR_CODES) expect(CONNECTOR_ERROR_CODES).toContain(code)
  })

  it('takes the party with an optional savings bank and refuses a malformed one', () => {
    expect(aisPartySchema.safeParse(party).success).toBe(true)
    expect(aisPartySchema.safeParse({ ...party, affiliatedAspspId: '08999' }).success).toBe(true)
    expect(aisPartySchema.safeParse({ ...party, affiliatedAspspId: null }).success).toBe(true)
    expect(aisPartySchema.safeParse({ ...party, orgNumber: '559538-6219' }).success).toBe(false)
    expect(aisPartySchema.safeParse({ ...party, personalNumber: '9001011239' }).success).toBe(false)
    expect(aisCreateConsentRequestSchema.safeParse({ party, accounts: [{ iban: 'SE8050000000052131234567' }] }).success).toBe(true)
  })

  it('starts a signing in our screen without a return, and on the bank\'s page only with an https returnUrl and a returnState', () => {
    const start = AIS_OPERATIONS.startConsentSigning.request
    expect(start.safeParse({ party, consentId: 'c-1', method: 'qr' }).success).toBe(true)
    expect(start.safeParse({ party, consentId: 'c-1', method: 'same_device' }).success).toBe(true)
    expect(start.safeParse({ party, consentId: 'c-1', method: 'redirect' }).success).toBe(false)
    expect(start.safeParse({ party, consentId: 'c-1', method: 'redirect', returnUrl: 'https://app.accounted.se/settings/connections?bank_connect=c-1' }).success).toBe(false)
    expect(start.safeParse({ party, consentId: 'c-1', method: 'redirect', returnUrl: 'https://app.accounted.se/settings/connections?bank_connect=c-1', returnState: 'c-1' }).success).toBe(true)
    expect(start.safeParse({ party, consentId: 'c-1', method: 'redirect', returnUrl: 'http://app.accounted.se/x', returnState: 'c-1' }).success).toBe(false)
    expect(start.safeParse({ party, consentId: 'c-1', method: 'redirect', returnUrl: 'https://app.accounted.se/x', returnState: 'x'.repeat(129) }).success).toBe(false)
    // The query the browser carries back: state and result, a code only as a bare token.
    expect(signingReturnQuerySchema.safeParse({ state: 'c-1', result: 'ok' }).success).toBe(true)
    expect(signingReturnQuerySchema.safeParse({ state: 'c-1', result: 'error', code: 'access_denied' }).success).toBe(true)
    expect(signingReturnQuerySchema.safeParse({ state: 'c-1', result: 'error', code: 'not a code' }).success).toBe(false)
    expect(signingReturnQuerySchema.safeParse({ state: 'c-1', result: 'maybe' }).success).toBe(false)
    expect(CONNECTIONS_CALLBACK_URL).toBe('https://connect.accounted.se/api/connections/callback')
    expect(
      AIS_OPERATIONS.startConsentSigning.response.safeParse({
        providerAuthorisationId: 'a-1', method: 'redirect', state: 'pending',
        challenge: { approach: 'redirect', autostartToken: null, qrData: null, qrImage: null, redirectUrl: 'https://bank.example/sign' },
        failureCode: null, scaStatus: null,
      }).success,
    ).toBe(true)
  })

  it('round-trips a signing poll, an account and a transactions page with the AIS extras', () => {
    expect(
      aisConsentSigningProgressSchema.safeParse({
        state: 'partially_authorised', challenge: null, failureCode: null, scaStatus: 'finalised', consentStatus: 'partiallyAuthorised', validUntil: null,
      }).success,
    ).toBe(true)
    expect(aisConsentSigningProgressSchema.safeParse({ state: 'done', challenge: null, failureCode: null, scaStatus: null, consentStatus: null, validUntil: null }).success).toBe(false)
    expect(
      aisAccountSchema.safeParse({
        uid: 'ACC003', currency: 'SEK', iban: null, bban: null, name: null, usage: 'PRIV', ownerName: null, bankgiro: null, plusgiro: null, balance: null, availableBalance: null,
      }).success,
    ).toBe(true)
    const row = {
      booking_date: '2026-10-01', amount: -25, currency: 'SEK', description: 'Avgift', counterparty_name: null, counterparty_account: null,
      reference: null, merchant_category_code: null, bank_transaction_code: null, proprietary_bank_transaction_code: null,
    }
    expect(normalizedBankTransactionSchema.safeParse(row).success).toBe(true)
    expect(normalizedBankTransactionSchema.safeParse({ ...row, end_to_end_id: 'E2E', counterparty_iban: 'SE1', value_date: '2026-10-01', provider_transaction_id: 'T' }).success).toBe(true)
    const page = { transactions: [row], raw_pages: [], skipped_pending: 0, returned_min_booking_date: null, returned_max_booking_date: null, effective_date_from: null, pages: 0 }
    expect(bankSyncResponseSchema.safeParse(page).success).toBe(true)
    expect(bankSyncResponseSchema.safeParse({ ...page, truncated: true, pagingLoop: false, duplicates: 2, conflicts: 0 }).success).toBe(true)
    expect(bankSyncResponseSchema.safeParse({ ...page, duplicates: -1 }).success).toBe(false)
  })
})
