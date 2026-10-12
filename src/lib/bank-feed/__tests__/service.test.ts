import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  door: vi.fn(),
  connect: vi.fn(),
  serviceRpc: vi.fn(),
  resolveLedger: vi.fn(),
  readConfig: vi.fn(),
  saveSelection: vi.fn(),
  disconnect: vi.fn(),
  runSync: vi.fn(),
  emit: vi.fn(),
  signerOnFile: vi.fn(),
  hasSigner: vi.fn(),
}))
vi.mock('../door', () => ({ openBankFeedDoor: (...a: unknown[]) => mocks.door(...a) }))
vi.mock('../connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connect')>()),
  getBankFeedConnect: () => mocks.connect(),
}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({ rpc: (...a: unknown[]) => mocks.serviceRpc(...a) }) }))
vi.mock('@/lib/cash-accounts/service', () => ({ resolvePsd2LedgerAccount: (...a: unknown[]) => mocks.resolveLedger(...a) }))
vi.mock('@/lib/cash-accounts/configuration', () => ({
  readBankConfiguration: (...a: unknown[]) => mocks.readConfig(...a),
  saveBankAccountSelection: (...a: unknown[]) => mocks.saveSelection(...a),
  disconnectBankConnection: (...a: unknown[]) => mocks.disconnect(...a),
}))
vi.mock('../feed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../feed')>()),
  runOpenPaymentsSync: (...a: unknown[]) => mocks.runSync(...a),
}))
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: (...a: unknown[]) => mocks.emit(...a) } }))
vi.mock('@/lib/auth/bankid-signer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/bankid-signer')>()),
  signerPersonalNumberOnFile: (...a: unknown[]) => mocks.signerOnFile(...a),
  hasSignerOnFile: (...a: unknown[]) => mocks.hasSigner(...a),
}))

import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import { BankFeedRefusedError, ConsentOverError, ProviderUnavailableError, type BankFeedConnect } from '../connect'
import {
  consentStep,
  disconnectBankFeedConnection,
  getBankFeedBankDetails,
  listBankFeedBanks,
  pollBankFeedConsent,
  restartBankFeedConsent,
  selectBankFeedAccounts,
  startBankFeedConsent,
  toStoredAccounts,
} from '../service'

const NOW = Date.parse('2026-10-12T10:00:00Z')
const CONNECTION = '4f6c1a2b-9c0d-4e8f-8a1b-2c3d4e5f6a7b'
const EB_ROW = '9f6c1a2b-9c0d-4e8f-8a1b-2c3d4e5f6a7b'
const ctx = { supabase: null as never, companyId: 'co-1', userId: 'user-1', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never }
const signer = { personalNumber: null, ipAddress: '203.0.113.1', userAgent: 'UA' }
const CHALLENGE = { approach: 'decoupled' as const, autostartToken: null, qrData: 'bankid.qr', qrImage: null, redirectUrl: null }
const BANK = { bic: 'SWEDSESS', name: 'Swedbank', decoupled: true, redirect: false, transactionHistoryMaxDays: 88, extendedTransactionHistoryMaxDays: 760, extendedTransactionHistoryAvailableWindowMinutes: 60, affiliates: [{ id: '08999', name: 'Sparbanken Nord' }] }
const ACCOUNTS = [
  { uid: 'ACC003', currency: 'SEK', iban: 'SE80 5000 0000 0521 3123 4567', bban: '80000052131234567', name: 'Företagskonto', usage: 'ORGA', ownerName: 'Bolaget AB', bankgiro: '5050-1055', plusgiro: null, balance: 1200.5, availableBalance: 1100 },
  { uid: 'ACC001', currency: 'SEK', iban: 'SE7750000000056990607246', bban: null, name: 'Privatkonto', usage: 'PRIV', ownerName: 'Anna', bankgiro: null, plusgiro: null, balance: 5, availableBalance: 5 },
]

/** The shared per-table Supabase mock (tests/helpers.ts), keyed by table or 'rpc:<name>', answers consumed in call order. */
function stub(answers: Record<string, unknown[]>) {
  const mock = createTableMockSupabase(Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, value as TableMockResult[]])))
  return { supabase: mock.supabase as never, calls: mock.calls, rpc: mock.supabase.rpc, payload: mock.payloads }
}

/** The adapter as the service sees it; getBankDetails reads through the `bank` mock unless a test gives its own. */
function fakeConnect(overrides: Partial<BankFeedConnect> = {}): BankFeedConnect {
  const base = {
    banks: vi.fn().mockResolvedValue([{ bic: 'SWEDSESS', name: 'Swedbank', logoUrl: null, decoupled: true, redirect: null }]),
    bank: vi.fn().mockResolvedValue(BANK),
    createConsent: vi.fn().mockResolvedValue({ consentId: 'consent-1', consentStatus: 'received', validUntil: '2027-04-10' }),
    startConsentSigning: vi.fn().mockResolvedValue({ providerAuthorisationId: 'auth-1', method: 'qr', state: 'pending', challenge: CHALLENGE, failureCode: null, scaStatus: 'authenticationStarted' }),
    pollConsentSigning: vi.fn(),
    consentStatus: vi.fn(),
    accounts: vi.fn().mockResolvedValue(ACCOUNTS),
    balances: vi.fn(),
    syncTransactions: vi.fn(),
    revokeConsent: vi.fn().mockResolvedValue({ revoked: true }),
    ...overrides,
  }
  return { getBankDetails: (companyId: string, bic: string) => (base.bank as (c: string, b: string) => unknown)(companyId, bic), ...base } as unknown as BankFeedConnect
}

const REDIRECT_STARTED = (url: string, id = 'auth-r') => ({
  providerAuthorisationId: id, method: 'redirect', state: 'pending', challenge: { ...CHALLENGE, approach: 'redirect', qrData: null, redirectUrl: url }, failureCode: null, scaStatus: null,
})
const ORIGIN = 'https://app.accounted.se'

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION, company_id: 'co-1', user_id: 'user-1', status: 'pending', aggregator: 'open_payments', provider: 'open_payments', bic: 'SWEDSESS',
    affiliated_aspsp_id: null, psu_type: 'business', bank_name: 'Swedbank', session_id: 'consent-1', authorization_id: 'auth-1',
    consent_expires: '2027-04-10T23:59:59Z', last_synced_at: null, initial_sync_completed_at: null, error_message: null,
    accounts_data: null, consent_attempt: { method: 'qr', state: 'pending', started_at: '2026-10-12T09:59:00Z', listing_only: false, replace_connection_id: null, extended_history_days: 760 },
    ...overrides,
  }
}

const orgAnswers = () => ({ company_settings: [{ data: { org_number: '559538-6219' }, error: null }] })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.signerOnFile.mockResolvedValue('199001011239')
  mocks.hasSigner.mockResolvedValue(true)
  mocks.emit.mockResolvedValue(undefined)
  mocks.resolveLedger.mockResolvedValue({ ledgerAccount: '1931', reuseCashAccountId: null, source: 'allocated' })
})

describe('helpers', () => {
  it('reads the BankID step from the SCA status', () => {
    expect(consentStep('authenticationStarted')).toBe('identify')
    expect(consentStep('psuIdentified')).toBe('identify')
    expect(consentStep('started')).toBe('consent')
    expect(consentStep('authorisationStarted')).toBe('consent')
    expect(consentStep('finalised')).toBeNull()
    expect(consentStep(null)).toBeNull()
  })

  it('stores the company accounts selected with their balance and the signer\'s own unselected and bare', () => {
    const stored = toStoredAccounts(ACCOUNTS, '2026-10-12T10:00:00Z')
    expect(stored[0]).toEqual({ uid: 'ACC003', currency: 'SEK', enabled: true, iban: 'SE8050000000052131234567', bban: '80000052131234567', name: 'Företagskonto', usage: 'ORGA', balance: 1200.5, available_balance: 1100, balance_updated_at: '2026-10-12T10:00:00Z' })
    expect(stored[1]).toEqual({ uid: 'ACC001', currency: 'SEK', enabled: false, iban: 'SE7750000000056990607246', name: 'Privatkonto', usage: 'PRIV' })
    expect(toStoredAccounts([{ ...ACCOUNTS[1], usage: null }], 'x')[0].enabled).toBe(true)
  })
})

describe('listBankFeedBanks', () => {
  it('runs the door first and answers its reason', async () => {
    mocks.door.mockResolvedValue({ ok: false, reason: 'not_in_pilot' })
    expect(await listBankFeedBanks(ctx)).toEqual({ ok: false, code: 'OPEN_BANKING_NOT_AVAILABLE', details: { reason: 'not_in_pilot' } })
  })

  it('forwards the provider\'s bank names unchanged', async () => {
    mocks.door.mockResolvedValue({ ok: true, connect: fakeConnect() })
    expect(await listBankFeedBanks(ctx)).toEqual({ ok: true, data: { banks: [{ bic: 'SWEDSESS', name: 'Swedbank', logo_url: null, decoupled: true, redirect: null }] } })
  })
})

describe('startBankFeedConsent', () => {
  it('creates the consent, stores the pending attempt with provider open_payments and starts BankID', async () => {
    const connect = fakeConnect()
    mocks.door.mockResolvedValue({ ok: true, connect })
    const { supabase, payload, calls } = stub({
      ...orgAnswers(),
      companies: [{ data: { entity_type: 'aktiebolag' }, error: null }],
      bank_connections: [
        { data: [{ id: 'stale', bic: 'ESSESESS', created_at: '2026-10-01T00:00:00Z', consent_attempt: { state: 'pending', started_at: '2026-10-01T00:00:00Z' } }, { id: 'joint', bic: 'SWEDSESS', created_at: '2026-10-01T00:00:00Z', consent_attempt: { state: 'partially_authorised' } }], error: null },
        { data: [{ id: 'stale' }], error: null },
        { data: row({ authorization_id: null }), error: null },
        { data: null, error: null },
      ],
    })
    const result = await startBankFeedConsent({ ...ctx, supabase }, { bic: 'SWEDSESS', method: 'qr', signer, replaceConnectionId: null, now: NOW })
    expect(result).toEqual({
      ok: true,
      data: { connection_id: CONNECTION, attempt: { authorisation_id: 'auth-1', method: 'qr', state: 'pending', challenge: CHALLENGE, sca_status: 'authenticationStarted', step: 'identify', failure_code: null, failure_text: null } },
    })
    expect(connect.createConsent).toHaveBeenCalledWith('co-1', {
      party: { orgNumber: '5595386219', accountContext: 'corporate', bic: 'SWEDSESS', personalNumber: '199001011239', psuIpAddress: '203.0.113.1', psuUserAgent: 'UA', affiliatedAspspId: null },
      validUntil: '2027-04-10',
    })
    expect(calls).toContainEqual({ table: 'bank_connections', method: 'in', args: ['id', ['stale']] })
    expect(payload('bank_connections', 'insert')[0]).toMatchObject({
      aggregator: 'open_payments', provider: 'open_payments', bank_name: 'Swedbank', bic: 'SWEDSESS', session_id: 'consent-1', status: 'pending', psu_type: 'business',
      consent_expires: '2027-04-10T23:59:59Z',
      consent_attempt: { method: 'qr', state: 'pending', listing_only: false, replace_connection_id: null, extended_history_days: 760 },
    })
    expect(payload('bank_connections', 'update')[0]).toMatchObject({ authorization_id: 'auth-1', consent_attempt: expect.objectContaining({ state: 'pending', sca_status: 'authenticationStarted' }) })
    expect(connect.startConsentSigning).toHaveBeenCalledWith('co-1', expect.objectContaining({ consentId: 'consent-1', method: 'qr' }))
  })

  it('defaults an enskild firma to the private context, remembers a switch and the sparbank, and marks Svea as listing only', async () => {
    const connect = fakeConnect({ bank: vi.fn().mockResolvedValue({ ...BANK, bic: 'SVEASESS', name: 'Svea Bank', affiliates: [] }) })
    mocks.door.mockResolvedValue({ ok: true, connect })
    const { supabase, payload } = stub({
      ...orgAnswers(),
      companies: [{ data: { entity_type: 'enskild_firma' }, error: null }],
      bank_connections: [
        { data: { id: EB_ROW, status: 'active', aggregator: 'enable_banking' }, error: null },
        { data: [], error: null },
        { data: row({ bic: 'SVEASESS', authorization_id: null }), error: null },
        { data: null, error: null },
      ],
    })
    const result = await startBankFeedConsent({ ...ctx, supabase }, { bic: 'SVEASESS', method: 'same_device', signer, replaceConnectionId: EB_ROW, now: NOW })
    expect(result.ok).toBe(true)
    expect(payload('bank_connections', 'insert')[0]).toMatchObject({ psu_type: 'personal', consent_attempt: expect.objectContaining({ listing_only: true, replace_connection_id: EB_ROW }) })
    expect(connect.createConsent).toHaveBeenCalledWith('co-1', expect.objectContaining({ party: expect.objectContaining({ accountContext: 'private' }) }))
  })

  it('refuses a closed door, an unknown bank, a missing personnummer and an unknown replaced row', async () => {
    mocks.door.mockResolvedValueOnce({ ok: false, reason: 'no_connector' })
    expect(await startBankFeedConsent(ctx, { bic: 'SWEDSESS', method: 'qr', signer })).toMatchObject({ ok: false, code: 'OPEN_BANKING_NOT_AVAILABLE' })

    const unknownBank = fakeConnect({ bank: vi.fn().mockRejectedValue(new BankFeedRefusedError('x', { code: 'BANK_FEED_NOT_FOUND', status: 404 })) })
    mocks.door.mockResolvedValue({ ok: true, connect: unknownBank })
    expect(await startBankFeedConsent({ ...ctx, supabase: stub({}).supabase }, { bic: 'XXXXSESS', method: 'qr', signer })).toEqual({ ok: false, code: 'BANK_CONSENT_UNKNOWN_BANK' })

    mocks.door.mockResolvedValue({ ok: true, connect: fakeConnect() })
    mocks.signerOnFile.mockResolvedValueOnce(null)
    const noSigner = stub({ ...orgAnswers(), companies: [{ data: { entity_type: 'aktiebolag' }, error: null }] })
    expect(await startBankFeedConsent({ ...ctx, supabase: noSigner.supabase }, { bic: 'SWEDSESS', method: 'qr', signer })).toEqual({ ok: false, code: 'BANK_CONSENT_PERSONAL_NUMBER_REQUIRED' })

    const noOld = stub({ ...orgAnswers(), companies: [{ data: { entity_type: 'aktiebolag' }, error: null }], bank_connections: [{ data: { id: EB_ROW, status: 'revoked', aggregator: 'enable_banking' }, error: null }] })
    expect(await startBankFeedConsent({ ...ctx, supabase: noOld.supabase }, { bic: 'SWEDSESS', method: 'qr', signer, replaceConnectionId: EB_ROW })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('ends a consent nothing points at when the row cannot be stored, and reports a redirect-only bank', async () => {
    const connect = fakeConnect()
    mocks.door.mockResolvedValue({ ok: true, connect })
    const failing = stub({ ...orgAnswers(), companies: [{ data: { entity_type: 'aktiebolag' }, error: null }], bank_connections: [{ data: [], error: null }, { data: null, error: { message: 'boom' } }] })
    expect(await startBankFeedConsent({ ...ctx, supabase: failing.supabase }, { bic: 'SWEDSESS', method: 'qr', signer })).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' })
    expect(connect.revokeConsent).toHaveBeenCalledWith('co-1', expect.objectContaining({ consentId: 'consent-1' }))

    const redirect = fakeConnect({ startConsentSigning: vi.fn().mockResolvedValue({ providerAuthorisationId: 'auth-r', method: 'redirect', state: 'pending', challenge: { ...CHALLENGE, approach: 'redirect', redirectUrl: 'https://bank' }, failureCode: null, scaStatus: null }) })
    mocks.door.mockResolvedValue({ ok: true, connect: redirect })
    const ok = stub({ ...orgAnswers(), companies: [{ data: { entity_type: 'aktiebolag' }, error: null }], bank_connections: [{ data: [], error: null }, { data: row({ authorization_id: null }), error: null }, { data: null, error: null }] })
    expect(await startBankFeedConsent({ ...ctx, supabase: ok.supabase }, { bic: 'SWEDSESS', method: 'qr', signer })).toEqual({ ok: false, code: 'BANK_CONSENT_REDIRECT_UNSUPPORTED' })
  })
})

describe('startBankFeedConsent on the bank\'s own page', () => {
  const company = () => ({ companies: [{ data: { entity_type: 'aktiebolag' }, error: null }] })

  it('starts a redirect-only bank on its page with the entry point\'s return URL, names the sparbank and sends it with the party', async () => {
    const connect = fakeConnect({ bank: vi.fn().mockResolvedValue({ ...BANK, decoupled: false, redirect: true }), startConsentSigning: vi.fn().mockResolvedValue(REDIRECT_STARTED('https://bank.example/sign')) })
    mocks.door.mockResolvedValue({ ok: true, connect })
    const { supabase, payload } = stub({
      ...orgAnswers(), ...company(),
      bank_connections: [{ data: [], error: null }, { data: row({ authorization_id: null, affiliated_aspsp_id: '08999', bank_name: 'Sparbanken Nord' }), error: null }, { data: null, error: null }],
    })
    // The browser asked for a QR: the bank cannot do that, so its page is used, since the caller said where to come back.
    const result = await startBankFeedConsent({ ...ctx, supabase }, { bic: 'SWEDSESS', affiliatedAspspId: '08999', method: 'qr', signer, returnTo: 'connections', returnOrigin: ORIGIN, now: NOW })
    expect(result).toMatchObject({
      ok: true,
      data: { connection_id: CONNECTION, attempt: { method: 'redirect', state: 'pending', challenge: expect.objectContaining({ approach: 'redirect', redirectUrl: 'https://bank.example/sign' }) } },
    })
    const party = expect.objectContaining({ bic: 'SWEDSESS', affiliatedAspspId: '08999' })
    expect(connect.createConsent).toHaveBeenCalledWith('co-1', expect.objectContaining({ party }))
    expect(connect.startConsentSigning).toHaveBeenCalledWith('co-1', {
      party, consentId: 'consent-1', method: 'redirect', returnUrl: `${ORIGIN}/settings/connections?bank_connect=${CONNECTION}`, returnState: CONNECTION,
    })
    expect(payload('bank_connections', 'insert')[0]).toMatchObject({ bank_name: 'Sparbanken Nord', affiliated_aspsp_id: '08999', consent_attempt: expect.objectContaining({ method: 'redirect', return_to: 'connections' }) })
    expect(payload('bank_connections', 'update')[0]).toMatchObject({ authorization_id: 'auth-r', consent_attempt: expect.objectContaining({ method: 'redirect', state: 'pending', return_to: 'connections' }) })
  })

  it('keeps the person\'s method at a bank that signs both ways, and refuses a redirect without a return page before anything is created', async () => {
    const both = fakeConnect({ bank: vi.fn().mockResolvedValue({ ...BANK, redirect: true }) })
    mocks.door.mockResolvedValue({ ok: true, connect: both })
    const one = stub({ ...orgAnswers(), ...company(), bank_connections: [{ data: [], error: null }, { data: row({ authorization_id: null }), error: null }, { data: null, error: null }] })
    expect(await startBankFeedConsent({ ...ctx, supabase: one.supabase }, { bic: 'SWEDSESS', method: 'qr', signer, returnTo: 'banking', returnOrigin: ORIGIN, now: NOW })).toMatchObject({ ok: true, data: { attempt: { method: 'qr' } } })
    expect(both.startConsentSigning).toHaveBeenCalledWith('co-1', { party: expect.anything(), consentId: 'consent-1', method: 'qr' })
    expect(one.payload('bank_connections', 'insert')[0]).toMatchObject({ bank_name: 'Swedbank', consent_attempt: expect.objectContaining({ method: 'qr', return_to: 'banking' }) })

    const connect = fakeConnect()
    mocks.door.mockResolvedValue({ ok: true, connect })
    const two = stub({ ...orgAnswers(), ...company() })
    expect(await startBankFeedConsent({ ...ctx, supabase: two.supabase }, { bic: 'SWEDSESS', method: 'redirect', signer })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'return_to' } })
    expect(connect.createConsent).not.toHaveBeenCalled()
  })

  it('a bank that signs in our screen anyway answers a redirect start with a QR: the attempt goes on with the bank\'s method', async () => {
    const connect = fakeConnect({ bank: vi.fn().mockResolvedValue({ ...BANK, redirect: true }) })
    mocks.door.mockResolvedValue({ ok: true, connect })
    const { supabase, payload } = stub({ ...orgAnswers(), ...company(), bank_connections: [{ data: [], error: null }, { data: row({ authorization_id: null }), error: null }, { data: null, error: null }] })
    const result = await startBankFeedConsent({ ...ctx, supabase }, { bic: 'SWEDSESS', method: 'redirect', signer, returnTo: 'connections', returnOrigin: ORIGIN, now: NOW })
    expect(result).toMatchObject({ ok: true, data: { attempt: { method: 'qr', state: 'pending', challenge: CHALLENGE, step: 'identify' } } })
    expect(connect.startConsentSigning).toHaveBeenCalledWith('co-1', expect.objectContaining({ method: 'redirect', returnState: CONNECTION }))
    expect(payload('bank_connections', 'update')[0]).toMatchObject({ consent_attempt: expect.objectContaining({ method: 'qr', state: 'pending' }) })
  })

  it('an unknown sparbank is refused before the consent exists', async () => {
    const connect = fakeConnect()
    mocks.door.mockResolvedValue({ ok: true, connect })
    const { supabase } = stub({ ...orgAnswers(), ...company() })
    expect(await startBankFeedConsent({ ...ctx, supabase }, { bic: 'SWEDSESS', affiliatedAspspId: 'nope', method: 'qr', signer })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'affiliated_aspsp_id' } })
    expect(connect.createConsent).not.toHaveBeenCalled()
  })
})

describe('getBankFeedBankDetails', () => {
  it('answers the bank\'s signing ways and its sparbanker through the door, and names an unknown bank', async () => {
    mocks.door.mockResolvedValue({ ok: true, connect: fakeConnect({ bank: vi.fn().mockResolvedValue({ ...BANK, redirect: true }) }) })
    expect(await getBankFeedBankDetails(ctx, 'SWEDSESS')).toEqual({
      ok: true,
      data: { bic: 'SWEDSESS', name: 'Swedbank', decoupled: true, redirect: true, affiliates: [{ id: '08999', name: 'Sparbanken Nord' }], transaction_history_max_days: 88, extended_transaction_history_max_days: 760 },
    })
    mocks.door.mockResolvedValue({ ok: true, connect: fakeConnect({ bank: vi.fn().mockRejectedValue(new BankFeedRefusedError('x', { code: 'BANK_FEED_NOT_FOUND', status: 404 })) }) })
    expect(await getBankFeedBankDetails(ctx, 'XXXXSESS')).toEqual({ ok: false, code: 'BANK_CONSENT_UNKNOWN_BANK' })
    mocks.door.mockResolvedValueOnce({ ok: false, reason: 'not_in_pilot' })
    expect(await getBankFeedBankDetails(ctx, 'SWEDSESS')).toMatchObject({ ok: false, code: 'OPEN_BANKING_NOT_AVAILABLE', details: { reason: 'not_in_pilot' } })
  })
})

describe('pollBankFeedConsent', () => {
  it('answers fresh BankID data while pending, with the step, and records the state change once', async () => {
    const connect = fakeConnect({ pollConsentSigning: vi.fn().mockResolvedValue({ state: 'pending', challenge: { ...CHALLENGE, qrData: 'bankid.qr.2' }, failureCode: null, scaStatus: 'started', consentStatus: null, validUntil: null }) })
    mocks.connect.mockReturnValue(connect)
    const { supabase, payload } = stub({ bank_connections: [{ data: row(), error: null }, { data: null, error: null }], ...orgAnswers() })
    const result = await pollBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION, signer })
    expect(result).toEqual({ ok: true, data: { connection_id: CONNECTION, state: 'pending', method: 'qr', challenge: { ...CHALLENGE, qrData: 'bankid.qr.2' }, sca_status: 'started', step: 'consent', failure_code: null, failure_text: null, status: 'pending' } })
    expect(connect.pollConsentSigning).toHaveBeenCalledWith('co-1', expect.objectContaining({ consentId: 'consent-1', providerAuthorisationId: 'auth-1', method: 'qr' }))
    expect(payload('bank_connections', 'update')[0]).toMatchObject({ consent_attempt: expect.objectContaining({ state: 'pending', sca_status: 'started' }) })
  })

  it('keeps a failed attempt on the row with the Swedish meaning of the bank\'s code, and a partially authorised one alive', async () => {
    const failed = fakeConnect({ pollConsentSigning: vi.fn().mockResolvedValue({ state: 'failed', challenge: null, failureCode: 'AUTHENTICATION_SESSION_PSU_CANCELLED', scaStatus: 'failed', consentStatus: null, validUntil: null }) })
    mocks.connect.mockReturnValue(failed)
    const one = stub({ bank_connections: [{ data: row(), error: null }, { data: null, error: null }], ...orgAnswers() })
    expect(await pollBankFeedConsent({ ...ctx, supabase: one.supabase }, { connectionId: CONNECTION })).toMatchObject({
      ok: true, data: { state: 'failed', failure_code: 'AUTHENTICATION_SESSION_PSU_CANCELLED', failure_text: 'Användaren avbröt autentiseringen.' },
    })
    expect(one.calls.some((c) => c.table === 'bank_connections' && c.method === 'delete')).toBe(false)

    const joint = fakeConnect({ pollConsentSigning: vi.fn().mockResolvedValue({ state: 'partially_authorised', challenge: null, failureCode: null, scaStatus: 'finalised', consentStatus: 'partiallyAuthorised', validUntil: null }) })
    mocks.connect.mockReturnValue(joint)
    const two = stub({ bank_connections: [{ data: row(), error: null }, { data: null, error: null }], ...orgAnswers() })
    expect(await pollBankFeedConsent({ ...ctx, supabase: two.supabase }, { connectionId: CONNECTION })).toMatchObject({ ok: true, data: { state: 'partially_authorised' } })
    expect(two.payload('bank_connections', 'update')[0]).toMatchObject({ consent_attempt: expect.objectContaining({ state: 'partially_authorised' }) })
  })

  it('on valid reads the accounts, finalizes through the service role and answers each account with its ledger suggestion', async () => {
    mocks.connect.mockReturnValue(fakeConnect({ pollConsentSigning: vi.fn().mockResolvedValue({ state: 'valid', challenge: null, failureCode: null, scaStatus: 'finalised', consentStatus: 'valid', validUntil: '2027-03-29' }) }))
    const stored = [
      { uid: 'ACC003', currency: 'SEK', enabled: true, iban: 'SE8050000000052131234567', name: 'Företagskonto', usage: 'ORGA', dedup_scope: 'eb-legacy' },
      { uid: 'ACC001', currency: 'SEK', enabled: false, iban: 'SE7750000000056990607246', name: 'Privatkonto', usage: 'PRIV' },
    ]
    mocks.serviceRpc.mockResolvedValue({ data: { connection_id: CONNECTION, accounts: stored, superseded: [{ id: 'old-op', session_id: 'c-0' }], already_finalized: false }, error: null })
    mocks.resolveLedger.mockResolvedValueOnce({ ledgerAccount: '1930', reuseCashAccountId: 'cash-1', source: 'iban' }).mockResolvedValueOnce({ ledgerAccount: '1931', reuseCashAccountId: null, source: 'allocated' })
    const { supabase } = stub({ bank_connections: [{ data: row(), error: null }], ...orgAnswers() })
    const result = await pollBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION })
    expect(mocks.serviceRpc).toHaveBeenCalledWith('finalize_open_payments_consent', {
      p_company_id: 'co-1', p_user_id: 'user-1', p_connection_id: CONNECTION, p_consent_id: 'consent-1', p_consent_expires: '2027-03-29T23:59:59Z',
      p_accounts: toStoredAccounts(ACCOUNTS, expect.any(String) as unknown as string).map((a) => ({ ...a, ...(a.balance_updated_at ? { balance_updated_at: expect.any(String) } : {}) })),
    })
    expect(result).toMatchObject({
      ok: true,
      data: {
        state: 'valid', status: 'pending_selection', consent_expires: '2027-03-29T23:59:59Z', needs_second_consent: false,
        accounts: [
          { uid: 'ACC003', preselected: true, enabled: true, suggested_ledger_account: '1930', matches_existing: '1930', iban: 'SE8050000000052131234567' },
          { uid: 'ACC001', preselected: false, enabled: false, suggested_ledger_account: '1931', matches_existing: null },
        ],
      },
    })
    expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'bank_connection.consent_granted' }))
    expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'bank_connection.superseded', payload: expect.objectContaining({ connectionId: 'old-op', supersededById: CONNECTION }) }))
  })

  it('answers valid again for a row already awaiting selection, and the consent over as its own code', async () => {
    mocks.connect.mockReturnValue(fakeConnect())
    const stored = [{ uid: 'ACC003', currency: 'SEK', enabled: true, iban: 'SE8050000000052131234567', ledger_account: '1930' }]
    const picker = stub({ bank_connections: [{ data: row({ status: 'pending_selection', accounts_data: stored, consent_attempt: { selection: { listing_only: true } } }), error: null }] })
    expect(await pollBankFeedConsent({ ...ctx, supabase: picker.supabase }, { connectionId: CONNECTION })).toMatchObject({
      ok: true, data: { state: 'valid', needs_second_consent: true, accounts: [{ uid: 'ACC003', suggested_ledger_account: '1930', matches_existing: null }] },
    })
    mocks.connect.mockReturnValue(fakeConnect({ pollConsentSigning: vi.fn().mockRejectedValue(new ConsentOverError('over')) }))
    const over = stub({ bank_connections: [{ data: row(), error: null }], ...orgAnswers() })
    expect(await pollBankFeedConsent({ ...ctx, supabase: over.supabase }, { connectionId: CONNECTION })).toMatchObject({ ok: false, code: 'BANK_CONSENT_OVER' })
    const unknown = stub({ bank_connections: [{ data: null, error: null }] })
    expect(await pollBankFeedConsent({ ...ctx, supabase: unknown.supabase }, { connectionId: CONNECTION })).toEqual({ ok: false, code: 'NOT_FOUND' })
  })

  it('saves Svea\'s earlier selection when the second consent is valid and answers without accounts', async () => {
    mocks.connect.mockReturnValue(fakeConnect({ pollConsentSigning: vi.fn().mockResolvedValue({ state: 'valid', challenge: null, failureCode: null, scaStatus: 'finalised', consentStatus: 'valid', validUntil: '2027-03-29' }) }))
    const chosen = [{ uid: 'ACC003', enabled: true, ledger_account: '1930' }, { uid: 'ACC001', enabled: false, ledger_account: null }]
    const second = row({ bic: 'SVEASESS', session_id: 'consent-2', consent_attempt: { method: 'qr', state: 'pending', listing_only: false, selection: { listing_only: false, accounts: chosen, replace_connection_id: null, extended_history_days: 365 } } })
    const stored = [{ uid: 'ACC003', currency: 'SEK', enabled: true, iban: 'SE8050000000052131234567' }, { uid: 'ACC001', currency: 'SEK', enabled: false, iban: 'SE7750000000056990607246' }]
    mocks.serviceRpc.mockResolvedValue({ data: { connection_id: CONNECTION, accounts: stored, superseded: [], already_finalized: false }, error: null })
    mocks.readConfig.mockResolvedValue({ token: 'tok', connection: { id: CONNECTION, status: 'pending_selection', session_id: 'consent-2', bank_name: 'Svea Bank', accounts_data: stored, aggregator: 'open_payments' } })
    mocks.saveSelection.mockResolvedValue({ status: 'active', accounts: stored })
    const { supabase } = stub({
      bank_connections: [{ data: second, error: null }, { data: { ...second, status: 'pending_selection', accounts_data: stored }, error: null }, { data: { ...second, status: 'active', accounts_data: stored }, error: null }],
      cash_accounts: [{ data: [], error: null }],
      ...orgAnswers(),
    })
    const result = await pollBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION })
    expect(result).toMatchObject({ ok: true, data: { state: 'valid', status: 'active', consent_expires: '2027-03-29T23:59:59Z' } })
    expect((result as unknown as { data: Record<string, unknown> }).data.accounts).toBeUndefined()
    expect(mocks.saveSelection).toHaveBeenCalledWith(supabase, 'co-1', 'user-1', CONNECTION, 'tok', [
      { uid: 'ACC003', enabled: true, currency: 'SEK', ledger_account: '1930', reuse_cash_account_id: null },
      { uid: 'ACC001', enabled: false, currency: 'SEK', reuse_cash_account_id: null },
    ])
    expect(mocks.runSync).not.toHaveBeenCalled()
  })
})

describe('the sparbank behind a connection', () => {
  it('rides with the party on every call: poll, accounts and revoke', async () => {
    const connect = fakeConnect({ pollConsentSigning: vi.fn().mockResolvedValue({ state: 'valid', challenge: null, failureCode: null, scaStatus: 'finalised', consentStatus: 'valid', validUntil: '2027-04-10' }) })
    mocks.connect.mockReturnValue(connect)
    mocks.serviceRpc.mockResolvedValue({ data: { already_finalized: false, accounts: [], superseded: [] }, error: null })
    const party = expect.objectContaining({ bic: 'SWEDSESS', affiliatedAspspId: '08999' })
    const polled = stub({ bank_connections: [{ data: row({ affiliated_aspsp_id: '08999', bank_name: 'Sparbanken Nord' }), error: null }], ...orgAnswers() })
    expect(await pollBankFeedConsent({ ...ctx, supabase: polled.supabase }, { connectionId: CONNECTION, signer })).toMatchObject({ ok: true, data: { state: 'valid' } })
    expect(connect.pollConsentSigning).toHaveBeenCalledWith('co-1', expect.objectContaining({ party, method: 'qr' }))
    expect(connect.accounts).toHaveBeenCalledWith('co-1', expect.objectContaining({ party, consentId: 'consent-1' }))

    mocks.readConfig.mockResolvedValue({ token: 'tok', connection: { id: CONNECTION, aggregator: 'open_payments' } })
    mocks.disconnect.mockResolvedValue({ connection_id: CONNECTION, session_id: 'consent-1', bank_name: 'Sparbanken Nord', released_cash_accounts: 1 })
    mocks.serviceRpc.mockImplementation(async (name: string) => (name === 'claim_bank_session_revocation' ? { data: { claimed: true, token: 'claim-1' }, error: null } : { data: true, error: null }))
    const gone = stub({ bank_connections: [{ data: row({ status: 'active', affiliated_aspsp_id: '08999' }), error: null }], ...orgAnswers() })
    expect(await disconnectBankFeedConnection({ ...ctx, supabase: gone.supabase }, CONNECTION)).toEqual({ ok: true, data: { connection_id: CONNECTION } })
    expect(connect.revokeConsent).toHaveBeenCalledWith('co-1', { party, consentId: 'consent-1' })
  })
})

describe('restartBankFeedConsent', () => {
  it('restarts a redirect attempt on the bank\'s page with the row\'s return page, and refuses one that cannot come back', async () => {
    const connect = fakeConnect({ startConsentSigning: vi.fn().mockResolvedValue(REDIRECT_STARTED('https://bank.example/sign-2', 'auth-r2')) })
    mocks.connect.mockReturnValue(connect)
    const failedRow = row({ consent_attempt: { method: 'redirect', state: 'failed', failure_code: 'SIGNING_SESSION_PSU_CANCELLED', return_to: 'banking' } })
    const { supabase, payload } = stub({ bank_connections: [{ data: failedRow, error: null }, { data: null, error: null }], ...orgAnswers() })
    const result = await restartBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION, returnOrigin: ORIGIN, now: NOW })
    expect(result).toMatchObject({ ok: true, data: { connection_id: CONNECTION, attempt: { authorisation_id: 'auth-r2', method: 'redirect', state: 'pending', challenge: expect.objectContaining({ redirectUrl: 'https://bank.example/sign-2' }) } } })
    expect(connect.startConsentSigning).toHaveBeenCalledWith('co-1', expect.objectContaining({ method: 'redirect', returnUrl: `${ORIGIN}/settings/banking?bank_connect=${CONNECTION}`, returnState: CONNECTION }))
    expect(payload('bank_connections', 'update')[0]).toMatchObject({ authorization_id: 'auth-r2', consent_attempt: expect.objectContaining({ method: 'redirect', state: 'pending', return_to: 'banking' }) })

    // The restart may name another page; the body's wins over the row's.
    const elsewhere = stub({ bank_connections: [{ data: failedRow, error: null }, { data: null, error: null }], ...orgAnswers() })
    await restartBankFeedConsent({ ...ctx, supabase: elsewhere.supabase }, { connectionId: CONNECTION, returnTo: 'onboarding', returnOrigin: ORIGIN, now: NOW })
    expect(connect.startConsentSigning).toHaveBeenLastCalledWith('co-1', expect.objectContaining({ returnUrl: `${ORIGIN}/onboarding/books?station=bank&bank_connect=${CONNECTION}` }))

    const bare = stub({ bank_connections: [{ data: failedRow, error: null }], ...orgAnswers() })
    expect(await restartBankFeedConsent({ ...ctx, supabase: bare.supabase }, { connectionId: CONNECTION })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'return_to' } })
  })

  it('starts a new authorisation for the same consent with the row\'s method, and a new consent when the first is over', async () => {
    const connect = fakeConnect({ startConsentSigning: vi.fn().mockRejectedValueOnce(new ConsentOverError('over')).mockResolvedValue({ providerAuthorisationId: 'auth-2', method: 'qr', state: 'pending', challenge: CHALLENGE, failureCode: null, scaStatus: null }) })
    mocks.connect.mockReturnValue(connect)
    const { supabase, payload } = stub({ bank_connections: [{ data: row({ consent_attempt: { method: 'same_device', state: 'failed', failure_code: 'SIGNING_SESSION_EXPIRED' } }), error: null }, { data: null, error: null }, { data: null, error: null }], ...orgAnswers() })
    const result = await restartBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION, now: NOW })
    expect(result).toMatchObject({ ok: true, data: { connection_id: CONNECTION, attempt: { authorisation_id: 'auth-2', method: 'same_device', state: 'pending', step: null } } })
    expect(connect.createConsent).toHaveBeenCalledTimes(1)
    expect(payload('bank_connections', 'update')[0]).toMatchObject({ session_id: 'consent-1', consent_expires: '2027-04-10T23:59:59Z', authorization_id: null })
    expect(connect.startConsentSigning).toHaveBeenLastCalledWith('co-1', expect.objectContaining({ consentId: 'consent-1', method: 'same_device' }))
  })

  it('refuses a connection that is not pending', async () => {
    mocks.connect.mockReturnValue(fakeConnect())
    const { supabase } = stub({ bank_connections: [{ data: row({ status: 'active' }), error: null }] })
    expect(await restartBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION })).toEqual({ ok: false, code: 'BANK_CONSENT_CHANGED' })
  })
})

describe('selectBankFeedAccounts', () => {
  const stored = [
    { uid: 'ACC003', currency: 'SEK', enabled: true, iban: 'SE8050000000052131234567', name: 'Företagskonto' },
    { uid: 'ACC001', currency: 'SEK', enabled: false, iban: 'SE7750000000056990607246', name: 'Privatkonto' },
  ]

  it('saves the selection with the IBAN\'s existing cash row reused, hands over the replaced Enable Banking row and runs the first import', async () => {
    mocks.connect.mockReturnValue(fakeConnect())
    mocks.readConfig.mockResolvedValue({ token: 'tok', connection: { id: CONNECTION, status: 'pending_selection', session_id: 'consent-1', bank_name: 'Swedbank', accounts_data: stored, aggregator: 'open_payments' } })
    mocks.saveSelection.mockResolvedValue({ status: 'active', accounts: stored })
    mocks.runSync.mockResolvedValue({ ok: true, connection_id: CONNECTION, bank: 'Swedbank', imported: 120, duplicates: 3, from_date: '2024-09-12', to_date: '2026-10-12', last_synced_at: 'x' })
    const pending = row({ status: 'pending_selection', accounts_data: stored, consent_attempt: { selection: { replace_connection_id: EB_ROW, extended_history_days: 760, listing_only: false } } })
    const { supabase, rpc } = stub({
      bank_connections: [{ data: pending, error: null }, { data: { ...pending, status: 'active' }, error: null }, { data: { ...pending, status: 'active', last_synced_at: 'x' }, error: null }],
      cash_accounts: [{ data: [{ id: 'cash-1', iban: 'SE8050000000052131234567', currency: 'SEK', ledger_account: '1930' }], error: null }],
      'rpc:supersede_enable_banking_connection': [{ data: { superseded: [{ id: EB_ROW, session_id: 'eb-sess' }], moved_transactions: 12, released_cash_accounts: 0 }, error: null }],
    })
    const result = await selectBankFeedAccounts({ ...ctx, supabase }, {
      connectionId: CONNECTION,
      accounts: [{ uid: 'ACC003', enabled: true, ledgerAccount: '1930' }, { uid: 'ACC001', enabled: false, ledgerAccount: null }],
      signer, now: NOW,
    })
    expect(result).toMatchObject({ ok: true, data: { sync: { imported: 120, duplicates: 3, from: '2024-09-12', to: '2026-10-12' }, sync_pending: false, connection: { connection_id: CONNECTION, status: 'active' } } })
    expect(mocks.saveSelection).toHaveBeenCalledWith(supabase, 'co-1', 'user-1', CONNECTION, 'tok', [
      { uid: 'ACC003', enabled: true, currency: 'SEK', ledger_account: '1930', reuse_cash_account_id: 'cash-1' },
      { uid: 'ACC001', enabled: false, currency: 'SEK', reuse_cash_account_id: null },
    ])
    expect(rpc).toHaveBeenCalledWith('supersede_enable_banking_connection', { p_company_id: 'co-1', p_user_id: 'user-1', p_new: CONNECTION, p_old: EB_ROW })
    expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'bank_connection.superseded', payload: expect.objectContaining({ connectionId: EB_ROW }) }))
    expect(mocks.runSync).toHaveBeenCalledWith(supabase, expect.objectContaining({ connectionId: CONNECTION, trigger: 'initial', signer }))
  })

  it('refuses a consent still signing, an unknown account, a non-bank ledger and nothing selected', async () => {
    mocks.connect.mockReturnValue(fakeConnect())
    const signing = stub({ bank_connections: [{ data: row(), error: null }] })
    expect(await selectBankFeedAccounts({ ...ctx, supabase: signing.supabase }, { connectionId: CONNECTION, accounts: [{ uid: 'ACC003', enabled: true }] })).toEqual({ ok: false, code: 'BANK_CONSENT_NOT_READY' })
    mocks.readConfig.mockResolvedValue({ token: 'tok', connection: { id: CONNECTION, status: 'pending_selection', session_id: 'consent-1', bank_name: 'Swedbank', accounts_data: stored, aggregator: 'open_payments' } })
    const picker = () => stub({ bank_connections: [{ data: row({ status: 'pending_selection', accounts_data: stored }), error: null }] })
    expect(await selectBankFeedAccounts({ ...ctx, supabase: picker().supabase }, { connectionId: CONNECTION, accounts: [{ uid: 'nope', enabled: true }] })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { reason: 'unknown_account' } })
    expect(await selectBankFeedAccounts({ ...ctx, supabase: picker().supabase }, { connectionId: CONNECTION, accounts: [{ uid: 'ACC003', enabled: true, ledgerAccount: '3001' }] })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { reason: 'not_a_bank_account' } })
    expect(await selectBankFeedAccounts({ ...ctx, supabase: picker().supabase }, { connectionId: CONNECTION, accounts: [{ uid: 'ACC003', enabled: false }] })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { reason: 'none_selected' } })
  })

  it('for Svea creates the second consent naming the chosen IBANs, keeps the selection on the row and answers the attempt', async () => {
    const connect = fakeConnect({ createConsent: vi.fn().mockResolvedValue({ consentId: 'consent-2', consentStatus: 'received', validUntil: '2027-04-10' }) })
    mocks.connect.mockReturnValue(connect)
    const listing = row({ status: 'pending_selection', bic: 'SVEASESS', accounts_data: stored, consent_attempt: { selection: { listing_only: true, extended_history_days: 365, replace_connection_id: null } } })
    const { supabase, payload } = stub({ bank_connections: [{ data: listing, error: null }, { data: null, error: null }, { data: null, error: null }], ...orgAnswers() })
    const result = await selectBankFeedAccounts({ ...ctx, supabase }, { connectionId: CONNECTION, accounts: [{ uid: 'ACC003', enabled: true, ledgerAccount: '1930' }, { uid: 'ACC001', enabled: false, ledgerAccount: null }], method: 'qr', signer, now: NOW })
    expect(result).toMatchObject({ ok: true, data: { sync: null, sync_pending: false, attempt: { authorisation_id: 'auth-1', method: 'qr', state: 'pending' }, connection: { status: 'pending' } } })
    expect(connect.createConsent).toHaveBeenCalledWith('co-1', expect.objectContaining({ accounts: [{ iban: 'SE8050000000052131234567' }] }))
    expect(connect.revokeConsent).toHaveBeenCalledWith('co-1', expect.objectContaining({ consentId: 'consent-1' }))
    expect(payload('bank_connections', 'update')[0]).toMatchObject({
      session_id: 'consent-2', status: 'pending', authorization_id: null,
      consent_attempt: expect.objectContaining({ listing_only: false, selection: expect.objectContaining({ listing_only: false, accounts: [{ uid: 'ACC003', enabled: true, ledger_account: '1930' }, { uid: 'ACC001', enabled: false, ledger_account: null }] }) }),
    })
    expect(mocks.saveSelection).not.toHaveBeenCalled()
  })
})

describe('disconnectBankFeedConnection', () => {
  it('releases the connection locally, then ends the consent under the openpayments claim', async () => {
    mocks.connect.mockReturnValue(fakeConnect())
    mocks.readConfig.mockResolvedValue({ token: 'tok', connection: { id: CONNECTION, aggregator: 'open_payments' } })
    mocks.disconnect.mockResolvedValue({ connection_id: CONNECTION, session_id: 'consent-1', bank_name: 'Swedbank', released_cash_accounts: 1 })
    mocks.serviceRpc.mockImplementation(async (name: string) => name === 'claim_bank_session_revocation' ? { data: { claimed: true, token: 'claim-1' }, error: null } : { data: true, error: null })
    const { supabase } = stub({ bank_connections: [{ data: row({ status: 'active' }), error: null }], ...orgAnswers() })
    expect(await disconnectBankFeedConnection({ ...ctx, supabase }, CONNECTION)).toEqual({ ok: true, data: { connection_id: CONNECTION } })
    expect(mocks.disconnect).toHaveBeenCalledWith(supabase, 'co-1', 'user-1', CONNECTION, 'tok')
    expect(mocks.serviceRpc).toHaveBeenCalledWith('claim_bank_session_revocation', { p_provider: 'openpayments', p_session_id: 'consent-1' })
    expect(mocks.serviceRpc).toHaveBeenCalledWith('finish_bank_session_revocation', { p_provider: 'openpayments', p_session_id: 'consent-1', p_claim_token: 'claim-1', p_succeeded: true })
    expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'bank_connection.revoked' }))
  })

  it('keeps the local disconnect when the bank cannot be reached, and answers NOT_FOUND for a stranger\'s row', async () => {
    mocks.connect.mockReturnValue(fakeConnect({ revokeConsent: vi.fn().mockRejectedValue(new ProviderUnavailableError('down', { code: 'CONNECTOR_UNREACHABLE' })) }))
    mocks.readConfig.mockResolvedValue({ token: 'tok', connection: { id: CONNECTION, aggregator: 'open_payments' } })
    mocks.disconnect.mockResolvedValue({ connection_id: CONNECTION, session_id: 'consent-1', bank_name: 'Swedbank', released_cash_accounts: 0 })
    mocks.serviceRpc.mockImplementation(async (name: string) => name === 'claim_bank_session_revocation' ? { data: { claimed: true, token: 'claim-1' }, error: null } : { data: true, error: null })
    const { supabase } = stub({ bank_connections: [{ data: row({ status: 'active' }), error: null }], ...orgAnswers() })
    expect(await disconnectBankFeedConnection({ ...ctx, supabase }, CONNECTION)).toMatchObject({ ok: true })
    expect(mocks.serviceRpc).toHaveBeenCalledWith('finish_bank_session_revocation', expect.objectContaining({ p_succeeded: false }))
    const none = stub({ bank_connections: [{ data: null, error: null }] })
    expect(await disconnectBankFeedConnection({ ...ctx, supabase: none.supabase }, CONNECTION)).toEqual({ ok: false, code: 'NOT_FOUND' })
  })
})
