import { describe, expect, it } from 'vitest'
import {
  AIS_BASE_PATH,
  AIS_COUNTED_READ_OPERATIONS,
  AIS_ERROR_CODES,
  AIS_OPERATIONS,
  AIS_SCOPE,
  BANK_SYNC_ERROR_CODES,
  CONNECTIONS_CALLBACK_PATH,
  CONNECTIONS_CALLBACK_URL,
  CONNECTOR_ERROR_CODES,
  CONTRACT_VERSION,
  DEFAULT_CONNECT_BASE_URL,
  aisAccountSchema,
  aisBankDetailsSchema,
  aisConsentSigningProgressSchema,
  aisConsentStateSchema,
  aisConsentStatusSchema,
  aisCreateConsentRequestSchema,
  aisPartySchema,
  aisStartConsentSigningRequestSchema,
  aisSyncTransactionsRequestSchema,
  bankSyncEnrichmentSchema,
  bankSyncResponseSchema,
  bankTransactionPartSchema,
  normalizedBankTransactionSchema,
  signingReturnQuerySchema,
} from '../index'

const PARTY = {
  orgNumber: '5595386219',
  accountContext: 'corporate',
  bic: 'SWEDSESS',
  personalNumber: '199001011239',
  psuIpAddress: '203.0.113.10',
  psuUserAgent: 'Mozilla/5.0',
}

const ROW = {
  booking_date: '2026-09-28',
  amount: -29,
  currency: 'SEK',
  description: 'BANK FEE',
  counterparty_name: null,
  counterparty_account: null,
  reference: null,
  merchant_category_code: null,
  bank_transaction_code: null,
  proprietary_bank_transaction_code: 'Bank fee',
}

const SYNC = {
  transactions: [ROW],
  raw_pages: ['{}'],
  skipped_pending: 0,
  returned_min_booking_date: '2026-09-28',
  returned_max_booking_date: '2026-09-28',
  effective_date_from: null,
  pages: 1,
}

describe('AIS family contract', () => {
  it('is dated 2026-10-17, lives under /api/connect/ais and shares the bank_sync scope', () => {
    expect(CONTRACT_VERSION).toBe('2026-10-17')
    expect(AIS_BASE_PATH).toBe('/api/connect/ais')
    expect(AIS_SCOPE).toBe('bank_sync')
  })

  it('every operation is a company POST with request and response schemas, on its own path', () => {
    const paths = new Set<string>()
    for (const [name, op] of Object.entries(AIS_OPERATIONS)) {
      expect(op.method, name).toBe('POST')
      expect(op.company, name).toBe(true)
      expect(op.path.startsWith('/'), name).toBe(true)
      expect(paths.has(op.path), `${name} shares a path`).toBe(false)
      paths.add(op.path)
      expect(typeof op.request.safeParse).toBe('function')
      expect(typeof op.response.safeParse).toBe('function')
    }
    expect(Object.keys(AIS_OPERATIONS)).toEqual([
      'banks',
      'bank',
      'createConsent',
      'startConsentSigning',
      'pollConsentSigning',
      'consentStatus',
      'accounts',
      'balances',
      'syncTransactions',
      'revokeConsent',
    ])
    expect([...AIS_COUNTED_READ_OPERATIONS]).toEqual(['accounts', 'balances', 'syncTransactions'])
  })

  it('every operation but banks and bank carries the party; no operation carries an idempotency key', () => {
    for (const [name, op] of Object.entries(AIS_OPERATIONS)) {
      const result = op.request.safeParse({})
      const issues = JSON.stringify(result.success ? [] : result.error.issues)
      if (name === 'banks') {
        expect(result.success, name).toBe(true)
      } else if (name === 'bank') {
        expect(issues, name).toContain('bic')
        expect(issues, name).not.toContain('party')
      } else {
        expect(issues, name).toContain('party')
      }
      expect(issues, name).not.toContain('idempotencyKey')
    }
  })

  it('the party takes a 10-digit org number, a BIC, a 12-digit personnummer or null, and an optional affiliated bank', () => {
    expect(aisPartySchema.safeParse(PARTY).success).toBe(true)
    expect(aisPartySchema.safeParse({ ...PARTY, personalNumber: null, psuIpAddress: null, psuUserAgent: null }).success).toBe(true)
    expect(aisPartySchema.safeParse({ ...PARTY, affiliatedAspspId: '08191' }).success).toBe(true)
    expect(aisPartySchema.safeParse({ ...PARTY, affiliatedAspspId: null }).success).toBe(true)
    expect(aisPartySchema.safeParse({ ...PARTY, affiliatedAspspId: '' }).success).toBe(false)
    expect(aisPartySchema.safeParse({ ...PARTY, redirectPreferred: true }).success).toBe(true)
    expect(aisPartySchema.safeParse({ ...PARTY, redirectPreferred: 'true' }).success).toBe(false)
    expect(aisPartySchema.safeParse({ ...PARTY, orgNumber: '559538-6219' }).success).toBe(false)
    expect(aisPartySchema.safeParse({ ...PARTY, personalNumber: '9001011239' }).success).toBe(false)
    expect(aisPartySchema.safeParse({ ...PARTY, bic: 'swedsess' }).success).toBe(false)
    expect(aisPartySchema.safeParse({ ...PARTY, accountContext: 'business' }).success).toBe(false)
  })

  it('a consent may name its accounts and its last day; a signing start is decoupled, or redirect with the return URL and state', () => {
    expect(aisCreateConsentRequestSchema.safeParse({ party: PARTY }).success).toBe(true)
    expect(aisCreateConsentRequestSchema.safeParse({ party: PARTY, validUntil: '2027-03-29', accounts: [{ iban: 'SE7750000000056990607246' }] }).success).toBe(true)
    expect(aisCreateConsentRequestSchema.safeParse({ party: PARTY, validUntil: '2027-02-30' }).success).toBe(false)
    expect(aisCreateConsentRequestSchema.safeParse({ party: PARTY, accounts: [{ iban: '' }] }).success).toBe(false)
    expect(aisStartConsentSigningRequestSchema.safeParse({ party: PARTY, consentId: 'c-1', method: 'qr' }).success).toBe(true)
    expect(aisStartConsentSigningRequestSchema.safeParse({ party: PARTY, consentId: 'c-1', method: 'same_device' }).success).toBe(true)
    const redirect = { party: PARTY, consentId: 'c-1', method: 'redirect', returnUrl: 'https://app.accounted.se/connections/return?connection=1', returnState: 'ledger-state-1' }
    expect(aisStartConsentSigningRequestSchema.safeParse(redirect).success).toBe(true)
    // Redirect without the return: the issues name both fields.
    const missing = aisStartConsentSigningRequestSchema.safeParse({ party: PARTY, consentId: 'c-1', method: 'redirect' })
    expect(missing.success).toBe(false)
    expect(missing.error?.issues.map((i) => i.path.join('.')).sort()).toEqual(['returnState', 'returnUrl'])
    expect(aisStartConsentSigningRequestSchema.safeParse({ ...redirect, returnUrl: 'http://app.accounted.se/return' }).success).toBe(false)
    expect(aisStartConsentSigningRequestSchema.safeParse({ ...redirect, returnUrl: 'not a url' }).success).toBe(false)
    expect(aisStartConsentSigningRequestSchema.safeParse({ ...redirect, returnState: '' }).success).toBe(false)
    expect(aisStartConsentSigningRequestSchema.safeParse({ ...redirect, returnState: 'x'.repeat(129) }).success).toBe(false)
    // The return fields ride along with a decoupled start without harm.
    expect(aisStartConsentSigningRequestSchema.safeParse({ ...redirect, method: 'qr' }).success).toBe(true)
  })

  it('the redirect callback lives on the connect origin, and the return query carries the state, the result and a code on error', () => {
    expect(CONNECTIONS_CALLBACK_PATH).toBe('/api/connections/callback')
    expect(CONNECTIONS_CALLBACK_URL).toBe(`${DEFAULT_CONNECT_BASE_URL}/api/connections/callback`)
    expect(CONNECTIONS_CALLBACK_URL).toBe('https://connect.accounted.se/api/connections/callback')
    expect(signingReturnQuerySchema.safeParse({ state: 'ledger-state-1', result: 'ok' }).success).toBe(true)
    expect(signingReturnQuerySchema.safeParse({ state: 'ledger-state-1', result: 'error', code: 'access_denied' }).success).toBe(true)
    expect(signingReturnQuerySchema.safeParse({ state: 'ledger-state-1', result: 'error', code: 'TOKEN_INVALID_GRANT' }).success).toBe(true)
    expect(signingReturnQuerySchema.safeParse({ state: 'ledger-state-1', result: 'done' }).success).toBe(false)
    expect(signingReturnQuerySchema.safeParse({ result: 'ok' }).success).toBe(false)
    expect(signingReturnQuerySchema.safeParse({ state: 'ledger-state-1', result: 'error', code: 'the user cancelled' }).success).toBe(false)
  })

  it('signing progress and consent status know the second signer; the consent state knows over', () => {
    expect(aisConsentSigningProgressSchema.shape.state.options).toEqual(['pending', 'valid', 'partially_authorised', 'failed'])
    expect(aisConsentStateSchema.options).toEqual(['pending', 'valid', 'partially_authorised', 'over'])
    const progress = { state: 'partially_authorised', challenge: null, failureCode: null, scaStatus: 'finalised', consentStatus: 'partiallyAuthorised', validUntil: null }
    expect(aisConsentSigningProgressSchema.parse(progress)).toEqual(progress)
    expect(aisConsentStatusSchema.safeParse({ consentStatus: 'expired', state: 'over', validUntil: '2026-10-01' }).success).toBe(true)
    expect(aisConsentStatusSchema.safeParse({ consentStatus: 'valid', state: 'ok', validUntil: null }).success).toBe(false)
  })

  it('bank details carry the history window and the affiliated banks, nulls allowed', () => {
    const details = {
      bic: 'SWEDSESS',
      name: 'Swedbank',
      decoupled: true,
      redirect: true,
      transactionHistoryMaxDays: 88,
      extendedTransactionHistoryMaxDays: 760,
      extendedTransactionHistoryAvailableWindowMinutes: 60,
      affiliates: [{ id: '08191', name: 'Sparbanken Bergslagen AB' }],
    }
    expect(aisBankDetailsSchema.parse(details)).toEqual(details)
    expect(
      aisBankDetailsSchema.safeParse({
        ...details,
        bic: 'SVEASESS',
        decoupled: null,
        redirect: null,
        transactionHistoryMaxDays: null,
        extendedTransactionHistoryMaxDays: null,
        extendedTransactionHistoryAvailableWindowMinutes: null,
        affiliates: [],
      }).success,
    ).toBe(true)
  })

  it('an account carries nullable balances and owner (the signer\'s own accounts have none)', () => {
    const account = { uid: 'ACC003', currency: 'SEK', iban: 'SE1', bban: '1', name: 'Företagskonto', usage: 'ORGA', ownerName: 'Bolaget AB', bankgiro: null, plusgiro: null, balance: 487650.75, availableBalance: 487650.75 }
    expect(aisAccountSchema.parse(account)).toEqual(account)
    expect(aisAccountSchema.safeParse({ ...account, usage: 'PRIV', ownerName: null, balance: null, availableBalance: null }).success).toBe(true)
    expect(aisAccountSchema.safeParse({ ...account, currency: 'sek' }).success).toBe(false)
  })

  it('syncTransactions asks for a window and answers in the bank sync shape, with the AIS additions optional', () => {
    expect(aisSyncTransactionsRequestSchema.safeParse({ party: PARTY, consentId: 'c-1', accountUid: 'ACC003', accountCurrency: 'SEK', dateFrom: '2026-07-02' }).success).toBe(true)
    expect(aisSyncTransactionsRequestSchema.safeParse({ party: PARTY, consentId: 'c-1', accountUid: 'ACC003', accountCurrency: 'SEK', accountUsage: 'PRIV', dateFrom: '2026-07-02', dateTo: '2026-09-30' }).success).toBe(true)
    expect(aisSyncTransactionsRequestSchema.safeParse({ party: PARTY, consentId: 'c-1', accountUid: 'ACC003', accountCurrency: 'SEK' }).success).toBe(false)
    // The enrichment stamp is opt-in (an extra provider call): a boolean, absent by default.
    expect(aisSyncTransactionsRequestSchema.safeParse({ party: PARTY, consentId: 'c-1', accountUid: 'ACC003', accountCurrency: 'SEK', dateFrom: '2026-07-02', include_enrichment: true }).success).toBe(true)
    expect(aisSyncTransactionsRequestSchema.safeParse({ party: PARTY, consentId: 'c-1', accountUid: 'ACC003', accountCurrency: 'SEK', dateFrom: '2026-07-02', include_enrichment: 'yes' }).success).toBe(false)
    expect(aisSyncTransactionsRequestSchema.parse({ party: PARTY, consentId: 'c-1', accountUid: 'ACC003', accountCurrency: 'SEK', dateFrom: '2026-07-02' }).include_enrichment).toBeUndefined()
    expect(AIS_OPERATIONS.syncTransactions.response).toBe(bankSyncResponseSchema)
    // An Enable Banking answer, without the additions, still validates ...
    expect(bankSyncResponseSchema.parse(SYNC)).toEqual(SYNC)
    // ... and so does an AIS answer with them.
    const ais = { ...SYNC, truncated: false, pagingLoop: false, duplicates: 2, conflicts: 0 }
    expect(bankSyncResponseSchema.parse(ais)).toEqual(ais)
    expect(bankSyncResponseSchema.safeParse({ ...SYNC, duplicates: -1 }).success).toBe(false)
  })

  it('a normalized row may carry the value date, end-to-end id, provider id and counterparty IBAN, or leave them out', () => {
    expect(normalizedBankTransactionSchema.parse(ROW)).toEqual(ROW)
    const full = { ...ROW, value_date: '2026-09-28', end_to_end_id: 'ACC-ORDER-1', provider_transaction_id: 'SBX-TX-1', counterparty_iban: 'SE4450000000089012345678' }
    expect(normalizedBankTransactionSchema.parse(full)).toEqual(full)
    expect(normalizedBankTransactionSchema.parse({ ...ROW, value_date: null, end_to_end_id: null, provider_transaction_id: null, counterparty_iban: null })).toMatchObject({ value_date: null })
    expect(normalizedBankTransactionSchema.safeParse({ ...ROW, value_date: '28/09/2026' }).success).toBe(false)
  })

  it('a normalized row may carry the enrichment of 2026-10-15 (organisation number, exchange, balance after, enriched flag, parts), or leave it out', () => {
    // A row from before the enrichment (the Enable Banking path, an older service) still parses ...
    expect(normalizedBankTransactionSchema.parse(ROW)).toEqual(ROW)
    // ... as does one with every field null (the AIS family on a row the bank did not enrich) ...
    const bare = { ...ROW, counterparty_org_number: null, instructed_amount: null, instructed_currency: null, exchange_rate: null, balance_after: null, is_enriched: null, parts: null }
    expect(normalizedBankTransactionSchema.parse(bare)).toEqual(bare)
    // ... and one with the split and the card details.
    const part = {
      amount: 1250,
      currency: 'SEK',
      counterparty_name: 'Acme AB',
      counterparty_org_number: '5566778899',
      counterparty_account: '1234-5679',
      reference: '4711000000009',
      invoice_numbers: ['INV-12345'],
      message: 'Faktura 12345',
      provider_part_id: 'SBX-BG-1',
    }
    expect(bankTransactionPartSchema.parse(part)).toEqual(part)
    expect(bankTransactionPartSchema.parse({ ...part, counterparty_name: null, counterparty_org_number: null, counterparty_account: null, reference: null, invoice_numbers: [], message: null, provider_part_id: null })).toMatchObject({ invoice_numbers: [] })
    const deposit = { ...ROW, amount: 3750, counterparty_org_number: null, balance_after: 491400.75, is_enriched: true, parts: [part, { ...part, amount: 2500, counterparty_org_number: null }] }
    expect(normalizedBankTransactionSchema.parse(deposit)).toEqual(deposit)
    const card = { ...ROW, amount: -1149.5, merchant_category_code: '7372', counterparty_org_number: '5566778899', instructed_amount: 100, instructed_currency: 'EUR', exchange_rate: 11.495, balance_after: 487650.75, is_enriched: true, parts: null }
    expect(normalizedBankTransactionSchema.parse(card)).toEqual(card)
    // Organisation numbers are 10 digits, currencies 3 letters, rates positive; a part needs its amount and its invoice numbers.
    expect(normalizedBankTransactionSchema.safeParse({ ...ROW, counterparty_org_number: '556677-8899' }).success).toBe(false)
    expect(normalizedBankTransactionSchema.safeParse({ ...ROW, counterparty_org_number: '165566778899' }).success).toBe(false)
    expect(normalizedBankTransactionSchema.safeParse({ ...ROW, instructed_currency: 'eur' }).success).toBe(false)
    expect(normalizedBankTransactionSchema.safeParse({ ...ROW, exchange_rate: 0 }).success).toBe(false)
    expect(normalizedBankTransactionSchema.safeParse({ ...ROW, parts: [{ ...part, amount: null }] }).success).toBe(false)
    expect(normalizedBankTransactionSchema.safeParse({ ...ROW, parts: [{ ...part, invoice_numbers: null }] }).success).toBe(false)
  })

  it('the sync response may carry the account\'s enrichment moment, as an object or null, or leave it out', () => {
    expect(bankSyncResponseSchema.parse(SYNC)).toEqual(SYNC)
    const unknown = { ...SYNC, enrichment: null }
    expect(bankSyncResponseSchema.parse(unknown)).toEqual(unknown)
    const enriched = { ...SYNC, enrichment: { last_enriched_at: '2026-09-30T03:12:41.803Z', window_enriched: true } }
    expect(bankSyncResponseSchema.parse(enriched)).toEqual(enriched)
    expect(bankSyncEnrichmentSchema.parse({ last_enriched_at: null, window_enriched: false })).toEqual({ last_enriched_at: null, window_enriched: false })
    expect(bankSyncResponseSchema.safeParse({ ...SYNC, enrichment: { last_enriched_at: '2026-09-30T03:12:41.803Z' } }).success).toBe(false)
    expect(bankSyncResponseSchema.safeParse({ ...SYNC, enrichment: { last_enriched_at: '2026-09-30T03:12:41.803Z', window_enriched: 'yes' } }).success).toBe(false)
  })

  it('the AIS codes are listed, and the consent-over and daily-budget codes come from the bank sync list', () => {
    for (const code of AIS_ERROR_CODES) expect(CONNECTOR_ERROR_CODES, code).toContain(code)
    expect([...AIS_ERROR_CODES]).toEqual([
      'CONNECTOR_AIS_PROVIDER_UNAVAILABLE',
      'CONNECTOR_AIS_OUTCOME_UNKNOWN',
      'CONNECTOR_AIS_REFUSED',
      'CONNECTOR_AIS_NOT_FOUND',
      'CONNECTOR_AIS_PROVIDER_FAILED',
    ])
    expect(BANK_SYNC_ERROR_CODES).toContain('CONNECTOR_BANK_SESSION_EXPIRED')
    expect(BANK_SYNC_ERROR_CODES).toContain('CONNECTOR_BANK_RATE_LIMITED')
    expect(BANK_SYNC_ERROR_CODES).toContain('CONNECTOR_BANK_THROTTLED')
  })
})

const party = {
  orgNumber: '5595386219',
  accountContext: 'corporate',
  bic: 'SWEDSESS',
  personalNumber: '199001011239',
  psuIpAddress: null,
  psuUserAgent: null,
}

describe('AIS family', () => {
  it('is the 2026-10-17 contract under /api/connect/ais with the bank_sync scope', () => {
    expect(CONTRACT_VERSION).toBe('2026-10-17')
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
    expect(aisPartySchema.safeParse({ ...party, redirectPreferred: true }).success).toBe(true)
    expect(aisPartySchema.safeParse({ ...party, redirectPreferred: 'yes' }).success).toBe(false)
    expect(aisPartySchema.safeParse({ ...party, orgNumber: '559538-6219' }).success).toBe(false)
    expect(aisPartySchema.safeParse({ ...party, personalNumber: '9001011239' }).success).toBe(false)
    expect(aisCreateConsentRequestSchema.safeParse({ party, accounts: [{ iban: 'SE8050000000052131234567' }] }).success).toBe(true)
  })

  it('takes the signer\'s Nordea Corporate Netbank logon id (2026-10-17): trimmed, 1 to 64 letters, digits, - or _, or null', () => {
    const parsed = aisPartySchema.safeParse({ ...party, bic: 'NDEASESS', psuAuthoriserId: '  ab-12_CD  ' })
    expect(parsed.success && parsed.data.psuAuthoriserId).toBe('ab-12_CD')
    expect(aisPartySchema.safeParse({ ...party, psuAuthoriserId: null }).success).toBe(true)
    expect(aisPartySchema.safeParse({ ...party, psuAuthoriserId: 'x'.repeat(64) }).success).toBe(true)
    expect(aisPartySchema.safeParse({ ...party, psuAuthoriserId: 'x'.repeat(65) }).success).toBe(false)
    expect(aisPartySchema.safeParse({ ...party, psuAuthoriserId: '' }).success).toBe(false)
    expect(aisPartySchema.safeParse({ ...party, psuAuthoriserId: 'ab cd' }).success).toBe(false)
    // A party without it is the previous version's party.
    expect('psuAuthoriserId' in aisPartySchema.parse(party)).toBe(false)
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

  it('carries the 2026-10-15 enrichment fields as optional nullable additions: an older producer leaves them out', () => {
    const row = {
      booking_date: '2026-10-01', amount: 1250, currency: 'SEK', description: 'Bg-inbetalning', counterparty_name: 'Kund AB', counterparty_account: '5050-1055',
      reference: '1001000000017', merchant_category_code: null, bank_transaction_code: null, proprietary_bank_transaction_code: null,
    }
    const part = {
      amount: 500, currency: 'SEK', counterparty_name: 'Kund AB', counterparty_org_number: '5560160680', counterparty_account: '5050-1055',
      reference: '1001000000017', invoice_numbers: ['1001'], message: null, provider_part_id: 'ALIAS-1',
    }
    expect(bankTransactionPartSchema.safeParse(part).success).toBe(true)
    expect(bankTransactionPartSchema.safeParse({ ...part, invoice_numbers: undefined }).success).toBe(false)
    expect(normalizedBankTransactionSchema.safeParse({
      ...row, counterparty_org_number: '5560160680', instructed_amount: -2.22, instructed_currency: 'EUR', exchange_rate: 11.26,
      balance_after: 12345.67, is_enriched: true, parts: [part, { ...part, amount: 750, invoice_numbers: [] }],
    }).success).toBe(true)
    expect(normalizedBankTransactionSchema.safeParse({ ...row, counterparty_org_number: null, instructed_amount: null, instructed_currency: null, exchange_rate: null, balance_after: null, is_enriched: null, parts: null }).success).toBe(true)
    expect(normalizedBankTransactionSchema.safeParse({ ...row, is_enriched: 'yes' }).success).toBe(false)
    expect(normalizedBankTransactionSchema.safeParse({ ...row, parts: [{ amount: 1 }] }).success).toBe(false)
    const page = { transactions: [row], raw_pages: [], skipped_pending: 0, returned_min_booking_date: null, returned_max_booking_date: null, effective_date_from: null, pages: 0 }
    expect(bankSyncResponseSchema.safeParse({ ...page, enrichment: { last_enriched_at: '2026-10-13T04:10:00Z', window_enriched: true } }).success).toBe(true)
    expect(bankSyncResponseSchema.safeParse({ ...page, enrichment: { last_enriched_at: null, window_enriched: false } }).success).toBe(true)
    expect(bankSyncResponseSchema.safeParse({ ...page, enrichment: null }).success).toBe(true)
    expect(bankSyncResponseSchema.safeParse({ ...page, enrichment: { window_enriched: true } }).success).toBe(false)
    const request = { party, consentId: 'c1', accountUid: 'ACC003', accountCurrency: 'SEK', dateFrom: '2026-10-05' }
    expect(aisSyncTransactionsRequestSchema.safeParse(request).success).toBe(true)
    expect(aisSyncTransactionsRequestSchema.safeParse({ ...request, include_enrichment: true }).success).toBe(true)
    expect(aisSyncTransactionsRequestSchema.safeParse({ ...request, include_enrichment: 'yes' }).success).toBe(false)
  })
})
