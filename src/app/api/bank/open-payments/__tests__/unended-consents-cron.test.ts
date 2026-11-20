import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  serviceRpc: vi.fn(),
  storedPsu: vi.fn(),
  signerOnFile: vi.fn(),
}))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: () => mocks.db }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({ rpc: (...a: unknown[]) => mocks.serviceRpc(...a) }) }))
vi.mock('@/lib/auth/resource-psu', () => ({
  storedConnectionPsu: (...a: unknown[]) => mocks.storedPsu(...a),
  rememberConnectionPsu: vi.fn(),
}))
vi.mock('@/lib/auth/bankid-signer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/bankid-signer')>()),
  signerPersonalNumberOnFile: (...a: unknown[]) => mocks.signerOnFile(...a),
}))

import { createCronRequest, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { BankFeedRefusedError, ConsentOverError, ProviderUnavailableError, setBankFeedConnectForTests, type BankFeedConnect } from '@/lib/bank-feed/connect'
import { GET } from '../unended-consents/cron/route'

const PATH = '/api/bank/open-payments/unended-consents/cron'
const ENDS = '1a000000-0000-4000-8000-000000000001'
const REFUSED = '1a000000-0000-4000-8000-000000000002'
const GONE = '1a000000-0000-4000-8000-000000000003'
const ENDED_EARLIER = '1a000000-0000-4000-8000-000000000004'
const UNKNOWN = '1a000000-0000-4000-8000-000000000005'
const CLAIM_DOWN = '1a000000-0000-4000-8000-000000000006'
const CLEAR_THROWS = '1a000000-0000-4000-8000-000000000007'

/** A removed connection whose consent the bank did not end when it was removed. */
function held(id: string, consentId: string, companyId = 'company-1') {
  return {
    id, company_id: companyId, user_id: 'user-1', bic: 'SWEDSESS', affiliated_aspsp_id: null, psu_type: 'business',
    consent_attempt: { selection: { listing_only: false }, unended_consent_id: consentId },
  }
}

type Chain = Array<{ method: string; args: unknown[] }>
const isUpdate = (chain: Chain) => chain.some((c) => c.method === 'update')
const updatedId = (chain: Chain) => chain.find((c) => c.method === 'eq' && c.args[0] === 'id')?.args[1]

/** bank_connections answers the held rows to the read and accepts every clear, except the ones named to throw. */
function database(rows: ReturnType<typeof held>[], options: { clearThrowsFor?: string } = {}) {
  const mock = createTableMockSupabase({
    company_settings: { data: { org_number: '556000-0001' }, error: null },
    bank_connections: (chain) => {
      if (!isUpdate(chain)) return { data: rows, error: null }
      if (updatedId(chain) === options.clearThrowsFor) throw new Error('write failed')
      return { data: null, error: null }
    },
  })
  mocks.db = mock.supabase
  const cleared = () => mock.calls.filter((c) => c.table === 'bank_connections' && c.method === 'eq' && c.args[0] === 'id').map((c) => c.args[1])
  return { ...mock, cleared }
}

/** The revocation claim: claimed, except a consent ended earlier (already-revoked) or one whose claim cannot be read. */
function claims(options: { alreadyRevoked?: string[]; down?: string[] } = {}) {
  mocks.serviceRpc.mockImplementation(async (name: string, args: { p_session_id: string }) => {
    if (name !== 'claim_bank_session_revocation') return { data: true, error: null }
    if (options.down?.includes(args.p_session_id)) throw new Error('claim not read')
    if (options.alreadyRevoked?.includes(args.p_session_id)) return { data: { claimed: false, reason: 'already-revoked' }, error: null }
    return { data: { claimed: true, token: `claim-${args.p_session_id}` }, error: null }
  })
}

/** Connect answers the revoke per consent; anything not named is ended. */
function connectAnswering(answers: Record<string, Error>) {
  const revokeConsent = vi.fn(async (_companyId: string, input: { consentId: string }) => {
    const refusal = answers[input.consentId]
    if (refusal) throw refusal
    return { revoked: true as const }
  })
  setBankFeedConnectForTests({ revokeConsent } as unknown as BankFeedConnect)
  return revokeConsent
}

const finished = (consentId: string) =>
  mocks.serviceRpc.mock.calls.find(([name, args]) => name === 'finish_bank_session_revocation' && (args as { p_session_id: string }).p_session_id === consentId)?.[1]

type Summary = { skipped: boolean; reason?: string; held: number; attempted: number; ended: number; alreadyEnded: number; kept: number; busy: number; errored: number; deferred: number }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('CRON_SECRET', 'secret')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.se')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
  mocks.storedPsu.mockResolvedValue(null)
  mocks.signerOnFile.mockResolvedValue(null)
})
afterEach(() => {
  setBankFeedConnectForTests(undefined)
  vi.unstubAllEnvs()
})

describe('GET /api/bank/open-payments/unended-consents/cron', () => {
  it('refuses a missing or wrong secret and reads nothing', async () => {
    const revoke = connectAnswering({})
    const { supabase } = database([held(ENDS, 'consent-a')])
    expect((await GET(createCronRequest(PATH))).status).toBe(401)
    expect((await GET(createCronRequest(PATH, 'Bearer wrong'))).status).toBe(401)
    expect(supabase.from).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
  })

  it('ends one, keeps a refused one, and clears one the provider says is already gone', async () => {
    claims({ alreadyRevoked: ['consent-d'] })
    const revoke = connectAnswering({
      'consent-b': new ProviderUnavailableError('bank down', { code: 'CONNECTOR_AIS_PROVIDER_FAILED', status: 502 }),
      'consent-c': new ConsentOverError('consent expired', { status: 410 }),
      'consent-e': new BankFeedRefusedError('consent unknown', { code: 'BANK_FEED_NOT_FOUND', status: 404 }),
    })
    const db = database([
      held(ENDS, 'consent-a'),
      held(REFUSED, 'consent-b', 'company-2'),
      held(GONE, 'consent-c', 'company-3'),
      held(ENDED_EARLIER, 'consent-d', 'company-4'),
      held(UNKNOWN, 'consent-e', 'company-5'),
    ])

    const { status, body } = await parseJsonResponse<Summary>(await GET(createCronRequest(PATH, 'Bearer secret')))
    expect(status).toBe(200)
    expect(body).toEqual({ skipped: false, held: 5, attempted: 5, ended: 1, alreadyEnded: 3, kept: 1, busy: 0, errored: 0, deferred: 0 })

    // Every held removed connection of every company, read once.
    expect(db.findCall('bank_connections', 'not')).toEqual(['consent_attempt->>unended_consent_id', 'is', null])
    expect(db.findCalls('bank_connections', 'eq')).toEqual(expect.arrayContaining([['aggregator', 'open_payments'], ['status', 'revoked']]))
    // Asked under each row's own company; one ended earlier is not asked again.
    expect(revoke).toHaveBeenCalledWith('company-1', expect.objectContaining({ consentId: 'consent-a' }))
    expect(revoke).toHaveBeenCalledWith('company-2', expect.objectContaining({ consentId: 'consent-b' }))
    expect(revoke).toHaveBeenCalledWith('company-3', expect.objectContaining({ consentId: 'consent-c' }))
    expect(revoke).toHaveBeenCalledWith('company-5', expect.objectContaining({ consentId: 'consent-e' }))
    expect(revoke).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ consentId: 'consent-d' }))
    // The claim records the refusal as on the connect path; ended and gone ones as ended.
    expect(finished('consent-a')).toMatchObject({ p_provider: 'openpayments', p_claim_token: 'claim-consent-a', p_succeeded: true })
    expect(finished('consent-b')).toMatchObject({ p_claim_token: 'claim-consent-b', p_succeeded: false })
    expect(finished('consent-c')).toMatchObject({ p_succeeded: true })
    expect(finished('consent-e')).toMatchObject({ p_succeeded: true })
    // Cleared from every row but the refused one, the rest of the attempt kept.
    expect(db.cleared().sort()).toEqual([ENDS, GONE, ENDED_EARLIER, UNKNOWN].sort())
    expect(db.payloads('bank_connections', 'update')).toEqual(Array(4).fill({ consent_attempt: { selection: { listing_only: false } } }))
  })

  it('asks the next run again for a consent it kept, and clears it once the bank ends it', async () => {
    claims()
    connectAnswering({ 'consent-b': new ProviderUnavailableError('bank down', { code: 'CONNECTOR_AIS_PROVIDER_FAILED' }) })
    database([held(REFUSED, 'consent-b')])
    expect((await parseJsonResponse<Summary>(await GET(createCronRequest(PATH, 'Bearer secret')))).body).toMatchObject({ kept: 1, ended: 0 })

    connectAnswering({})
    const next = database([held(REFUSED, 'consent-b')])
    expect((await parseJsonResponse<Summary>(await GET(createCronRequest(PATH, 'Bearer secret')))).body).toMatchObject({ kept: 0, ended: 1 })
    expect(next.cleared()).toEqual([REFUSED])
  })

  it('one failing row does not stop the others', async () => {
    claims({ down: ['consent-f'] })
    const revoke = connectAnswering({})
    const db = database([held(CLAIM_DOWN, 'consent-f'), held(CLEAR_THROWS, 'consent-g'), held(ENDS, 'consent-a')], { clearThrowsFor: CLEAR_THROWS })

    const { status, body } = await parseJsonResponse<Summary>(await GET(createCronRequest(PATH, 'Bearer secret')))
    expect(status).toBe(200)
    // The claim that cannot be read keeps its consent; the clear that throws is counted; the last row still ends.
    expect(body).toEqual({ skipped: false, held: 3, attempted: 3, ended: 1, alreadyEnded: 0, kept: 1, busy: 0, errored: 1, deferred: 0 })
    expect(revoke).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ consentId: 'consent-f' }))
    expect(revoke).toHaveBeenCalledWith('company-1', expect.objectContaining({ consentId: 'consent-a' }))
    expect(db.cleared()).toEqual(expect.arrayContaining([ENDS]))
    expect(db.cleared()).not.toContain(CLAIM_DOWN)
  })

  it('answers skipped, reading nothing, without a connector key', async () => {
    setBankFeedConnectForTests(null)
    const { supabase } = database([held(ENDS, 'consent-a')])
    const { status, body } = await parseJsonResponse<Summary>(await GET(createCronRequest(PATH, 'Bearer secret')))
    expect(status).toBe(200)
    expect(body).toEqual({ skipped: true, reason: 'no_connector' })
    expect(supabase.from).not.toHaveBeenCalled()
    expect(mocks.serviceRpc).not.toHaveBeenCalled()
  })
})
