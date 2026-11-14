import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  door: vi.fn(),
  uncoveredPilot: vi.fn(),
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
  storedPsu: vi.fn(),
  rememberPsu: vi.fn(),
}))
vi.mock('../door', () => ({ openBankFeedDoor: (...a: unknown[]) => mocks.door(...a), reachesUncoveredBanks: (...a: unknown[]) => mocks.uncoveredPilot(...a) }))
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
vi.mock('@/lib/auth/resource-psu', () => ({
  storedConnectionPsu: (...a: unknown[]) => mocks.storedPsu(...a),
  rememberConnectionPsu: (...a: unknown[]) => mocks.rememberPsu(...a),
}))

import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import { BankFeedRefusedError, ConsentOverError, ProviderUnavailableError, type BankFeedConnect } from '../connect'
import {
  INITIAL_SYNC_ANSWER_MS,
  INITIAL_SYNC_WAIT_MS,
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
  // The app origin these tests sign from is the canonical one: returns go to it directly (a brand host's would go through the hop).
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
  vi.clearAllMocks()
  mocks.signerOnFile.mockResolvedValue('199001011239')
  mocks.hasSigner.mockResolvedValue(true)
  mocks.storedPsu.mockResolvedValue(null)
  mocks.rememberPsu.mockResolvedValue(undefined)
  mocks.emit.mockResolvedValue(undefined)
  mocks.resolveLedger.mockResolvedValue({ ledgerAccount: '1931', reuseCashAccountId: null, source: 'allocated' })
  mocks.uncoveredPilot.mockReturnValue(false)
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
    expect(await listBankFeedBanks(ctx)).toEqual({ ok: true, data: { banks: [{ bic: 'SWEDSESS', name: 'Swedbank', logo_url: null, decoupled: true, redirect: null, reached: true }] } })
  })

  it('says a bank on the coverage list is not reached, unless the company is in the pilot for those', async () => {
    const banks = vi.fn().mockResolvedValue([
      { bic: 'SWEDSESS', name: 'Swedbank', logoUrl: null, decoupled: true, redirect: null },
      { bic: 'SVEASESS', name: 'Svea Bank', logoUrl: null, decoupled: false, redirect: true },
    ])
    mocks.door.mockResolvedValue({ ok: true, connect: fakeConnect({ banks }) })
    const reached = async () => {
      const outcome = await listBankFeedBanks(ctx)
      return outcome.ok && !outcome.dryRun ? outcome.data.banks.map((b) => [b.bic, b.reached]) : outcome
    }
    expect(await reached()).toEqual([['SWEDSESS', true], ['SVEASESS', false]])
    mocks.uncoveredPilot.mockReturnValue(true)
    expect(await reached()).toEqual([['SWEDSESS', true], ['SVEASESS', true]])
    expect(mocks.uncoveredPilot).toHaveBeenCalledWith('co-1')
  })
})

describe('startBankFeedConsent', () => {
  it('says another connection or attempt holds the company\'s place when Connect refuses over the quota, not that the bank refused', async () => {
    const connect = fakeConnect({ createConsent: vi.fn().mockRejectedValue(new BankFeedRefusedError('Bank connection quota reached for this company', { code: 'CONNECTOR_QUOTA_EXCEEDED', status: 403 })) })
    mocks.door.mockResolvedValue({ ok: true, connect })
    const { supabase } = stub({
      ...orgAnswers(),
      companies: [{ data: { entity_type: 'aktiebolag' }, error: null }],
      bank_connections: [{ data: [], error: null }],
    })
    expect(await startBankFeedConsent({ ...ctx, supabase }, { bic: 'SWEDSESS', method: 'qr', signer, replaceConnectionId: null, now: NOW })).toEqual({ ok: false, code: 'BANK_CONNECTION_IN_PROGRESS' })
    // Nothing the company holds could be freed: no second ask, nothing ended.
    expect(connect.createConsent).toHaveBeenCalledTimes(1)
    expect(connect.revokeConsent).not.toHaveBeenCalled()
  })

  describe('when Connect refuses a new consent over the company\'s one bank connection (crm#1363)', () => {
    const quota = () => new BankFeedRefusedError('Bank connection quota reached for this company', { code: 'CONNECTOR_QUOTA_EXCEEDED', status: 403 })
    const created = { consentId: 'consent-1', consentStatus: 'received', validUntil: '2027-04-10' }
    const claims = () =>
      mocks.serviceRpc.mockImplementation(async (name: string) =>
        name === 'claim_bank_session_revocation' ? { data: { claimed: true, token: 'claim-1' }, error: null } : { data: true, error: null })
    const order = (fn: unknown, call = 0) => (fn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[call]

    it('a renewal ends the consent it replaces and asks once more', async () => {
      const OLD = '7a6c1a2b-9c0d-4e8f-8a1b-2c3d4e5f6a7b'
      const connect = fakeConnect({ createConsent: vi.fn().mockRejectedValueOnce(quota()).mockResolvedValueOnce(created) })
      mocks.door.mockResolvedValue({ ok: true, connect })
      const { supabase } = stub({
        ...orgAnswers(),
        companies: [{ data: { entity_type: 'aktiebolag' }, error: null }],
        bank_connections: [
          { data: { id: OLD, status: 'error', aggregator: 'open_payments', bic: 'SWEDSESS', affiliated_aspsp_id: null, bank_name: 'Swedbank', psu_type: 'business', session_id: 'consent-0' }, error: null },
          { data: [], error: null },
          { data: [], error: null },
          { data: row({ authorization_id: null }), error: null },
          { data: null, error: null },
        ],
      })
      const result = await startBankFeedConsent({ ...ctx, supabase }, { bic: 'SWEDSESS', method: 'qr', signer, replaceConnectionId: OLD, now: NOW })
      expect(result).toMatchObject({ ok: true, data: { connection_id: CONNECTION, attempt: { state: 'pending' } } })
      expect(connect.revokeConsent).toHaveBeenCalledWith('co-1', expect.objectContaining({ consentId: 'consent-0' }))
      expect(connect.createConsent).toHaveBeenCalledTimes(2)
      expect(order(connect.revokeConsent)).toBeLessThan(order(connect.createConsent, 1))
      // A Connect without replacements refused the named one; the second ask
      // names nothing, since the consent it replaced has just been ended.
      const asks = (connect.createConsent as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1] as Record<string, unknown>)
      expect(asks[0]).toMatchObject({ replacesConsentId: 'consent-0' })
      expect(asks[1]).not.toHaveProperty('replacesConsentId')
      expect(asks[1]).not.toHaveProperty('replacedPersonalNumber')
    })

    it('ends the consent of a removed connection the bank did not end at the time, clears it from the row, and asks once more', async () => {
      claims()
      const connect = fakeConnect({ createConsent: vi.fn().mockRejectedValueOnce(quota()).mockResolvedValueOnce(created) })
      mocks.door.mockResolvedValue({ ok: true, connect })
      const removed = row({ id: EB_ROW, status: 'revoked', session_id: null, authorization_id: null, consent_attempt: { selection: { listing_only: false }, unended_consent_id: 'consent-gone' } })
      const { supabase, payload } = stub({
        ...orgAnswers(),
        companies: [{ data: { entity_type: 'aktiebolag' }, error: null }],
        bank_connections: [
          { data: [], error: null },
          { data: [removed], error: null },
          { data: null, error: null },
          { data: row({ authorization_id: null }), error: null },
          { data: null, error: null },
        ],
      })
      const result = await startBankFeedConsent({ ...ctx, supabase }, { bic: 'SWEDSESS', method: 'qr', signer, replaceConnectionId: null, now: NOW })
      expect(result).toMatchObject({ ok: true, data: { connection_id: CONNECTION } })
      expect(mocks.serviceRpc).toHaveBeenCalledWith('claim_bank_session_revocation', { p_provider: 'openpayments', p_session_id: 'consent-gone' })
      expect(connect.revokeConsent).toHaveBeenCalledWith('co-1', expect.objectContaining({ consentId: 'consent-gone' }))
      expect(mocks.serviceRpc).toHaveBeenCalledWith('finish_bank_session_revocation', expect.objectContaining({ p_session_id: 'consent-gone', p_succeeded: true }))
      expect(payload('bank_connections', 'update')[0]).toEqual({ consent_attempt: { selection: { listing_only: false } } })
      expect(connect.createConsent).toHaveBeenCalledTimes(2)
      expect(order(connect.revokeConsent)).toBeLessThan(order(connect.createConsent, 1))
    })

    it('keeps the refusal and the unended consent on the row when the bank still does not end it', async () => {
      claims()
      const connect = fakeConnect({
        createConsent: vi.fn().mockRejectedValue(quota()),
        revokeConsent: vi.fn().mockRejectedValue(new ProviderUnavailableError('down', { code: 'CONNECTOR_AIS_PROVIDER_FAILED' })),
      })
      mocks.door.mockResolvedValue({ ok: true, connect })
      const removed = row({ id: EB_ROW, status: 'revoked', session_id: null, consent_attempt: { unended_consent_id: 'consent-gone' } })
      const { supabase, payload } = stub({
        ...orgAnswers(),
        companies: [{ data: { entity_type: 'aktiebolag' }, error: null }],
        bank_connections: [{ data: [], error: null }, { data: [removed], error: null }],
      })
      expect(await startBankFeedConsent({ ...ctx, supabase }, { bic: 'SWEDSESS', method: 'qr', signer, replaceConnectionId: null, now: NOW })).toEqual({ ok: false, code: 'BANK_CONNECTION_IN_PROGRESS' })
      expect(mocks.serviceRpc).toHaveBeenCalledWith('finish_bank_session_revocation', expect.objectContaining({ p_succeeded: false }))
      expect(payload('bank_connections', 'update')).toEqual([])
      expect(connect.createConsent).toHaveBeenCalledTimes(1)
    })

    it('frees nothing for any other refusal', async () => {
      const connect = fakeConnect({ createConsent: vi.fn().mockRejectedValue(new BankFeedRefusedError('refused', { code: 'CONNECTOR_AIS_REFUSED', status: 422 })) })
      mocks.door.mockResolvedValue({ ok: true, connect })
      const { supabase, calls } = stub({
        ...orgAnswers(),
        companies: [{ data: { entity_type: 'aktiebolag' }, error: null }],
        bank_connections: [{ data: [], error: null }],
      })
      expect(await startBankFeedConsent({ ...ctx, supabase }, { bic: 'SWEDSESS', method: 'qr', signer, replaceConnectionId: null, now: NOW })).toMatchObject({ ok: false, code: 'BANK_PROVIDER_REFUSED' })
      expect(calls).not.toContainEqual(expect.objectContaining({ table: 'bank_connections', method: 'not' }))
      expect(connect.revokeConsent).not.toHaveBeenCalled()
      expect(connect.createConsent).toHaveBeenCalledTimes(1)
    })
  })

  it('creates the consent, stores the pending attempt with provider open_payments and starts BankID', async () => {
    const connect = fakeConnect()
    mocks.door.mockResolvedValue({ ok: true, connect })
    const { supabase, payload, calls } = stub({
      ...orgAnswers(),
      companies: [{ data: { entity_type: 'aktiebolag' }, error: null }],
      bank_connections: [
        { data: [{ id: 'stale', bic: 'ESSESESS', created_at: '2026-10-01T00:00:00Z', session_id: 'consent-old', consent_attempt: { state: 'pending', started_at: '2026-10-01T00:00:00Z' } }, { id: 'joint', bic: 'SWEDSESS', created_at: '2026-10-01T00:00:00Z', session_id: 'consent-joint', consent_attempt: { state: 'partially_authorised' } }], error: null },
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
    // The abandoned attempt's consent is ended before the new one is created, so
    // it cannot hold the company's one bank connection at Connect; the joint
    // attempt waiting for its second signatory is left alone.
    expect(connect.revokeConsent).toHaveBeenCalledTimes(1)
    expect(connect.revokeConsent).toHaveBeenCalledWith('co-1', expect.objectContaining({ consentId: 'consent-old' }))
    expect((connect.revokeConsent as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan((connect.createConsent as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
    expect(payload('bank_connections', 'insert')[0]).toMatchObject({
      aggregator: 'open_payments', provider: 'open_payments', bank_name: 'Swedbank', bic: 'SWEDSESS', session_id: 'consent-1', status: 'pending', psu_type: 'business',
      consent_expires: '2027-04-10T21:59:59Z',
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

  it('renews an Open Payments row: the row fixes the bank, sparbank, name and agreement, no Enable Banking handover is recorded, and finalize supersedes the old row', async () => {
    const OLD = '7a6c1a2b-9c0d-4e8f-8a1b-2c3d4e5f6a7b'
    const connect = fakeConnect()
    mocks.door.mockResolvedValue({ ok: true, connect })
    const inserted = row({ authorization_id: null, bank_name: 'Sparbanken Nord', affiliated_aspsp_id: '08999', psu_type: 'personal', consent_attempt: { method: 'qr', state: 'pending', replace_connection_id: null } })
    const { supabase, payload, calls } = stub({
      ...orgAnswers(),
      companies: [{ data: { entity_type: 'aktiebolag' }, error: null }],
      bank_connections: [
        { data: { id: OLD, status: 'active', aggregator: 'open_payments', bic: 'SWEDSESS', affiliated_aspsp_id: '08999', bank_name: 'Sparbanken Nord', psu_type: 'personal', session_id: 'consent-0' }, error: null },
        { data: [], error: null },
        { data: inserted, error: null },
        { data: null, error: null },
      ],
    })
    // The old consent was created with another signatory's number than the one renewing now.
    mocks.storedPsu.mockImplementation(async (id: string) => (id === OLD ? { personalNumber: '198001011234', source: 'typed' } : null))
    // The browser resolved the sparbank to Swedbank's BIC and sends its default context; the row wins on both.
    const result = await startBankFeedConsent({ ...ctx, supabase }, { bic: 'SWEDSESS', method: 'qr', signer, accountContext: 'corporate', replaceConnectionId: OLD, now: NOW })
    expect(result).toMatchObject({ ok: true, data: { connection_id: CONNECTION, attempt: { state: 'pending' } } })
    expect(payload('bank_connections', 'insert')[0]).toMatchObject({ bank_name: 'Sparbanken Nord', bic: 'SWEDSESS', affiliated_aspsp_id: '08999', psu_type: 'personal', consent_attempt: expect.objectContaining({ replace_connection_id: null, renews_connection_id: OLD }) })
    expect(connect.createConsent).toHaveBeenCalledWith('co-1', expect.objectContaining({ party: expect.objectContaining({ affiliatedAspspId: '08999', accountContext: 'private' }) }))
    // The old consent stays live until the new one is valid: named, with the
    // number it was created with, and never ended here.
    expect(connect.createConsent).toHaveBeenCalledWith('co-1', expect.objectContaining({ replacesConsentId: 'consent-0', replacedPersonalNumber: '198001011234' }))
    expect(connect.revokeConsent).not.toHaveBeenCalled()
    expect(calls.some((c) => c.table.startsWith('rpc:supersede_enable_banking'))).toBe(false)

    // Once the new consent is valid, finalize supersedes the old row of the same bank (by name), and the feed says so.
    mocks.connect.mockReturnValue(fakeConnect({ pollConsentSigning: vi.fn().mockResolvedValue({ state: 'valid', challenge: null, failureCode: null, scaStatus: 'finalised', consentStatus: 'valid', validUntil: '2027-04-10' }) }))
    const stored = [{ uid: 'ACC003', currency: 'SEK', enabled: true, iban: 'SE8050000000052131234567', name: 'Företagskonto' }]
    mocks.serviceRpc.mockResolvedValue({ data: { connection_id: CONNECTION, accounts: stored, superseded: [{ id: OLD, session_id: 'consent-0' }], already_finalized: false }, error: null })
    const polled = stub({ bank_connections: [{ data: { ...inserted, authorization_id: 'auth-1' }, error: null }, { data: null, error: null }], ...orgAnswers() })
    expect(await pollBankFeedConsent({ ...ctx, supabase: polled.supabase }, { connectionId: CONNECTION })).toMatchObject({ ok: true, data: { state: 'valid', status: 'pending_selection' } })
    expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'bank_connection.superseded', payload: expect.objectContaining({ connectionId: OLD, supersededById: CONNECTION }) }))

    // A browser naming another bank for a renewal is refused before anything is created.
    const elsewhere = stub({ ...orgAnswers(), bank_connections: [{ data: { id: OLD, status: 'active', aggregator: 'open_payments', bic: 'SWEDSESS', affiliated_aspsp_id: null, bank_name: 'Swedbank', psu_type: 'business' }, error: null }] })
    expect(await startBankFeedConsent({ ...ctx, supabase: elsewhere.supabase }, { bic: 'ESSESESS', method: 'qr', signer, replaceConnectionId: OLD, now: NOW })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'bic', reason: 'renewal_other_bank' } })
    expect(connect.createConsent).toHaveBeenCalledTimes(1)
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
    const gone = stub({ ...orgAnswers(), bank_connections: [{ data: null, error: null }] })
    expect(await startBankFeedConsent({ ...ctx, supabase: gone.supabase }, { bic: 'SWEDSESS', method: 'qr', signer, replaceConnectionId: EB_ROW })).toMatchObject({ ok: false, code: 'NOT_FOUND', details: { field: 'replace_connection_id' } })
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

  it('a white-label host signs at the bank with a return through the hop on the canonical origin, the brand page named', async () => {
    const connect = fakeConnect({ bank: vi.fn().mockResolvedValue({ ...BANK, decoupled: false, redirect: true }), startConsentSigning: vi.fn().mockResolvedValue(REDIRECT_STARTED('https://bank.example/sign')) })
    mocks.door.mockResolvedValue({ ok: true, connect })
    const { supabase } = stub({
      ...orgAnswers(), ...company(),
      bank_connections: [{ data: [], error: null }, { data: row({ authorization_id: null }), error: null }, { data: null, error: null }],
    })
    const brand = 'https://app.brand.example'
    expect(await startBankFeedConsent({ ...ctx, supabase }, { bic: 'SWEDSESS', method: 'qr', signer, returnTo: 'connections', returnOrigin: brand, now: NOW })).toMatchObject({ ok: true })
    const sent = (connect.startConsentSigning as ReturnType<typeof vi.fn>).mock.calls[0][1] as { returnUrl: string }
    const hop = new URL(sent.returnUrl)
    expect(hop.origin).toBe('https://app.accounted.se')
    expect(hop.pathname).toBe('/api/bank/return')
    expect(hop.searchParams.get('to')).toBe(`${brand}/settings/connections?bank_connect=${CONNECTION}`)
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

  it('creates the consent for the way it will be signed: the bank\'s page asked for before the consent exists, our screen otherwise', async () => {
    // SEB refused every "Signera hos banken" from a phone: the consent was
    // created for BankID in our screen and the signing asked for the bank's
    // page ("request does not match the SCA flow the resource was created with").
    const both = fakeConnect({ bank: vi.fn().mockResolvedValue({ ...BANK, redirect: true }), startConsentSigning: vi.fn().mockResolvedValue(REDIRECT_STARTED('https://bank.example/sign')) })
    mocks.door.mockResolvedValue({ ok: true, connect: both })
    const page = stub({ ...orgAnswers(), ...company(), bank_connections: [{ data: [], error: null }, { data: row({ authorization_id: null }), error: null }, { data: null, error: null }] })
    expect(await startBankFeedConsent({ ...ctx, supabase: page.supabase }, { bic: 'SWEDSESS', method: 'redirect', signer, returnTo: 'connections', returnOrigin: ORIGIN, now: NOW })).toMatchObject({ ok: true, data: { attempt: { method: 'redirect' } } })
    expect((both.createConsent as ReturnType<typeof vi.fn>).mock.calls[0][1].party).toMatchObject({ bic: 'SWEDSESS', redirectPreferred: true })

    const screen = fakeConnect({ bank: vi.fn().mockResolvedValue({ ...BANK, redirect: true }) })
    mocks.door.mockResolvedValue({ ok: true, connect: screen })
    const qr = stub({ ...orgAnswers(), ...company(), bank_connections: [{ data: [], error: null }, { data: row({ authorization_id: null }), error: null }, { data: null, error: null }] })
    expect(await startBankFeedConsent({ ...ctx, supabase: qr.supabase }, { bic: 'SWEDSESS', method: 'qr', signer, returnTo: 'connections', returnOrigin: ORIGIN, now: NOW })).toMatchObject({ ok: true, data: { attempt: { method: 'qr' } } })
    expect((screen.createConsent as ReturnType<typeof vi.fn>).mock.calls[0][1].party).not.toHaveProperty('redirectPreferred')
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
    // PSU-ID on the poll too: the signed-in person's number on file when none was typed.
    expect(connect.pollConsentSigning).toHaveBeenCalledWith('co-1', expect.objectContaining({ party: expect.objectContaining({ personalNumber: '199001011239' }) }))
    expect(mocks.signerOnFile).toHaveBeenCalledWith('user-1')
    expect(payload('bank_connections', 'update')[0]).toMatchObject({ consent_attempt: expect.objectContaining({ state: 'pending', sca_status: 'started' }) })
  })

  it('a typed personnummer on the poll wins over the one on file, and the poll goes on without either', async () => {
    const connect = fakeConnect({ pollConsentSigning: vi.fn().mockResolvedValue({ state: 'pending', challenge: CHALLENGE, failureCode: null, scaStatus: 'started', consentStatus: null, validUntil: null }) })
    mocks.connect.mockReturnValue(connect)
    const typed = stub({ bank_connections: [{ data: row(), error: null }, { data: null, error: null }], ...orgAnswers() })
    await pollBankFeedConsent({ ...ctx, supabase: typed.supabase }, { connectionId: CONNECTION, signer: { ...signer, personalNumber: '900209-2386' } })
    expect(connect.pollConsentSigning).toHaveBeenLastCalledWith('co-1', expect.objectContaining({ party: expect.objectContaining({ personalNumber: '199002092386' }) }))
    mocks.signerOnFile.mockResolvedValue(null)
    const nobody = stub({ bank_connections: [{ data: row(), error: null }, { data: null, error: null }], ...orgAnswers() })
    expect(await pollBankFeedConsent({ ...ctx, supabase: nobody.supabase }, { connectionId: CONNECTION })).toMatchObject({ ok: true, data: { state: 'pending' } })
    expect(connect.pollConsentSigning).toHaveBeenLastCalledWith('co-1', expect.objectContaining({ party: expect.objectContaining({ personalNumber: null }) }))
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
      p_company_id: 'co-1', p_user_id: 'user-1', p_connection_id: CONNECTION, p_consent_id: 'consent-1', p_consent_expires: '2027-03-29T21:59:59Z',
      p_accounts: toStoredAccounts(ACCOUNTS, expect.any(String) as unknown as string).map((a) => ({ ...a, ...(a.balance_updated_at ? { balance_updated_at: expect.any(String) } : {}) })),
    })
    expect(result).toMatchObject({
      ok: true,
      data: {
        state: 'valid', status: 'pending_selection', consent_expires: '2027-03-29T21:59:59Z', needs_second_consent: false,
        accounts: [
          { uid: 'ACC003', preselected: true, enabled: true, suggested_ledger_account: '1930', matches_existing: '1930', ledger_kept: false, iban: 'SE8050000000052131234567' },
          { uid: 'ACC001', preselected: false, enabled: false, suggested_ledger_account: '1931', matches_existing: null, ledger_kept: false },
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
      ok: true, data: { state: 'valid', needs_second_consent: true, accounts: [{ uid: 'ACC003', suggested_ledger_account: '1930', matches_existing: null, ledger_kept: true }] },
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
    expect(result).toMatchObject({ ok: true, data: { state: 'valid', status: 'active', consent_expires: '2027-03-29T21:59:59Z' } })
    expect((result as unknown as { data: Record<string, unknown> }).data.accounts).toBeUndefined()
    expect(mocks.saveSelection).toHaveBeenCalledWith(supabase, 'co-1', 'user-1', CONNECTION, 'tok', [
      { uid: 'ACC003', enabled: true, currency: 'SEK', ledger_account: '1930', reuse_cash_account_id: null },
      { uid: 'ACC001', enabled: false, currency: 'SEK', reuse_cash_account_id: null },
    ])
    expect(mocks.runSync).not.toHaveBeenCalled()
  })

  it('ends Svea\'s listing consent only once the second consent is valid and the selection saved', async () => {
    const connect = fakeConnect({ pollConsentSigning: vi.fn().mockResolvedValue({ state: 'valid', challenge: null, failureCode: null, scaStatus: 'finalised', consentStatus: 'valid', validUntil: '2027-03-29' }) })
    mocks.connect.mockReturnValue(connect)
    const chosen = [{ uid: 'ACC003', enabled: true, ledger_account: '1930' }]
    const second = row({ bic: 'SVEASESS', session_id: 'consent-2', consent_attempt: { method: 'qr', state: 'pending', listing_only: false, listing_consent_id: 'consent-1', selection: { listing_only: false, accounts: chosen, replace_connection_id: null, extended_history_days: 365 } } })
    const stored = [{ uid: 'ACC003', currency: 'SEK', enabled: true, iban: 'SE8050000000052131234567' }]
    mocks.serviceRpc.mockResolvedValue({ data: { connection_id: CONNECTION, accounts: stored, superseded: [], already_finalized: false }, error: null })
    mocks.readConfig.mockResolvedValue({ token: 'tok', connection: { id: CONNECTION, status: 'pending_selection', session_id: 'consent-2', bank_name: 'Svea Bank', accounts_data: stored, aggregator: 'open_payments' } })
    mocks.saveSelection.mockResolvedValue({ status: 'active', accounts: stored })
    const rows = () => [{ data: second, error: null }, { data: { ...second, status: 'pending_selection', accounts_data: stored }, error: null }, { data: { ...second, status: 'active', accounts_data: stored }, error: null }]
    const { supabase } = stub({ bank_connections: rows(), cash_accounts: [{ data: [], error: null }], ...orgAnswers() })
    expect(await pollBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION })).toMatchObject({ ok: true, data: { state: 'valid', status: 'active' } })
    expect(connect.revokeConsent).toHaveBeenCalledTimes(1)
    expect(connect.revokeConsent).toHaveBeenCalledWith('co-1', expect.objectContaining({ consentId: 'consent-1' }))

    // A selection that cannot be saved keeps the listing consent alive.
    mocks.saveSelection.mockRejectedValueOnce(Object.assign(new Error('BANK_CONFIGURATION_CHANGED'), { code: 'BANK_CONFIGURATION_CHANGED' }))
    const again = stub({ bank_connections: rows(), cash_accounts: [{ data: [], error: null }], ...orgAnswers() })
    expect(await pollBankFeedConsent({ ...ctx, supabase: again.supabase }, { connectionId: CONNECTION })).toMatchObject({ ok: false })
    expect(connect.revokeConsent).toHaveBeenCalledTimes(1)
  })

  it('hands over the Enable Banking row reading Svea\'s chosen account when the second consent is valid, even with the switch\'s row lost on the way', async () => {
    mocks.connect.mockReturnValue(fakeConnect({ pollConsentSigning: vi.fn().mockResolvedValue({ state: 'valid', challenge: null, failureCode: null, scaStatus: 'finalised', consentStatus: 'valid', validUntil: '2027-03-29' }) }))
    const chosen = [{ uid: 'ACC003', enabled: true, ledger_account: '1930' }]
    const second = row({ bic: 'SVEASESS', session_id: 'consent-2', consent_attempt: { method: 'qr', state: 'pending', listing_only: false, selection: { listing_only: false, accounts: chosen, replace_connection_id: EB_ROW, extended_history_days: 365 } } })
    const stored = [{ uid: 'ACC003', currency: 'SEK', enabled: true, iban: 'SE8050000000052131234567' }]
    mocks.serviceRpc.mockResolvedValue({ data: { connection_id: CONNECTION, accounts: stored, superseded: [], already_finalized: false }, error: null })
    mocks.readConfig.mockResolvedValue({ token: 'tok', connection: { id: CONNECTION, status: 'pending_selection', session_id: 'consent-2', bank_name: 'Svea Bank', accounts_data: stored, aggregator: 'open_payments' } })
    mocks.saveSelection.mockResolvedValue({ status: 'active', accounts: stored })
    // The row as finalize left it from an attempt written before the fix: no replace_connection_id kept.
    const finalized = { ...second, status: 'pending_selection', accounts_data: stored, consent_attempt: { selection: { listing_only: false } } }
    const { supabase, rpc } = stub({
      bank_connections: [
        { data: second, error: null },
        { data: finalized, error: null },
        { data: [{ id: EB_ROW, aggregator: 'enable_banking', accounts_data: [{ uid: 'eb-1', currency: 'SEK', enabled: true, iban: 'SE8050000000052131234567' }] }], error: null },
        { data: { ...finalized, status: 'active' }, error: null },
      ],
      cash_accounts: [{ data: [], error: null }],
      'rpc:supersede_enable_banking_connection': [{ data: { superseded: [{ id: EB_ROW, session_id: 'eb-sess' }] }, error: null }],
      ...orgAnswers(),
    })
    expect(await pollBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION })).toMatchObject({ ok: true, data: { state: 'valid', status: 'active' } })
    expect(rpc).toHaveBeenCalledWith('supersede_enable_banking_connection', { p_company_id: 'co-1', p_user_id: 'user-1', p_new: CONNECTION, p_old: EB_ROW })
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
    expect(payload('bank_connections', 'update')[0]).toMatchObject({ session_id: 'consent-1', consent_expires: '2027-04-10T21:59:59Z', authorization_id: null })
    expect(connect.startConsentSigning).toHaveBeenLastCalledWith('co-1', expect.objectContaining({ consentId: 'consent-1', method: 'same_device' }))
  })

  it('a renewal whose consent has to be created anew names the renewed row\'s live consent again, with the number it was created with', async () => {
    const OLD = '7a6c1a2b-9c0d-4e8f-8a1b-2c3d4e5f6a7b'
    const connect = fakeConnect({ startConsentSigning: vi.fn().mockRejectedValueOnce(new ConsentOverError('over')).mockResolvedValue({ providerAuthorisationId: 'auth-2', method: 'qr', state: 'pending', challenge: CHALLENGE, failureCode: null, scaStatus: null }) })
    mocks.connect.mockReturnValue(connect)
    mocks.storedPsu.mockImplementation(async (id: string) => (id === OLD ? { personalNumber: '198001011234', source: 'typed' } : null))
    const renewal = row({ consent_attempt: { method: 'qr', state: 'failed', failure_code: 'SIGNING_SESSION_EXPIRED', renews_connection_id: OLD } })
    const { supabase, payload, calls } = stub({
      bank_connections: [
        { data: renewal, error: null },
        { data: { id: OLD, status: 'active', bic: 'SWEDSESS', affiliated_aspsp_id: null, bank_name: 'Swedbank', psu_type: 'business', session_id: 'consent-0' }, error: null },
        { data: null, error: null },
        { data: null, error: null },
      ],
      ...orgAnswers(),
    })
    expect((await restartBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION, now: NOW })).ok).toBe(true)
    expect(calls).toContainEqual({ table: 'bank_connections', method: 'eq', args: ['id', OLD] })
    expect(connect.createConsent).toHaveBeenCalledTimes(1)
    expect(connect.createConsent).toHaveBeenCalledWith('co-1', expect.objectContaining({ replacesConsentId: 'consent-0', replacedPersonalNumber: '198001011234' }))
    expect(connect.revokeConsent).not.toHaveBeenCalled()
    expect(payload('bank_connections', 'update')[0]).toMatchObject({ session_id: 'consent-1', consent_attempt: expect.objectContaining({ renews_connection_id: OLD }) })

    // The renewed row lost its consent meanwhile (revoked): a plain creation.
    const gone = stub({
      bank_connections: [
        { data: renewal, error: null },
        { data: { id: OLD, status: 'revoked', bic: 'SWEDSESS', affiliated_aspsp_id: null, bank_name: 'Swedbank', psu_type: 'business', session_id: 'consent-0' }, error: null },
        { data: null, error: null },
        { data: null, error: null },
      ],
      ...orgAnswers(),
    })
    const plain = fakeConnect({ startConsentSigning: vi.fn().mockRejectedValueOnce(new ConsentOverError('over')).mockResolvedValue({ providerAuthorisationId: 'auth-2', method: 'qr', state: 'pending', challenge: CHALLENGE, failureCode: null, scaStatus: null }) })
    mocks.connect.mockReturnValue(plain)
    expect((await restartBankFeedConsent({ ...ctx, supabase: gone.supabase }, { connectionId: CONNECTION, now: NOW })).ok).toBe(true)
    expect((plain.createConsent as ReturnType<typeof vi.fn>).mock.calls[0][1]).not.toHaveProperty('replacesConsentId')
  })

  it('Svea\'s second consent created anew names the listing consent again; a Connect without replacements gets it ended first', async () => {
    const quota = new BankFeedRefusedError('Bank connection quota reached for this company', { code: 'CONNECTOR_QUOTA_EXCEEDED', status: 403 })
    const connect = fakeConnect({
      startConsentSigning: vi.fn().mockRejectedValueOnce(new ConsentOverError('over')).mockResolvedValue({ providerAuthorisationId: 'auth-2', method: 'qr', state: 'pending', challenge: CHALLENGE, failureCode: null, scaStatus: null }),
      createConsent: vi.fn().mockRejectedValueOnce(quota).mockResolvedValueOnce({ consentId: 'consent-3', consentStatus: 'received', validUntil: '2027-04-10' }),
    })
    mocks.connect.mockReturnValue(connect)
    const second = row({
      bic: 'SVEASESS', session_id: 'consent-2',
      accounts_data: [{ uid: 'ACC003', currency: 'SEK', enabled: true, iban: 'SE8050000000052131234567', name: 'Företagskonto' }],
      consent_attempt: { method: 'qr', state: 'failed', listing_only: false, listing_consent_id: 'consent-1', selection: { listing_only: false, accounts: [{ uid: 'ACC003', enabled: true, ledger_account: '1930' }] } },
    })
    const { supabase, payload } = stub({ bank_connections: [{ data: second, error: null }, { data: null, error: null }, { data: null, error: null }], ...orgAnswers() })
    expect((await restartBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION, now: NOW })).ok).toBe(true)
    const asks = (connect.createConsent as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1] as Record<string, unknown>)
    expect(asks[0]).toMatchObject({ replacesConsentId: 'consent-1', accounts: [{ iban: 'SE8050000000052131234567' }] })
    expect(asks[1]).not.toHaveProperty('replacesConsentId')
    expect(connect.revokeConsent).toHaveBeenCalledWith('co-1', expect.objectContaining({ consentId: 'consent-1' }))
    expect(payload('bank_connections', 'update')[0]).toMatchObject({ session_id: 'consent-3' })
  })

  it('lets a second signatory sign a partially authorised consent: their personnummer, the same consent, no new one', async () => {
    const connect = fakeConnect({ startConsentSigning: vi.fn().mockResolvedValue({ providerAuthorisationId: 'auth-2', method: 'qr', state: 'pending', challenge: CHALLENGE, failureCode: null, scaStatus: 'authenticationStarted' }) })
    mocks.connect.mockReturnValue(connect)
    mocks.signerOnFile.mockResolvedValue(null)
    const joint = row({ user_id: 'first-signer', consent_attempt: { method: 'qr', state: 'partially_authorised', sca_status: 'finalised', started_at: '2026-10-10T09:00:00Z' } })
    const { supabase, payload } = stub({ bank_connections: [{ data: joint, error: null }, { data: null, error: null }], ...orgAnswers() })
    const result = await restartBankFeedConsent({ ...ctx, userId: 'second-signer', supabase }, { connectionId: CONNECTION, method: 'qr', signer: { ...signer, personalNumber: '900209-2386' }, now: NOW })
    expect(result).toMatchObject({ ok: true, data: { connection_id: CONNECTION, attempt: { authorisation_id: 'auth-2', method: 'qr', state: 'pending', step: 'identify' } } })
    expect(connect.createConsent).not.toHaveBeenCalled()
    expect(connect.startConsentSigning).toHaveBeenCalledWith('co-1', expect.objectContaining({ consentId: 'consent-1', method: 'qr', party: expect.objectContaining({ personalNumber: '199002092386' }) }))
    expect(payload('bank_connections', 'update')[0]).toMatchObject({ authorization_id: 'auth-2', consent_attempt: expect.objectContaining({ state: 'pending' }) })
  })

  it('a consent first signed on the bank\'s page is co-signed there, whatever the co-signer\'s screen asked for', async () => {
    // The consent was created for the bank's page (consentPartyFor); the
    // co-signer's screen offers BankID here at a bank that signs both ways.
    const connect = fakeConnect({ startConsentSigning: vi.fn().mockResolvedValue(REDIRECT_STARTED('https://bank.example/co-sign', 'auth-co')) })
    mocks.connect.mockReturnValue(connect)
    mocks.signerOnFile.mockResolvedValue(null)
    const joint = () => row({ user_id: 'first-signer', consent_attempt: { method: 'redirect', state: 'partially_authorised', sca_status: 'finalised', return_to: 'connections', started_at: '2026-10-10T09:00:00Z' } })
    const second = { ...signer, personalNumber: '900209-2386' }
    const { supabase } = stub({ bank_connections: [{ data: joint(), error: null }, { data: null, error: null }], ...orgAnswers() })
    const result = await restartBankFeedConsent({ ...ctx, userId: 'second-signer', supabase }, { connectionId: CONNECTION, method: 'qr', signer: second, returnOrigin: ORIGIN, now: NOW })
    expect(result).toMatchObject({ ok: true, data: { attempt: { method: 'redirect', challenge: expect.objectContaining({ redirectUrl: 'https://bank.example/co-sign' }) } } })
    expect(connect.startConsentSigning).toHaveBeenCalledWith('co-1', expect.objectContaining({ consentId: 'consent-1', method: 'redirect', returnUrl: `${ORIGIN}/settings/connections?bank_connect=${CONNECTION}` }))
    expect(connect.createConsent).not.toHaveBeenCalled()

    // Nowhere to come back to: the asked-for method stands, as after an imposed page.
    const qr = fakeConnect({ startConsentSigning: vi.fn().mockResolvedValue({ providerAuthorisationId: 'auth-q', method: 'qr', state: 'pending', challenge: CHALLENGE, failureCode: null, scaStatus: null }) })
    mocks.connect.mockReturnValue(qr)
    const bare = stub({ bank_connections: [{ data: joint(), error: null }, { data: null, error: null }], ...orgAnswers() })
    await restartBankFeedConsent({ ...ctx, userId: 'second-signer', supabase: bare.supabase }, { connectionId: CONNECTION, method: 'qr', signer: second, now: NOW })
    expect(qr.startConsentSigning).toHaveBeenCalledWith('co-1', expect.objectContaining({ consentId: 'consent-1', method: 'qr' }))
  })

  it('after the bank imposed its own page, a restart that knows where to come back goes there whatever method was asked for', async () => {
    const connect = fakeConnect({ startConsentSigning: vi.fn().mockResolvedValue(REDIRECT_STARTED('https://bank.example/sign-3', 'auth-r3')) })
    mocks.connect.mockReturnValue(connect)
    const imposed = () => row({ consent_attempt: { method: 'qr', state: 'failed', failure_code: 'SCA_REDIRECT_UNSUPPORTED' } })
    const { supabase } = stub({ bank_connections: [{ data: imposed(), error: null }, { data: null, error: null }], ...orgAnswers() })
    const result = await restartBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION, method: 'qr', returnTo: 'connections', returnOrigin: ORIGIN, now: NOW })
    expect(result).toMatchObject({ ok: true, data: { attempt: { method: 'redirect', state: 'pending', challenge: expect.objectContaining({ redirectUrl: 'https://bank.example/sign-3' }) } } })
    expect(connect.startConsentSigning).toHaveBeenCalledWith('co-1', expect.objectContaining({ method: 'redirect', returnUrl: `${ORIGIN}/settings/connections?bank_connect=${CONNECTION}` }))

    // Without a return page the asked-for method stands (and the bank may impose its page again).
    const qr = fakeConnect({ startConsentSigning: vi.fn().mockResolvedValue({ providerAuthorisationId: 'auth-q', method: 'qr', state: 'pending', challenge: CHALLENGE, failureCode: null, scaStatus: null }) })
    mocks.connect.mockReturnValue(qr)
    const bare = stub({ bank_connections: [{ data: imposed(), error: null }, { data: null, error: null }], ...orgAnswers() })
    expect(await restartBankFeedConsent({ ...ctx, supabase: bare.supabase }, { connectionId: CONNECTION, method: 'qr', now: NOW })).toMatchObject({ ok: true, data: { attempt: { method: 'qr' } } })
  })

  describe('when the bank refuses to sign the same consent again', () => {
    const STARTED = { providerAuthorisationId: 'auth-2', method: 'qr', state: 'pending', challenge: CHALLENGE, failureCode: null, scaStatus: null }
    const refusal = (providerCode: string | null) => new BankFeedRefusedError('Connector ais.startConsentSigning: The bank or the bank reading provider refused the request', { code: 'CONNECTOR_AIS_REFUSED', status: 422, providerCode })
    const failed = (attempt: Record<string, unknown> = {}) => row({ consent_attempt: { method: 'qr', state: 'failed', failure_code: 'UNEXPECTED_ERROR', ...attempt } })

    // What the banks answered in production: FORMAT_ERROR "Cannot create
    // consent authorisation when consentStatus is Rejected" (2026-11-02) and
    // UNEXPECTED_ERROR "A consent authorisation already exist for consent ..."
    // (2026-11-09). Both ended in the generic line, on every Försök igen.
    it.each([['FORMAT_ERROR'], ['UNEXPECTED_ERROR'], [null]])('a refusal with no reason for the person (%s) ends that consent and goes on with a new one', async (providerCode) => {
      const connect = fakeConnect({
        startConsentSigning: vi.fn().mockRejectedValueOnce(refusal(providerCode)).mockResolvedValue(STARTED),
        createConsent: vi.fn().mockResolvedValue({ consentId: 'consent-2', consentStatus: 'received', validUntil: '2027-04-10' }),
      })
      mocks.connect.mockReturnValue(connect)
      const { supabase, payload } = stub({ bank_connections: [{ data: failed(), error: null }, { data: null, error: null }, { data: null, error: null }], ...orgAnswers() })
      const result = await restartBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION, now: NOW })
      expect(result).toMatchObject({ ok: true, data: { connection_id: CONNECTION, attempt: { authorisation_id: 'auth-2', method: 'qr', state: 'pending' } } })
      expect(connect.revokeConsent).toHaveBeenCalledWith('co-1', expect.objectContaining({ consentId: 'consent-1' }))
      expect(connect.createConsent).toHaveBeenCalledTimes(1)
      expect(payload('bank_connections', 'update')[0]).toMatchObject({ session_id: 'consent-2', authorization_id: null })
      expect(connect.startConsentSigning).toHaveBeenCalledTimes(2)
      expect(connect.startConsentSigning).toHaveBeenLastCalledWith('co-1', expect.objectContaining({ consentId: 'consent-2', method: 'qr' }))
    })

    it('the new consent is created for the bank\'s page when the restart signs there', async () => {
      const connect = fakeConnect({
        startConsentSigning: vi.fn().mockRejectedValueOnce(refusal('FORMAT_ERROR')).mockResolvedValue(REDIRECT_STARTED('https://bank.example/sign-4', 'auth-r4')),
        createConsent: vi.fn().mockResolvedValue({ consentId: 'consent-2', consentStatus: 'received', validUntil: '2027-04-10' }),
      })
      mocks.connect.mockReturnValue(connect)
      const { supabase } = stub({ bank_connections: [{ data: failed({ method: 'redirect', return_to: 'banking' }), error: null }, { data: null, error: null }, { data: null, error: null }], ...orgAnswers() })
      expect(await restartBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION, returnOrigin: ORIGIN, now: NOW })).toMatchObject({ ok: true, data: { attempt: { method: 'redirect' } } })
      expect((connect.createConsent as ReturnType<typeof vi.fn>).mock.calls[0][1].party).toMatchObject({ redirectPreferred: true })
    })

    it('a refusal that tells the person what to do stands: no new consent, the bank\'s sentence', async () => {
      const connect = fakeConnect({ startConsentSigning: vi.fn().mockRejectedValue(refusal('AUTHENTICATION_SESSION_ONGOING')) })
      mocks.connect.mockReturnValue(connect)
      const { supabase } = stub({ bank_connections: [{ data: failed(), error: null }], ...orgAnswers() })
      const result = await restartBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION, now: NOW })
      expect(result).toMatchObject({ ok: false, code: 'BANK_PROVIDER_REFUSED', details: { provider_code: 'AUTHENTICATION_SESSION_ONGOING' }, messageSv: expect.stringContaining('inloggningssession') })
      expect(connect.createConsent).not.toHaveBeenCalled()
      expect(connect.revokeConsent).not.toHaveBeenCalled()
      expect(connect.startConsentSigning).toHaveBeenCalledTimes(1)
    })

    it('a refusal over the missing office is said as that, and no new consent is created for it (for #208)', async () => {
      const connect = fakeConnect({ startConsentSigning: vi.fn().mockRejectedValue(refusal('AFFILIATED_ASPSP_ID_MISSING')) })
      mocks.connect.mockReturnValue(connect)
      const { supabase } = stub({ bank_connections: [{ data: failed(), error: null }], ...orgAnswers() })
      const result = await restartBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION, now: NOW })
      expect(result).toMatchObject({ ok: false, code: 'BANK_PROVIDER_REFUSED', details: { provider_code: 'AFFILIATED_ASPSP_ID_MISSING' }, messageSv: expect.stringContaining('vilket kontor') })
      expect(connect.createConsent).not.toHaveBeenCalled()
    })

    it('a bank that does not answer is not a refusal: the same consent is there for the next try', async () => {
      const connect = fakeConnect({ startConsentSigning: vi.fn().mockRejectedValue(new ProviderUnavailableError('timeout', { code: 'CONNECTOR_AIS_PROVIDER_FAILED', status: 502, providerCode: 'TIMEOUT' })) })
      mocks.connect.mockReturnValue(connect)
      const { supabase } = stub({ bank_connections: [{ data: failed(), error: null }], ...orgAnswers() })
      expect(await restartBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION, now: NOW })).toMatchObject({ ok: false, code: 'BANK_PROVIDER_UNAVAILABLE' })
      expect(connect.createConsent).not.toHaveBeenCalled()
      expect(connect.revokeConsent).not.toHaveBeenCalled()
    })

    it('a co-signer\'s refusal stands: the partly signed consent is never replaced', async () => {
      const connect = fakeConnect({ startConsentSigning: vi.fn().mockRejectedValue(refusal('FORMAT_ERROR')) })
      mocks.connect.mockReturnValue(connect)
      const joint = row({ user_id: 'first-signer', consent_attempt: { method: 'qr', state: 'partially_authorised', sca_status: 'finalised', started_at: '2026-10-10T09:00:00Z' } })
      const { supabase } = stub({ bank_connections: [{ data: joint, error: null }], ...orgAnswers() })
      expect(await restartBankFeedConsent({ ...ctx, userId: 'second-signer', supabase }, { connectionId: CONNECTION, method: 'qr', signer: { ...signer, personalNumber: '900209-2386' }, now: NOW })).toMatchObject({ ok: false, code: 'BANK_PROVIDER_REFUSED', details: { provider_code: 'FORMAT_ERROR' } })
      expect(connect.createConsent).not.toHaveBeenCalled()
      expect(connect.revokeConsent).not.toHaveBeenCalled()
    })

    it('when Connect did not answer the ending of the refused consent, the refusal stands: its place may still be held', async () => {
      // A new consent refused over that place would end the live consent a
      // renewal replaces (createConsentReplacing's release).
      const connect = fakeConnect({
        startConsentSigning: vi.fn().mockRejectedValue(refusal('FORMAT_ERROR')),
        revokeConsent: vi.fn().mockRejectedValue(new ProviderUnavailableError('down', { code: 'CONNECTOR_UNREACHABLE' })),
      })
      mocks.connect.mockReturnValue(connect)
      const { supabase, payload } = stub({ bank_connections: [{ data: failed(), error: null }], ...orgAnswers() })
      expect(await restartBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION, now: NOW })).toMatchObject({ ok: false, code: 'BANK_PROVIDER_REFUSED', details: { provider_code: 'FORMAT_ERROR' } })
      expect(connect.createConsent).not.toHaveBeenCalled()
      expect(payload('bank_connections', 'update')).toEqual([])
    })

    it('a bank that refuses the ending has still freed the place at Connect: the new consent goes ahead', async () => {
      const connect = fakeConnect({
        startConsentSigning: vi.fn().mockRejectedValueOnce(refusal('FORMAT_ERROR')).mockResolvedValue(STARTED),
        revokeConsent: vi.fn().mockRejectedValue(refusal('CONSENT_INVALID')),
        createConsent: vi.fn().mockResolvedValue({ consentId: 'consent-2', consentStatus: 'received', validUntil: '2027-04-10' }),
      })
      mocks.connect.mockReturnValue(connect)
      const { supabase } = stub({ bank_connections: [{ data: failed(), error: null }, { data: null, error: null }, { data: null, error: null }], ...orgAnswers() })
      expect(await restartBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION, now: NOW })).toMatchObject({ ok: true })
      expect(connect.startConsentSigning).toHaveBeenLastCalledWith('co-1', expect.objectContaining({ consentId: 'consent-2' }))
    })

    it('a new consent that cannot be created leaves the row as it was, and the next Försök igen creates one: the ended consent is refused without a reason too', async () => {
      const down = fakeConnect({
        startConsentSigning: vi.fn().mockRejectedValue(refusal('FORMAT_ERROR')),
        createConsent: vi.fn().mockRejectedValue(new ProviderUnavailableError('down', { code: 'CONNECTOR_AIS_PROVIDER_FAILED', status: 502 })),
      })
      mocks.connect.mockReturnValue(down)
      const first = stub({ bank_connections: [{ data: failed(), error: null }], ...orgAnswers() })
      expect(await restartBankFeedConsent({ ...ctx, supabase: first.supabase }, { connectionId: CONNECTION, now: NOW })).toMatchObject({ ok: false, code: 'BANK_PROVIDER_UNAVAILABLE' })
      expect(first.payload('bank_connections', 'update')).toEqual([])

      // Connect no longer holds the ended consent: 404 CONNECTOR_NOT_OWNED, no provider code.
      const notOwned = new BankFeedRefusedError('Consent not found for this company', { code: 'CONNECTOR_NOT_OWNED', status: 404 })
      const again = fakeConnect({
        startConsentSigning: vi.fn().mockRejectedValueOnce(notOwned).mockResolvedValue(STARTED),
        revokeConsent: vi.fn().mockRejectedValue(notOwned),
        createConsent: vi.fn().mockResolvedValue({ consentId: 'consent-2', consentStatus: 'received', validUntil: '2027-04-10' }),
      })
      mocks.connect.mockReturnValue(again)
      const second = stub({ bank_connections: [{ data: failed(), error: null }, { data: null, error: null }, { data: null, error: null }], ...orgAnswers() })
      expect(await restartBankFeedConsent({ ...ctx, supabase: second.supabase }, { connectionId: CONNECTION, now: NOW })).toMatchObject({ ok: true, data: { attempt: { authorisation_id: 'auth-2' } } })
      expect(second.payload('bank_connections', 'update')[0]).toMatchObject({ session_id: 'consent-2' })
    })

    it('a new consent the bank refuses too is the answer: one new consent per Försök igen, never a loop', async () => {
      const connect = fakeConnect({
        startConsentSigning: vi.fn().mockRejectedValue(refusal('FORMAT_ERROR')),
        createConsent: vi.fn().mockResolvedValue({ consentId: 'consent-2', consentStatus: 'received', validUntil: '2027-04-10' }),
      })
      mocks.connect.mockReturnValue(connect)
      const { supabase } = stub({ bank_connections: [{ data: failed(), error: null }, { data: null, error: null }, { data: null, error: null }], ...orgAnswers() })
      expect(await restartBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION, now: NOW })).toMatchObject({ ok: false, code: 'BANK_PROVIDER_REFUSED', details: { provider_code: 'FORMAT_ERROR' } })
      expect(connect.createConsent).toHaveBeenCalledTimes(1)
      expect(connect.startConsentSigning).toHaveBeenCalledTimes(2)
    })
  })

  it('refuses a connection that is not pending', async () => {
    mocks.connect.mockReturnValue(fakeConnect())
    const { supabase } = stub({ bank_connections: [{ data: row({ status: 'active' }), error: null }] })
    expect(await restartBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION })).toEqual({ ok: false, code: 'BANK_CONSENT_CHANGED' })
  })
})

describe('the PSU-ID a consent was created with', () => {
  const STORED = '198001019879'
  const startAnswers = () => ({
    ...orgAnswers(),
    companies: [{ data: { entity_type: 'aktiebolag' }, error: null }],
    bank_connections: [{ data: [], error: null }, { data: row({ authorization_id: null }), error: null }, { data: null, error: null }],
  })
  const pending = (state: string) =>
    fakeConnect({ pollConsentSigning: vi.fn().mockResolvedValue({ state, challenge: CHALLENGE, failureCode: null, scaStatus: 'started', consentStatus: null, validUntil: state === 'valid' ? '2027-04-10' : null }) })

  it('a session start keeps the number the bank accepted the consent with, typed or on file, by connection id', async () => {
    const connect = fakeConnect()
    mocks.door.mockResolvedValue({ ok: true, connect })
    const onFile = stub(startAnswers())
    expect((await startBankFeedConsent({ ...ctx, supabase: onFile.supabase }, { bic: 'SWEDSESS', method: 'qr', signer, now: NOW })).ok).toBe(true)
    expect(mocks.rememberPsu).toHaveBeenCalledWith({ connectionId: CONNECTION, companyId: 'co-1', personalNumber: '199001011239', source: 'on_file' })
    // A new consent never reads a stored number: it is a new resource.
    expect(mocks.storedPsu).not.toHaveBeenCalled()

    // The e-mail-login person who typed their number: nothing on file, the typed one is kept.
    mocks.signerOnFile.mockResolvedValue(null)
    const typed = stub(startAnswers())
    await startBankFeedConsent({ ...ctx, supabase: typed.supabase }, { bic: 'SWEDSESS', method: 'qr', signer: { ...signer, personalNumber: '900209-2386' }, now: NOW })
    expect(mocks.rememberPsu).toHaveBeenLastCalledWith({ connectionId: CONNECTION, companyId: 'co-1', personalNumber: '199002092386', source: 'typed' })
  })

  it('the signatory link start keeps the firmatecknare\'s typed number, never the sender\'s', async () => {
    mocks.door.mockResolvedValue({ ok: true, connect: fakeConnect() })
    const { supabase } = stub(startAnswers())
    const linkSigner = { ...signer, personalNumber: '900209-2386', lookupOnFile: false }
    expect((await startBankFeedConsent({ ...ctx, userId: 'sender-1', supabase }, { bic: 'SWEDSESS', method: 'qr', signer: linkSigner, returnTo: 'koppla', returnOrigin: ORIGIN, returnToken: 'tok', now: NOW })).ok).toBe(true)
    expect(mocks.rememberPsu).toHaveBeenCalledWith({ connectionId: CONNECTION, companyId: 'co-1', personalNumber: '199002092386', source: 'signatory_link' })
    expect(mocks.signerOnFile).not.toHaveBeenCalled()
  })

  it('keeps nothing when the bank refused the consent', async () => {
    mocks.door.mockResolvedValue({ ok: true, connect: fakeConnect({ createConsent: vi.fn().mockRejectedValue(new BankFeedRefusedError('no', { code: 'CONNECTOR_AIS_REFUSED', status: 400 })) }) })
    const { supabase } = stub(startAnswers())
    expect((await startBankFeedConsent({ ...ctx, supabase }, { bic: 'SWEDSESS', method: 'qr', signer, now: NOW })).ok).toBe(false)
    expect(mocks.rememberPsu).not.toHaveBeenCalled()
  })

  it('a restart of the same consent sends the stored number, not the one on file, and keeps it', async () => {
    const connect = fakeConnect({ startConsentSigning: vi.fn().mockResolvedValue({ providerAuthorisationId: 'auth-2', method: 'qr', state: 'pending', challenge: CHALLENGE, failureCode: null, scaStatus: null }) })
    mocks.connect.mockReturnValue(connect)
    mocks.storedPsu.mockResolvedValue({ personalNumber: STORED, source: 'typed' })
    const { supabase } = stub({ bank_connections: [{ data: row({ consent_attempt: { method: 'qr', state: 'failed', failure_code: 'SIGNING_SESSION_EXPIRED' } }), error: null }, { data: null, error: null }], ...orgAnswers() })
    expect((await restartBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION, signer, now: NOW })).ok).toBe(true)
    expect(mocks.storedPsu).toHaveBeenCalledWith(CONNECTION)
    expect(connect.startConsentSigning).toHaveBeenCalledWith('co-1', expect.objectContaining({ party: expect.objectContaining({ personalNumber: STORED, psuIpAddress: '203.0.113.1', psuUserAgent: 'UA' }) }))
    expect(connect.createConsent).not.toHaveBeenCalled()
    expect(mocks.rememberPsu).not.toHaveBeenCalled()
  })

  it('a restart that has to create a new consent overwrites the kept number with the one the new consent was created with', async () => {
    const connect = fakeConnect({ startConsentSigning: vi.fn().mockRejectedValueOnce(new ConsentOverError('over')).mockResolvedValue({ providerAuthorisationId: 'auth-2', method: 'qr', state: 'pending', challenge: CHALLENGE, failureCode: null, scaStatus: null }) })
    mocks.connect.mockReturnValue(connect)
    // The kept number could not be read (null): the typed one creates the new consent and replaces it.
    const { supabase, payload } = stub({
      bank_connections: [{ data: row({ consent_attempt: { method: 'qr', state: 'failed', co_signing: true } }), error: null }, { data: null, error: null }, { data: null, error: null }],
      ...orgAnswers(),
    })
    expect((await restartBankFeedConsent({ ...ctx, supabase }, { connectionId: CONNECTION, signer: { ...signer, personalNumber: '900209-2386' }, now: NOW })).ok).toBe(true)
    expect(connect.createConsent).toHaveBeenCalledWith('co-1', expect.objectContaining({ party: expect.objectContaining({ personalNumber: '199002092386' }) }))
    expect(mocks.rememberPsu).toHaveBeenCalledWith({ connectionId: CONNECTION, companyId: 'co-1', personalNumber: '199002092386', source: 'typed' })
    // A new consent has no co-signer yet.
    expect(payload('bank_connections', 'update')[0]).toMatchObject({ session_id: 'consent-1', consent_attempt: expect.objectContaining({ co_signing: false }) })
  })

  it('a second signatory on a partly signed consent signs with their own number and never overwrites the kept one; the consent\'s reads keep the kept one', async () => {
    const connect = fakeConnect({ startConsentSigning: vi.fn().mockResolvedValue({ providerAuthorisationId: 'auth-2', method: 'qr', state: 'pending', challenge: CHALLENGE, failureCode: null, scaStatus: 'authenticationStarted' }) })
    mocks.connect.mockReturnValue(connect)
    mocks.storedPsu.mockResolvedValue({ personalNumber: STORED, source: 'signatory_link' })
    const joint = row({ consent_attempt: { method: 'qr', state: 'partially_authorised', sca_status: 'finalised', started_at: '2026-10-10T09:00:00Z' } })
    const second = { ...signer, personalNumber: '900209-2386', lookupOnFile: false }
    const { supabase, payload } = stub({ bank_connections: [{ data: joint, error: null }, { data: null, error: null }], ...orgAnswers() })
    expect((await restartBankFeedConsent({ ...ctx, userId: 'sender-1', supabase }, { connectionId: CONNECTION, method: 'qr', signer: second, now: NOW })).ok).toBe(true)
    expect(connect.startConsentSigning).toHaveBeenCalledWith('co-1', expect.objectContaining({ consentId: 'consent-1', party: expect.objectContaining({ personalNumber: '199002092386' }) }))
    expect(mocks.storedPsu).not.toHaveBeenCalled()
    expect(mocks.rememberPsu).not.toHaveBeenCalled()
    expect(payload('bank_connections', 'update')[0]).toMatchObject({ consent_attempt: expect.objectContaining({ state: 'pending', co_signing: true }) })

    // The co-signer's poll: their number on the signing poll; the accounts read under the consent sends the kept one.
    const valid = pending('valid')
    mocks.connect.mockReturnValue(valid)
    mocks.serviceRpc.mockResolvedValue({ data: { already_finalized: false, accounts: [], superseded: [] }, error: null })
    const coSigning = row({ authorization_id: 'auth-2', consent_attempt: { method: 'qr', state: 'pending', co_signing: true } })
    const polled = stub({ bank_connections: [{ data: coSigning, error: null }], ...orgAnswers() })
    expect(await pollBankFeedConsent({ ...ctx, userId: 'sender-1', supabase: polled.supabase }, { connectionId: CONNECTION, signer: second })).toMatchObject({ ok: true, data: { state: 'valid' } })
    expect(valid.pollConsentSigning).toHaveBeenCalledWith('co-1', expect.objectContaining({ party: expect.objectContaining({ personalNumber: '199002092386' }) }))
    expect(valid.accounts).toHaveBeenCalledWith('co-1', expect.objectContaining({ party: expect.objectContaining({ personalNumber: STORED }) }))
    expect(mocks.rememberPsu).not.toHaveBeenCalled()
  })

  it('an ordinary poll, Svea\'s second consent and the disconnect send the kept number; the second consent keeps it again', async () => {
    mocks.storedPsu.mockResolvedValue({ personalNumber: STORED, source: 'on_file' })
    const polling = pending('pending')
    mocks.connect.mockReturnValue(polling)
    const polled = stub({ bank_connections: [{ data: row(), error: null }, { data: null, error: null }], ...orgAnswers() })
    await pollBankFeedConsent({ ...ctx, supabase: polled.supabase }, { connectionId: CONNECTION, signer })
    expect(polling.pollConsentSigning).toHaveBeenCalledWith('co-1', expect.objectContaining({ party: expect.objectContaining({ personalNumber: STORED, psuIpAddress: '203.0.113.1' }) }))
    expect(mocks.signerOnFile).not.toHaveBeenCalled()

    const svea = fakeConnect({ bank: vi.fn().mockResolvedValue({ ...BANK, bic: 'SVEASESS', name: 'Svea Bank', affiliates: [] }) })
    mocks.connect.mockReturnValue(svea)
    const listing = row({
      bic: 'SVEASESS', status: 'pending_selection', bank_name: 'Svea Bank',
      accounts_data: [{ uid: 'ACC003', currency: 'SEK', iban: 'SE8050000000052131234567', enabled: true }],
      consent_attempt: { method: 'qr', state: 'pending', selection: { listing_only: true } },
    })
    const selected = stub({ bank_connections: [{ data: listing, error: null }, { data: null, error: null }, { data: null, error: null }], ...orgAnswers() })
    expect((await selectBankFeedAccounts({ ...ctx, supabase: selected.supabase }, { connectionId: CONNECTION, accounts: [{ uid: 'ACC003', enabled: true }], signer, now: NOW })).ok).toBe(true)
    expect(svea.createConsent).toHaveBeenCalledWith('co-1', expect.objectContaining({ party: expect.objectContaining({ personalNumber: STORED }) }))
    expect(mocks.rememberPsu).toHaveBeenCalledWith({ connectionId: CONNECTION, companyId: 'co-1', personalNumber: STORED, source: 'on_file' })

    const revoking = fakeConnect()
    mocks.connect.mockReturnValue(revoking)
    mocks.readConfig.mockResolvedValue({ token: 'tok', connection: { id: CONNECTION, aggregator: 'open_payments' } })
    mocks.disconnect.mockResolvedValue({ connection_id: CONNECTION, session_id: 'consent-1', bank_name: 'Swedbank', released_cash_accounts: 1 })
    mocks.serviceRpc.mockImplementation(async (name: string) => (name === 'claim_bank_session_revocation' ? { data: { claimed: true, token: 'claim-1' }, error: null } : { data: true, error: null }))
    const gone = stub({ bank_connections: [{ data: row({ status: 'active' }), error: null }], ...orgAnswers() })
    expect((await disconnectBankFeedConnection({ ...ctx, supabase: gone.supabase }, CONNECTION)).ok).toBe(true)
    expect(revoking.revokeConsent).toHaveBeenCalledWith('co-1', { party: expect.objectContaining({ personalNumber: STORED, psuIpAddress: null, psuUserAgent: null }), consentId: 'consent-1' })
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
      bank_connections: [
        { data: pending, error: null },
        { data: [{ id: EB_ROW, aggregator: 'enable_banking', accounts_data: [] }], error: null },
        { data: { ...pending, status: 'active' }, error: null },
        { data: { ...pending, status: 'active', last_synced_at: 'x' }, error: null },
      ],
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

  // 2026-10-27: a two-year first import (3 447 rows, matching passes, the
  // SIE-overlap sweep) held the account picker's spinner for 243 s and the
  // platform cut the function at 300 s.
  describe('the first import that outlasts the wait', () => {
    function pendingSelection() {
      mocks.connect.mockReturnValue(fakeConnect())
      mocks.readConfig.mockResolvedValue({ token: 'tok', connection: { id: CONNECTION, status: 'pending_selection', session_id: 'consent-1', bank_name: 'Swedbank', accounts_data: stored, aggregator: 'open_payments' } })
      mocks.saveSelection.mockResolvedValue({ status: 'active', accounts: stored })
      const pending = row({ status: 'pending_selection', accounts_data: stored, consent_attempt: { selection: { extended_history_days: 760, listing_only: false } } })
      return stub({
        bank_connections: [
          { data: pending, error: null },
          { data: [], error: null },
          { data: { ...pending, status: 'active' }, error: null },
          { data: { ...pending, status: 'active' }, error: null },
        ],
        cash_accounts: [{ data: [], error: null }],
      }).supabase
    }
    const accounts = [{ uid: 'ACC003', enabled: true, ledgerAccount: '1930' }, { uid: 'ACC001', enabled: false, ledgerAccount: null }]
    let finishImport: (value: unknown) => void = () => {}

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      mocks.runSync.mockReturnValue(new Promise((resolve) => { finishImport = resolve }))
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('a door that keeps the work alive answers after the short wait and hands it the running import', async () => {
      const supabase = pendingSelection()
      const keepAlive = vi.fn()
      let settled = false
      const answer = selectBankFeedAccounts({ ...ctx, supabase }, { connectionId: CONNECTION, accounts, signer, now: NOW, keepAlive })
        .finally(() => { settled = true })

      await vi.advanceTimersByTimeAsync(INITIAL_SYNC_ANSWER_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)

      expect(await answer).toMatchObject({ ok: true, data: { sync: null, sync_pending: true, connection: { status: 'active' } } })
      expect(keepAlive).toHaveBeenCalledTimes(1)
      expect(keepAlive.mock.calls[0][0]).toBe(mocks.runSync.mock.results[0].value)
      // The import still runs as the person: the extended window needs them present.
      expect(mocks.runSync).toHaveBeenCalledWith(supabase, expect.objectContaining({ trigger: 'initial', signer }))
      expect(INITIAL_SYNC_ANSWER_MS).toBeLessThanOrEqual(30_000)
    })

    it('an import inside the short wait still answers with its count', async () => {
      const supabase = pendingSelection()
      const keepAlive = vi.fn()
      const answer = selectBankFeedAccounts({ ...ctx, supabase }, { connectionId: CONNECTION, accounts, signer, now: NOW, keepAlive })
      await vi.advanceTimersByTimeAsync(1_000)
      finishImport({ ok: true, connection_id: CONNECTION, bank: 'Swedbank', imported: 42, duplicates: 0, from_date: '2024-09-12', to_date: '2026-10-12', last_synced_at: 'x' })

      expect(await answer).toMatchObject({ ok: true, data: { sync: { imported: 42 }, sync_pending: false } })
      expect(keepAlive).not.toHaveBeenCalled()
    })

    it('a door without keepAlive is the only thing running the import, so it waits the long way', async () => {
      const supabase = pendingSelection()
      let settled = false
      const answer = selectBankFeedAccounts({ ...ctx, supabase }, { connectionId: CONNECTION, accounts, signer, now: NOW })
        .finally(() => { settled = true })

      await vi.advanceTimersByTimeAsync(INITIAL_SYNC_ANSWER_MS)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(INITIAL_SYNC_WAIT_MS - INITIAL_SYNC_ANSWER_MS)

      expect(await answer).toMatchObject({ ok: true, data: { sync: null, sync_pending: true } })
    })
  })

  it('takes over the Enable Banking row reading the same account when the connection came through a door that named no switch, and keeps one still reading another account', async () => {
    const EB_OTHER = '8e6c1a2b-9c0d-4e8f-8a1b-2c3d4e5f6a7b'
    mocks.connect.mockReturnValue(fakeConnect())
    mocks.readConfig.mockResolvedValue({ token: 'tok', connection: { id: CONNECTION, status: 'pending_selection', session_id: 'consent-1', bank_name: 'Swedbank', accounts_data: stored, aggregator: 'open_payments' } })
    mocks.saveSelection.mockResolvedValue({ status: 'active', accounts: stored })
    mocks.runSync.mockResolvedValue({ ok: true, connection_id: CONNECTION, bank: 'Swedbank', imported: 0, duplicates: 4, from_date: '2024-09-12', to_date: '2026-10-12', last_synced_at: 'x' })
    // Koppla bank (or a flow started over): no replace_connection_id anywhere on the attempt.
    const pending = row({ status: 'pending_selection', accounts_data: stored, consent_attempt: { selection: { extended_history_days: 760, listing_only: false } } })
    const { supabase, rpc, calls } = stub({
      bank_connections: [
        { data: pending, error: null },
        {
          data: [
            // The same account at Enable Banking, its IBAN written with spaces.
            { id: EB_ROW, aggregator: 'enable_banking', accounts_data: [{ uid: 'eb-1', currency: 'SEK', enabled: true, iban: 'SE80 5000 0000 0521 3123 4567' }] },
            // An account the new connection does not read: its feed stays.
            { id: EB_OTHER, aggregator: 'enable_banking', accounts_data: [{ uid: 'eb-2', currency: 'SEK', enabled: true, iban: 'SE4550000000058398257466' }] },
          ],
          error: null,
        },
        { data: { ...pending, status: 'active' }, error: null },
      ],
      cash_accounts: [{ data: [{ id: 'cash-1', iban: 'SE8050000000052131234567', currency: 'SEK', ledger_account: '1930' }], error: null }],
      'rpc:supersede_enable_banking_connection': [{ data: { superseded: [{ id: EB_ROW, session_id: 'eb-sess' }], moved_transactions: 40, released_cash_accounts: 0 }, error: null }],
    })
    const result = await selectBankFeedAccounts({ ...ctx, supabase }, {
      connectionId: CONNECTION,
      accounts: [{ uid: 'ACC003', enabled: true, ledgerAccount: '1930' }, { uid: 'ACC001', enabled: false, ledgerAccount: null }],
      signer, now: NOW,
    })
    expect(result).toMatchObject({ ok: true, data: { connection: { status: 'active' } } })
    const handovers = rpc.mock.calls.filter(([name]) => name === 'supersede_enable_banking_connection')
    expect(handovers).toEqual([['supersede_enable_banking_connection', { p_company_id: 'co-1', p_user_id: 'user-1', p_new: CONNECTION, p_old: EB_ROW }]])
    expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'bank_connection.superseded', payload: expect.objectContaining({ connectionId: EB_ROW, supersededById: CONNECTION }) }))
    // The company's other live rows: never this connection itself, never a revoked or superseded one.
    expect(calls).toContainEqual({ table: 'bank_connections', method: 'neq', args: ['id', CONNECTION] })
    expect(calls).toContainEqual({ table: 'bank_connections', method: 'is', args: ['superseded_by', null] })
  })

  it('an active connection saved again takes over a live Enable Banking row it now reads, without a first import', async () => {
    mocks.connect.mockReturnValue(fakeConnect())
    mocks.readConfig.mockResolvedValue({ token: 'tok', connection: { id: CONNECTION, status: 'active', session_id: 'consent-1', bank_name: 'Swedbank', accounts_data: stored, aggregator: 'open_payments' } })
    mocks.saveSelection.mockResolvedValue({ status: 'active', accounts: stored })
    const active = row({ status: 'active', accounts_data: stored, consent_attempt: { selection: { extended_history_days: 760, listing_only: false } } })
    const { supabase, rpc } = stub({
      bank_connections: [
        { data: active, error: null },
        { data: [{ id: EB_ROW, aggregator: 'enable_banking', accounts_data: [{ uid: 'eb-1', currency: 'SEK', enabled: true, iban: 'SE8050000000052131234567' }] }], error: null },
        { data: active, error: null },
      ],
      cash_accounts: [{ data: [], error: null }],
      'rpc:supersede_enable_banking_connection': [{ data: { superseded: [{ id: EB_ROW, session_id: null }] }, error: null }],
    })
    expect(await selectBankFeedAccounts({ ...ctx, supabase }, { connectionId: CONNECTION, accounts: [{ uid: 'ACC003', enabled: true, ledgerAccount: '1930' }] })).toMatchObject({ ok: true, data: { sync: null, sync_pending: false } })
    expect(rpc).toHaveBeenCalledWith('supersede_enable_banking_connection', { p_company_id: 'co-1', p_user_id: 'user-1', p_new: CONNECTION, p_old: EB_ROW })
    expect(mocks.runSync).not.toHaveBeenCalled()
  })

  it('keeps the selection when the live rows cannot be read: the row a switch named is still handed over, nothing else', async () => {
    mocks.connect.mockReturnValue(fakeConnect())
    mocks.readConfig.mockResolvedValue({ token: 'tok', connection: { id: CONNECTION, status: 'pending_selection', session_id: 'consent-1', bank_name: 'Swedbank', accounts_data: stored, aggregator: 'open_payments' } })
    mocks.saveSelection.mockResolvedValue({ status: 'active', accounts: stored })
    mocks.runSync.mockResolvedValue({ ok: true, connection_id: CONNECTION, bank: 'Swedbank', imported: 1, duplicates: 0, from_date: '2024-09-12', to_date: '2026-10-12', last_synced_at: 'x' })
    const pending = row({ status: 'pending_selection', accounts_data: stored, consent_attempt: { selection: { replace_connection_id: EB_ROW, extended_history_days: 760, listing_only: false } } })
    const { supabase, rpc } = stub({
      bank_connections: [{ data: pending, error: null }, { data: null, error: { message: 'read failed' } }, { data: { ...pending, status: 'active' }, error: null }],
      cash_accounts: [{ data: [], error: null }],
      'rpc:supersede_enable_banking_connection': [{ data: { superseded: [{ id: EB_ROW, session_id: null }] }, error: null }],
    })
    expect(await selectBankFeedAccounts({ ...ctx, supabase }, { connectionId: CONNECTION, accounts: [{ uid: 'ACC003', enabled: true, ledgerAccount: '1930' }], signer, now: NOW })).toMatchObject({ ok: true })
    const handovers = rpc.mock.calls.filter(([name]) => name === 'supersede_enable_banking_connection')
    expect(handovers).toEqual([['supersede_enable_banking_connection', expect.objectContaining({ p_old: EB_ROW })]])
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

  it('for Svea creates the second consent as the listing consent\'s replacement and keeps the selection on the row', async () => {
    const connect = fakeConnect({ createConsent: vi.fn().mockResolvedValue({ consentId: 'consent-2', consentStatus: 'received', validUntil: '2027-04-10' }) })
    mocks.connect.mockReturnValue(connect)
    const listing = row({ status: 'pending_selection', bic: 'SVEASESS', accounts_data: stored, consent_attempt: { selection: { listing_only: true, extended_history_days: 365, replace_connection_id: null } } })
    const { supabase, payload } = stub({ bank_connections: [{ data: listing, error: null }, { data: null, error: null }, { data: null, error: null }], ...orgAnswers() })
    const result = await selectBankFeedAccounts({ ...ctx, supabase }, { connectionId: CONNECTION, accounts: [{ uid: 'ACC003', enabled: true, ledgerAccount: '1930' }, { uid: 'ACC001', enabled: false, ledgerAccount: null }], method: 'qr', signer, now: NOW })
    expect(result).toMatchObject({ ok: true, data: { sync: null, sync_pending: false, attempt: { authorisation_id: 'auth-1', method: 'qr', state: 'pending' }, connection: { status: 'pending' } } })
    expect(connect.createConsent).toHaveBeenCalledWith('co-1', expect.objectContaining({
      accounts: [{ iban: 'SE8050000000052131234567' }],
      replacesConsentId: 'consent-1',
    }))
    expect(connect.revokeConsent).not.toHaveBeenCalled()
    expect(payload('bank_connections', 'update')[0]).toMatchObject({
      session_id: 'consent-2', status: 'pending', authorization_id: null,
      consent_attempt: expect.objectContaining({ listing_only: false, listing_consent_id: 'consent-1', selection: expect.objectContaining({ listing_only: false, accounts: [{ uid: 'ACC003', enabled: true, ledger_account: '1930' }, { uid: 'ACC001', enabled: false, ledger_account: null }] }) }),
    })
    expect(mocks.saveSelection).not.toHaveBeenCalled()
  })

  it('for Svea, against a Connect without replacements, ends the listing consent after the refusal over the count and asks once more without naming it', async () => {
    const quota = new BankFeedRefusedError('Bank connection quota reached for this company', { code: 'CONNECTOR_QUOTA_EXCEEDED', status: 403 })
    const connect = fakeConnect({
      createConsent: vi.fn().mockRejectedValueOnce(quota).mockResolvedValueOnce({ consentId: 'consent-2', consentStatus: 'received', validUntil: '2027-04-10' }),
      // A bank that keeps refusing the end: Connect releases its row anyway, so the second ask goes ahead.
      revokeConsent: vi.fn().mockRejectedValue(new ProviderUnavailableError('down', { code: 'CONNECTOR_AIS_PROVIDER_FAILED' })),
    })
    mocks.connect.mockReturnValue(connect)
    const listing = row({ status: 'pending_selection', bic: 'SVEASESS', accounts_data: stored, consent_attempt: { selection: { listing_only: true, extended_history_days: 365, replace_connection_id: null } } })
    const { supabase, payload } = stub({ bank_connections: [{ data: listing, error: null }, { data: null, error: null }, { data: null, error: null }], ...orgAnswers() })
    const result = await selectBankFeedAccounts({ ...ctx, supabase }, { connectionId: CONNECTION, accounts: [{ uid: 'ACC003', enabled: true, ledgerAccount: '1930' }], method: 'qr', signer, now: NOW })
    expect(result).toMatchObject({ ok: true, data: { connection: { status: 'pending' } } })
    const asks = (connect.createConsent as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1] as Record<string, unknown>)
    expect(asks).toHaveLength(2)
    expect(asks[0]).toMatchObject({ replacesConsentId: 'consent-1', accounts: [{ iban: 'SE8050000000052131234567' }] })
    expect(asks[1]).toMatchObject({ accounts: [{ iban: 'SE8050000000052131234567' }] })
    expect(asks[1]).not.toHaveProperty('replacesConsentId')
    expect(connect.revokeConsent).toHaveBeenCalledWith('co-1', expect.objectContaining({ consentId: 'consent-1' }))
    const order = (fn: unknown, call = 0) => (fn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[call]
    expect(order(connect.revokeConsent)).toBeLessThan(order(connect.createConsent, 1))
    expect(payload('bank_connections', 'update')[0]).toMatchObject({ session_id: 'consent-2', consent_attempt: expect.objectContaining({ listing_consent_id: 'consent-1' }) })
  })

  it('for Svea answers any other refusal of the second consent without ending the listing consent', async () => {
    const connect = fakeConnect({ createConsent: vi.fn().mockRejectedValue(new BankFeedRefusedError('refused', { code: 'CONNECTOR_AIS_REFUSED', status: 422 })) })
    mocks.connect.mockReturnValue(connect)
    const listing = row({ status: 'pending_selection', bic: 'SVEASESS', accounts_data: stored, consent_attempt: { selection: { listing_only: true, extended_history_days: 365, replace_connection_id: null } } })
    const { supabase } = stub({ bank_connections: [{ data: listing, error: null }], ...orgAnswers() })
    expect(await selectBankFeedAccounts({ ...ctx, supabase }, { connectionId: CONNECTION, accounts: [{ uid: 'ACC003', enabled: true, ledgerAccount: '1930' }], method: 'qr', signer, now: NOW })).toMatchObject({ ok: false, code: 'BANK_PROVIDER_REFUSED' })
    expect(connect.createConsent).toHaveBeenCalledTimes(1)
    expect(connect.revokeConsent).not.toHaveBeenCalled()
  })

  it('for Svea keeps the switch\'s Enable Banking row and the history window on the second consent where finalize reads them, at the top of the attempt', async () => {
    const connect = fakeConnect({ createConsent: vi.fn().mockResolvedValue({ consentId: 'consent-2', consentStatus: 'received', validUntil: '2027-04-10' }) })
    mocks.connect.mockReturnValue(connect)
    // The listing consent's row after finalize: the facts live under selection only.
    const listing = row({ status: 'pending_selection', bic: 'SVEASESS', accounts_data: stored, consent_attempt: { selection: { listing_only: true, extended_history_days: 365, replace_connection_id: EB_ROW } } })
    const { supabase, payload } = stub({ bank_connections: [{ data: listing, error: null }, { data: null, error: null }, { data: null, error: null }], ...orgAnswers() })
    expect(await selectBankFeedAccounts({ ...ctx, supabase }, { connectionId: CONNECTION, accounts: [{ uid: 'ACC003', enabled: true, ledgerAccount: '1930' }], method: 'qr', signer, now: NOW })).toMatchObject({ ok: true })
    // finalize_open_payments_consent rebuilds the attempt from its top-level
    // replace_connection_id, extended_history_days and listing_only.
    expect(payload('bank_connections', 'update')[0]).toMatchObject({
      consent_attempt: expect.objectContaining({ replace_connection_id: EB_ROW, extended_history_days: 365, listing_only: false, selection: expect.objectContaining({ replace_connection_id: EB_ROW }) }),
    })
  })

  it('starts Svea\'s second consent on the bank\'s page with the entry point\'s return when the bank signs only there, and refuses without a return', async () => {
    const connect = fakeConnect({
      bank: vi.fn().mockResolvedValue({ ...BANK, bic: 'SVEASESS', name: 'Svea Bank', decoupled: false, redirect: true, affiliates: [] }),
      createConsent: vi.fn().mockResolvedValue({ consentId: 'consent-2', consentStatus: 'received', validUntil: '2027-04-10' }),
      startConsentSigning: vi.fn().mockResolvedValue(REDIRECT_STARTED('https://svea.example/sign', 'auth-s2')),
    })
    mocks.connect.mockReturnValue(connect)
    const listing = () => row({ status: 'pending_selection', bic: 'SVEASESS', accounts_data: stored, consent_attempt: { selection: { listing_only: true, extended_history_days: 365, replace_connection_id: null } } })
    const { supabase, payload } = stub({ bank_connections: [{ data: listing(), error: null }, { data: null, error: null }, { data: null, error: null }], ...orgAnswers() })
    const result = await selectBankFeedAccounts({ ...ctx, supabase }, { connectionId: CONNECTION, accounts: [{ uid: 'ACC003', enabled: true, ledgerAccount: '1930' }], method: 'qr', returnTo: 'connections', returnOrigin: ORIGIN, signer, now: NOW })
    expect(result).toMatchObject({ ok: true, data: { attempt: { authorisation_id: 'auth-s2', method: 'redirect', state: 'pending', challenge: expect.objectContaining({ redirectUrl: 'https://svea.example/sign' }) } } })
    expect(connect.startConsentSigning).toHaveBeenCalledWith('co-1', expect.objectContaining({ consentId: 'consent-2', method: 'redirect', returnUrl: `${ORIGIN}/settings/connections?bank_connect=${CONNECTION}`, returnState: CONNECTION }))
    // The second consent is created for the page it is signed on, as the first is.
    expect((connect.createConsent as ReturnType<typeof vi.fn>).mock.calls[0][1].party).toMatchObject({ bic: 'SVEASESS', redirectPreferred: true })
    expect(payload('bank_connections', 'update')[0]).toMatchObject({ consent_attempt: expect.objectContaining({ method: 'redirect', return_to: 'connections', listing_consent_id: 'consent-1' }) })

    const bare = stub({ bank_connections: [{ data: listing(), error: null }], ...orgAnswers() })
    expect(await selectBankFeedAccounts({ ...ctx, supabase: bare.supabase }, { connectionId: CONNECTION, accounts: [{ uid: 'ACC003', enabled: true, ledgerAccount: '1930' }], method: 'qr', signer, now: NOW })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'return_to' } })
    expect(connect.createConsent).toHaveBeenCalledTimes(1)
  })
})

describe('disconnectBankFeedConnection', () => {
  it('releases the connection locally, then ends the consent under the openpayments claim', async () => {
    mocks.connect.mockReturnValue(fakeConnect())
    mocks.readConfig.mockResolvedValue({ token: 'tok', connection: { id: CONNECTION, aggregator: 'open_payments' } })
    mocks.disconnect.mockResolvedValue({ connection_id: CONNECTION, session_id: 'consent-1', bank_name: 'Swedbank', released_cash_accounts: 1 })
    mocks.serviceRpc.mockImplementation(async (name: string) => name === 'claim_bank_session_revocation' ? { data: { claimed: true, token: 'claim-1' }, error: null } : { data: true, error: null })
    const { supabase, payload } = stub({ bank_connections: [{ data: row({ status: 'active' }), error: null }], ...orgAnswers() })
    expect(await disconnectBankFeedConnection({ ...ctx, supabase }, CONNECTION)).toEqual({ ok: true, data: { connection_id: CONNECTION } })
    expect(payload('bank_connections', 'update')).toEqual([])
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
    const { supabase, payload } = stub({ bank_connections: [{ data: row({ status: 'active' }), error: null }], ...orgAnswers() })
    expect(await disconnectBankFeedConnection({ ...ctx, supabase }, CONNECTION)).toMatchObject({ ok: true })
    expect(mocks.serviceRpc).toHaveBeenCalledWith('finish_bank_session_revocation', expect.objectContaining({ p_succeeded: false }))
    // Connect keeps counting a consent the bank did not end as the company's
    // bank connection (crm#1363): the removed row names it for the next attempt.
    expect(payload('bank_connections', 'update')).toEqual([{ consent_attempt: expect.objectContaining({ method: 'qr', unended_consent_id: 'consent-1' }) }])
    const none = stub({ bank_connections: [{ data: null, error: null }] })
    expect(await disconnectBankFeedConnection({ ...ctx, supabase: none.supabase }, CONNECTION)).toEqual({ ok: false, code: 'NOT_FOUND' })
  })

  it.each([
    ['over at the bank', new ConsentOverError('expired', { status: 410 })],
    ['unknown to the bank', new BankFeedRefusedError('not found', { code: 'BANK_FEED_NOT_FOUND', status: 404 })],
  ])('names nothing on the removed row when the provider says the consent is already gone (%s) (#97)', async (_label, refusal) => {
    mocks.connect.mockReturnValue(fakeConnect({ revokeConsent: vi.fn().mockRejectedValue(refusal) }))
    mocks.readConfig.mockResolvedValue({ token: 'tok', connection: { id: CONNECTION, aggregator: 'open_payments' } })
    mocks.disconnect.mockResolvedValue({ connection_id: CONNECTION, session_id: 'consent-1', bank_name: 'Swedbank', released_cash_accounts: 0 })
    mocks.serviceRpc.mockImplementation(async (name: string) => name === 'claim_bank_session_revocation' ? { data: { claimed: true, token: 'claim-1' }, error: null } : { data: true, error: null })
    const { supabase, payload } = stub({ bank_connections: [{ data: row({ status: 'active' }), error: null }], ...orgAnswers() })
    expect(await disconnectBankFeedConnection({ ...ctx, supabase }, CONNECTION)).toMatchObject({ ok: true })
    // Nothing is live to end or to bill: the claim records it as ended, and no retry is left behind.
    expect(mocks.serviceRpc).toHaveBeenCalledWith('finish_bank_session_revocation', expect.objectContaining({ p_session_id: 'consent-1', p_succeeded: true }))
    expect(payload('bank_connections', 'update')).toEqual([])
  })
})

describe('startBankFeedConsent at Nordea Corporate Netbank', () => {
  const NORDEA = { ...BANK, bic: 'NDEASESS', name: 'Nordea', decoupled: true, redirect: true, affiliates: [] }
  const answers = () => ({
    ...orgAnswers(),
    companies: [{ data: { entity_type: 'aktiebolag' }, error: null }],
    bank_connections: [
      { data: [], error: null },
      { data: row({ bic: 'NDEASESS', bank_name: 'Nordea', authorization_id: null }), error: null },
      { data: null, error: null },
    ],
  })

  it('sends the typed logon id in the party of the consent and its BankID start', async () => {
    const connect = fakeConnect({ bank: vi.fn().mockResolvedValue(NORDEA) })
    mocks.door.mockResolvedValue({ ok: true, connect })
    const { supabase } = stub(answers())
    const result = await startBankFeedConsent({ ...ctx, supabase }, { bic: 'NDEASESS', method: 'qr', signer: { ...signer, psuAuthoriserId: ' corp-user-1 ' }, now: NOW })
    expect(result.ok).toBe(true)
    expect(connect.startConsentSigning).toHaveBeenCalledWith('co-1', expect.objectContaining({ party: expect.objectContaining({ bic: 'NDEASESS', psuAuthoriserId: 'corp-user-1' }) }))
  })

  it('names the missing logon id in the bank\'s words when the bank refuses the start for it', async () => {
    const connect = fakeConnect({
      bank: vi.fn().mockResolvedValue(NORDEA),
      startConsentSigning: vi.fn().mockRejectedValue(new BankFeedRefusedError('refused', { code: 'CONNECTOR_AIS_REFUSED', status: 422, providerCode: 'PSU_AUTHORISER_ID_MISSING' })),
    })
    mocks.door.mockResolvedValue({ ok: true, connect })
    const { supabase } = stub(answers())
    const sentence = 'Nordea Corporate Netbank behöver ert inloggnings-ID. Fyll i det och försök igen.'
    expect(await startBankFeedConsent({ ...ctx, supabase }, { bic: 'NDEASESS', method: 'qr', signer, now: NOW })).toEqual({
      ok: false,
      code: 'BANK_PROVIDER_REFUSED',
      details: { provider_code: 'PSU_AUTHORISER_ID_MISSING', provider_text: sentence },
      messageSv: sentence,
    })
  })

  it('says any refusal the provider has a sentence for in its words, logs the bank\'s code, and keeps the generic refusal for a code it does not know', async () => {
    const refusing = (providerCode: string) => fakeConnect({
      bank: vi.fn().mockResolvedValue(NORDEA),
      startConsentSigning: vi.fn().mockRejectedValue(new BankFeedRefusedError('refused', { code: 'CONNECTOR_AIS_REFUSED', status: 422, providerCode })),
    })
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
    mocks.door.mockResolvedValue({ ok: true, connect: refusing('PSU_OPEN_BANKING_RIGHTS_MISSING') })
    const first = stub(answers())
    const known = await startBankFeedConsent({ ...ctx, supabase: first.supabase, log: log as never }, { bic: 'NDEASESS', method: 'qr', signer, now: NOW })
    expect(known).toMatchObject({
      ok: false,
      code: 'BANK_PROVIDER_REFUSED',
      messageSv: 'Behörighet saknas för att utföra förfrågningar i Open Banking. Lägg till tredjepartstjänster (API/Open Banking) i internetbanken.',
    })
    expect(log.warn).toHaveBeenCalledWith('bank provider refused', expect.objectContaining({ code: 'CONNECTOR_AIS_REFUSED', provider_code: 'PSU_OPEN_BANKING_RIGHTS_MISSING', status: 422 }))

    mocks.door.mockResolvedValue({ ok: true, connect: refusing('SOMETHING_NEW') })
    const second = stub(answers())
    const unknown = await startBankFeedConsent({ ...ctx, supabase: second.supabase }, { bic: 'NDEASESS', method: 'qr', signer, now: NOW })
    expect(unknown).toMatchObject({ ok: false, code: 'BANK_PROVIDER_REFUSED', details: { provider_code: 'SOMETHING_NEW' } })
    expect(unknown).not.toHaveProperty('messageSv')
  })
})
