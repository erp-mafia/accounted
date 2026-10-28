/**
 * The signer's side of a signing request (../ceremony.ts): resolving the link
 * or the member, the BankID start (cooldown, the lock, the payload the
 * signature binds), the poll (the lease, every TIC answer, the binding check,
 * the RPC with hashed and masked evidence, the seal), stopping a session and
 * declining. The database is a table mock; BankID is the registry's tic
 * services; the seal is stubbed (../seal.ts has its own tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { encryptPersonalNumberForStorage, hashPersonalNumber } from '@/lib/auth/bankid'
import { hashSigningToken } from '../tokens'
import type { SigningRequestRow, SigningSignerRow } from '../types'
import { buildUserNonVisibleData } from '../visible-data'
import {
  BANKID_TEST_KEY,
  DAY,
  HOUR,
  MEMBER,
  PN,
  REQ,
  SIGNER,
  VERSION,
  bankIdServices,
  requestRow,
  signerRow,
  testLogger,
  type TestLogger,
} from './fixtures'

const mock = vi.hoisted(() => ({ supabase: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mock.supabase }))
vi.mock('@/lib/email/brand-sender', () => ({ getBaseUrlForCompany: vi.fn().mockResolvedValue('https://app.accounted.se') }))
vi.mock('@/lib/email/send-signing-request', () => ({ sendSigningRequestMail: vi.fn() }))
const registryGet = vi.hoisted(() => vi.fn())
vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { get: registryGet } }))
const bankIdEnabled = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/bankid-flags', () => ({ isBankIdEnabled: bankIdEnabled }))
const seal = vi.hoisted(() => ({ sealSigningRequest: vi.fn() }))
vi.mock('../seal', () => seal)

import {
  cancelSignatureSession,
  declineSignature,
  describeForSigner,
  pollSignature,
  resolveMemberSigner,
  resolveSignerByToken,
  startSignature,
  type SignerScope,
} from '../ceremony'

const NOW = Date.parse('2026-10-25T10:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const SHA = 'ab'.repeat(32)
const CONTENT_HASH = 'cd'.repeat(32)
const SESSION = 'sess-1'
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64')

let db: ReturnType<typeof createTableMockSupabase>
let log: TestLogger
let services: ReturnType<typeof bankIdServices>
let request: SigningRequestRow
let signer: SigningSignerRow
/** What the signer-table reads answer: the lease update, the guarded start update, a lookup. */
let leaseRows: Array<{ id: string }>
let startRows: Array<{ id: string }>
let lookupSigner: SigningSignerRow | null
let lookupRequest: SigningRequestRow | null
let requestUpdateRows: Array<{ id: string }>

const signers: TableMockResolver = (calls) => {
  if (calls.some((c) => c.method === 'or')) return { data: leaseRows }
  if (calls.some((c) => c.method === 'update')) return { data: calls.some((c) => c.method === 'select') ? startRows : null }
  if (calls.some((c) => c.method === 'order')) {
    return { data: [{ position: 1, name: 'Anna Andersson', role_label: 'VD', status: 'pending' }, { position: 2, name: 'Erik Eriksson', role_label: null, status: 'signed' }] }
  }
  return { data: lookupSigner }
}

const requests: TableMockResolver = (calls) => (calls.some((c) => c.method === 'update') ? { data: requestUpdateRows } : { data: lookupRequest })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('BANKID_ENCRYPTION_KEY', BANKID_TEST_KEY)
  request = requestRow({ document_sha256: SHA, expires_at: iso(NOW + 14 * DAY), created_at: iso(NOW - DAY) })
  signer = signerRow({ bankid_session_id: SESSION, bankid_session_started_at: iso(NOW - 30_000) })
  leaseRows = [{ id: SIGNER }]
  startRows = [{ id: SIGNER }]
  lookupSigner = signer
  lookupRequest = request
  requestUpdateRows = [{ id: REQ }]
  db = createTableMockSupabase({
    signing_request_signers: signers,
    signing_requests: requests,
    companies: { data: { name: 'Bolaget AB', team_id: null, archived_at: null } },
    profiles: { data: { full_name: 'Karin Byråsson' } },
    document_attachments: { data: { file_name: 'hyresavtal.pdf' } },
    annual_report_versions: { data: { status: 'ready_for_signature', content_hash: CONTENT_HASH } },
    signing_signer_private: { data: null },
    bankid_identities: { data: null },
    'rpc:record_signing_signature': { data: { ok: true, signing_request_id: REQ, signer_id: SIGNER, signed_at: iso(NOW - 2000), completed: false } },
  })
  mock.supabase = db.supabase
  log = testLogger()
  services = bankIdServices()
  bankIdEnabled.mockReturnValue(true)
  registryGet.mockResolvedValue({ id: 'tic', services })
  seal.sealSigningRequest.mockResolvedValue({ signedDocumentId: 'signed-doc', evidenceDocumentId: 'evidence-doc' })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const scope = (overrides: { request?: SigningRequestRow; signer?: SigningSignerRow } = {}): SignerScope => ({
  service: db.supabase as never,
  request: overrides.request ?? request,
  signer: overrides.signer ?? signer,
  log,
})

const signerUpdates = () => db.payloads('signing_request_signers', 'update') as Array<Record<string, unknown>>
const rpcArgs = () => db.findCall('rpc:record_signing_signature', 'rpc')?.[0] as { p_signer_id: string; p_session_id: string; p_evidence: Record<string, string> } | undefined
const loggedText = () => JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])

describe('resolveSignerByToken', () => {
  const token = 'T'.repeat(43)

  it('refuses a malformed token without reading anything', async () => {
    expect(await resolveSignerByToken(db.supabase as never, 'short')).toEqual({ ok: false, reason: 'invalid_format' })
    expect(db.tables()).toEqual([])
  })

  it('looks the signer up by the token hash, never the clear token', async () => {
    lookupSigner = null
    expect(await resolveSignerByToken(db.supabase as never, token)).toEqual({ ok: false, reason: 'not_found' })
    expect(db.findCall('signing_request_signers', 'eq')).toEqual(['token_hash', hashSigningToken(token)])
    expect(JSON.stringify(db.calls)).not.toContain(token)
  })

  it('answers not_found when the request is gone or the company is archived', async () => {
    lookupRequest = null
    expect(await resolveSignerByToken(db.supabase as never, token)).toEqual({ ok: false, reason: 'not_found' })
    lookupRequest = request
    db.setTable('companies', { data: { archived_at: iso(NOW) } })
    expect(await resolveSignerByToken(db.supabase as never, token)).toEqual({ ok: false, reason: 'not_found' })
    db.setTable('companies', { data: null })
    expect(await resolveSignerByToken(db.supabase as never, token)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('answers the signer and the request', async () => {
    expect(await resolveSignerByToken(db.supabase as never, token)).toEqual({ ok: true, request, signer })
  })
})

describe('resolveMemberSigner', () => {
  it('answers not_signer for a signer addressed to someone else', async () => {
    lookupSigner = signerRow({ user_id: MEMBER })
    expect(await resolveMemberSigner(db.supabase as never, SIGNER, 'someone-else')).toEqual({ ok: false, reason: 'not_signer' })
    lookupSigner = signerRow({ user_id: null })
    expect(await resolveMemberSigner(db.supabase as never, SIGNER, MEMBER)).toEqual({ ok: false, reason: 'not_signer' })
  })

  it('answers the member\'s own signer, and not_found for an unknown one', async () => {
    lookupSigner = signerRow({ user_id: MEMBER })
    expect(await resolveMemberSigner(db.supabase as never, SIGNER, MEMBER)).toMatchObject({ ok: true, signer: { id: SIGNER, user_id: MEMBER } })
    lookupSigner = null
    expect(await resolveMemberSigner(db.supabase as never, SIGNER, MEMBER)).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('describeForSigner', () => {
  it('shows the document, who asks, the signer and everyone asked, without an address or a personnummer', async () => {
    const page = await describeForSigner(
      scope({ signer: signerRow({ lock_kind: 'personnummer', role_label: 'VD', email: 'anna@example.se' }), request: requestRow({ ...request, message: 'Hej' }) }),
      NOW,
    )
    expect(page).toEqual({
      request: {
        title: 'Hyresavtal',
        message: 'Hej',
        company_name: 'Bolaget AB',
        requester: 'Karin Byråsson',
        file_name: 'hyresavtal.pdf',
        sha256: SHA,
        state: 'open',
        expires_at: request.expires_at,
        signed_copy: false,
      },
      signer: { position: 1, name: 'Anna Andersson', role_label: 'VD', status: 'pending', signed_at: null, bankid_name: null, locked: true, last_error_code: null },
      signers: [
        { position: 1, name: 'Anna Andersson', role_label: 'VD', status: 'pending' },
        { position: 2, name: 'Erik Eriksson', role_label: null, status: 'signed' },
      ],
    })
    expect(JSON.stringify(page)).not.toContain('anna@example.se')
    expect(db.findCall('signing_request_signers', 'select')).toEqual(['position, name, role_label, status'])
  })

  it('reads an open request past its expiry as expired, and names the BankID signer', async () => {
    const page = await describeForSigner(
      scope({
        request: requestRow({ ...request, expires_at: iso(NOW - 1) }),
        signer: signerRow({ status: 'signed', signed_at: iso(NOW - DAY), bankid_given_name: 'Anna', bankid_surname: 'Andersson' }),
      }),
      NOW,
    )
    expect(page.request.state).toBe('expired')
    expect(page.signer).toMatchObject({ status: 'signed', bankid_name: 'Anna Andersson', locked: false })
  })

  it('offers the signed copy only once the request is completed and sealed', async () => {
    const completed = requestRow({ ...request, status: 'completed', completed_at: iso(NOW - HOUR) })
    expect((await describeForSigner(scope({ request: completed }), NOW)).request.signed_copy).toBe(false)
    const sealed = requestRow({ ...completed, signed_document_id: 'doc-signed', evidence_document_id: 'doc-evidence' })
    const page = await describeForSigner(scope({ request: sealed }), NOW)
    expect(page.request).toMatchObject({ state: 'completed', signed_copy: true })
  })
})

describe('startSignature', () => {
  const started = { ok: true, data: { sessionId: 'sess-new', autoStartToken: 'auto-1', qrStartToken: 'qr-1', qrStartSecret: 'secret-1', expiresAt: iso(NOW + 180_000) } }
  const fresh = () => signerRow({ bankid_session_id: null, bankid_session_started_at: null })
  const start = (s: SignerScope) => startSignature(s, { endUserIp: '203.0.113.9', userAgent: 'Browser/1.0', now: NOW })
  const startInput = () => services.startBankIdSignature.mock.calls[0]![0] as Record<string, unknown>

  beforeEach(() => {
    services.startBankIdSignature.mockResolvedValue(started)
  })

  it('refuses a closed or expired request and a signer who is not pending, without asking BankID', async () => {
    for (const r of [
      requestRow({ ...request, status: 'cancelled', cancelled_at: iso(NOW) }),
      requestRow({ ...request, status: 'completed', completed_at: iso(NOW) }),
      requestRow({ ...request, expires_at: iso(NOW - 1) }),
    ]) {
      expect(await start(scope({ request: r, signer: fresh() }))).toEqual({ ok: false, code: 'SIGNING_REQUEST_CLOSED' })
    }
    expect(await start(scope({ signer: signerRow({ status: 'declined', declined_at: iso(NOW) }) }))).toEqual({ ok: false, code: 'SIGNING_SIGNER_NOT_PENDING' })
    expect(services.startBankIdSignature).not.toHaveBeenCalled()
  })

  it('refuses a second start within three seconds of the last', async () => {
    expect(await start(scope({ signer: signerRow({ bankid_session_id: SESSION, bankid_session_started_at: iso(NOW - 1000) }) }))).toEqual({ ok: false, code: 'SIGNING_RATE_LIMITED' })
    expect(services.startBankIdSignature).not.toHaveBeenCalled()
    expect((await start(scope({ signer: signerRow({ bankid_session_id: SESSION, bankid_session_started_at: iso(NOW - 4000) }) }))).ok).toBe(true)
  })

  it('answers SIGNING_UNAVAILABLE when no BankID provider is wired', async () => {
    registryGet.mockResolvedValue(undefined)
    expect(await start(scope({ signer: fresh() }))).toEqual({ ok: false, code: 'SIGNING_UNAVAILABLE' })
  })

  it('refuses an årsredovisning request whose version stopped waiting for signatures', async () => {
    db.setTable('annual_report_versions', { data: { status: 'superseded', content_hash: CONTENT_HASH } })
    const r = requestRow({ ...request, annual_report_version_id: VERSION })
    expect(await start(scope({ request: r, signer: fresh() }))).toEqual({ ok: false, code: 'SIGNING_SUBJECT_CHANGED' })
    db.setTable('annual_report_versions', { data: null })
    expect(await start(scope({ request: r, signer: fresh() }))).toEqual({ ok: false, code: 'SIGNING_SUBJECT_CHANGED' })
    expect(services.startBankIdSignature).not.toHaveBeenCalled()
  })

  it('starts an unlocked signer without a personnummer, showing the document and binding its hash and the ids', async () => {
    const result = await start(scope({ signer: fresh() }))
    expect(result).toEqual({ ok: true, data: { auto_start_token: 'auto-1', qr_start_token: 'qr-1', qr_start_secret: 'secret-1', expires_at: iso(NOW + 180_000) } })
    const sent = startInput()
    expect(sent).toMatchObject({ endUserIp: '203.0.113.9', userAgent: 'Browser/1.0' })
    expect(sent).not.toHaveProperty('personalNumber')
    expect(JSON.parse(String(sent.userNonVisibleData))).toEqual({ v: 1, kind: 'accounted.signing', request: REQ, signer: SIGNER, sha256: SHA })
    expect(sent.userVisibleData).toContain('Jag signerar *Hyresavtal* för Bolaget AB.')
    expect(sent.userVisibleData).toContain('+ Undertecknare: Anna Andersson')
    expect(sent.userVisibleData).toContain('+ Fil: hyresavtal.pdf')
    expect(sent.userVisibleData).toContain(`+ Kontrollsumma (SHA-256): ${SHA.slice(0, 16)}`)
    expect(services.cancelBankIdSignature).not.toHaveBeenCalled()
  })

  it('stores the new session on the signer, guarded on pending', async () => {
    await start(scope({ signer: fresh() }))
    expect(signerUpdates()).toEqual([{ bankid_session_id: 'sess-new', bankid_session_started_at: iso(NOW), poll_lease_until: null, last_error_code: null }])
    expect(db.findCalls('signing_request_signers', 'eq')).toEqual(expect.arrayContaining([['id', SIGNER], ['status', 'pending']]))
  })

  it('carries the årsredovisning content hash in the hidden payload', async () => {
    const r = requestRow({ ...request, annual_report_version_id: VERSION })
    expect((await start(scope({ request: r, signer: fresh() }))).ok).toBe(true)
    expect(JSON.parse(String(startInput().userNonVisibleData))).toEqual({ v: 1, kind: 'accounted.signing', request: REQ, signer: SIGNER, sha256: SHA, content_hash: CONTENT_HASH })
  })

  it('locks a personnummer signer to the number on the private table, and never logs it', async () => {
    db.setTable('signing_signer_private', { data: { lock_personnummer_encrypted: encryptPersonalNumberForStorage(PN) } })
    const s = signerRow({ lock_kind: 'personnummer', bankid_session_id: null, bankid_session_started_at: null })
    expect((await start(scope({ signer: s }))).ok).toBe(true)
    expect(startInput().personalNumber).toBe(PN)
    expect(db.findCall('signing_signer_private', 'eq')).toEqual(['signer_id', SIGNER])
    expect(loggedText()).not.toContain(PN)
  })

  it('refuses a personnummer signer whose lock is gone', async () => {
    const s = signerRow({ lock_kind: 'personnummer', bankid_session_id: null, bankid_session_started_at: null })
    expect(await start(scope({ signer: s }))).toEqual({ ok: false, code: 'SIGNING_SIGNER_MISMATCH' })
    expect(services.startBankIdSignature).not.toHaveBeenCalled()
  })

  it('locks a member to their own BankID login, and refuses one without a login', async () => {
    const s = signerRow({ lock_kind: 'member', user_id: MEMBER, bankid_session_id: null, bankid_session_started_at: null })
    db.setTable('bankid_identities', { data: { personal_number_enc: encryptPersonalNumberForStorage(PN) } })
    expect((await start(scope({ signer: s }))).ok).toBe(true)
    expect(startInput().personalNumber).toBe(PN)
    expect(db.findCall('bankid_identities', 'eq')).toEqual(['user_id', MEMBER])

    services.startBankIdSignature.mockClear()
    db.setTable('bankid_identities', { data: null })
    expect(await start(scope({ signer: s }))).toEqual({ ok: false, code: 'SIGNING_SIGNER_MISMATCH' })
    expect(services.startBankIdSignature).not.toHaveBeenCalled()
  })

  it('cancels the session already running before it starts the new one', async () => {
    const s = signerRow({ bankid_session_id: 'sess-old', bankid_session_started_at: iso(NOW - 60_000) })
    services.cancelBankIdSignature.mockRejectedValue(new Error('TIC said no'))
    expect((await start(scope({ signer: s }))).ok).toBe(true)
    expect(services.cancelBankIdSignature).toHaveBeenCalledWith('sess-old')
    expect(services.cancelBankIdSignature.mock.invocationCallOrder[0]!).toBeLessThan(services.startBankIdSignature.mock.invocationCallOrder[0]!)
  })

  it('maps a provider refusal and stores no session', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['RATE_LIMITED', { ok: false, code: 'SIGNING_RATE_LIMITED' }],
      ['NOT_CONFIGURED', { ok: false, code: 'SIGNING_UNAVAILABLE' }],
      ['TIMEOUT', { ok: false, code: 'SIGNING_PROVIDER_ERROR', details: { provider_code: 'TIMEOUT' } }],
      ['PROVIDER_ERROR', { ok: false, code: 'SIGNING_PROVIDER_ERROR', details: { provider_code: 'PROVIDER_ERROR' } }],
    ]
    for (const [code, expected] of cases) {
      services.startBankIdSignature.mockResolvedValue({ ok: false, code, httpStatus: 503 })
      expect(await start(scope({ signer: fresh() })), code).toEqual(expected)
    }
    expect(signerUpdates()).toEqual([])
    expect(log.warn).toHaveBeenCalledWith('signing start refused by the provider', expect.objectContaining({ signerId: SIGNER }))
  })

  it('stops the new session when the signer stopped being pending meanwhile', async () => {
    startRows = []
    expect(await start(scope({ signer: fresh() }))).toEqual({ ok: false, code: 'SIGNING_SIGNER_NOT_PENDING' })
    expect(services.cancelBankIdSignature).toHaveBeenCalledWith('sess-new')
  })
})

/** A collected BankID signature over `nonVisible`, carrying `visible` as the text the app showed. */
function collected(nonVisible: string, visible: string | null = '# Signera dokument\n\nJag signerar *Hyresavtal* för Bolaget AB.') {
  const visibleElement = visible === null ? '' : `<usrVisibleData charset="UTF-8" visible="wysiwys">${b64(visible)}</usrVisibleData>`
  const xml = `<?xml version="1.0"?><Signature><Object><bankIdSignedData>${visibleElement}<usrNonVisibleData>${b64(nonVisible)}</usrNonVisibleData></bankIdSignedData></Object></Signature>`
  return {
    personalNumber: PN,
    givenName: 'Anna',
    surname: 'Andersson',
    name: 'Anna Andersson',
    completedAt: iso(NOW - 2000),
    signatureXml: b64(xml),
    ocspResponse: b64('ocsp-response'),
  }
}

const boundPayload = (overrides: Record<string, unknown> = {}) =>
  buildUserNonVisibleData({ v: 1, kind: 'accounted.signing', request: REQ, signer: SIGNER, sha256: SHA, ...overrides })

describe('pollSignature', () => {
  const poll = (s: SignerScope = scope()) => pollSignature(s, NOW)
  const complete = (signature = collected(boundPayload())) => services.pollBankIdSignature.mockResolvedValue({ ok: true, data: { status: 'complete', signature } })
  const endedWith = (code: string | null) => expect(signerUpdates()).toContainEqual({ bankid_session_id: null, poll_lease_until: null, last_error_code: code })

  it('answers signed for a signer who already signed, without asking BankID', async () => {
    const s = signerRow({ status: 'signed', signed_at: iso(NOW - DAY) })
    expect(await poll(scope({ signer: s }))).toEqual({ ok: true, data: { state: 'signed', signed_at: iso(NOW - DAY), completed: false } })
    const done = requestRow({ ...request, status: 'completed', completed_at: iso(NOW) })
    expect(await poll(scope({ signer: s, request: done }))).toEqual({ ok: true, data: { state: 'signed', signed_at: iso(NOW - DAY), completed: true } })
    expect(services.pollBankIdSignature).not.toHaveBeenCalled()
    expect(db.tables()).toEqual([])
  })

  it('refuses a request that closed', async () => {
    expect(await poll(scope({ request: requestRow({ ...request, status: 'declined', declined_at: iso(NOW) }) }))).toEqual({ ok: false, code: 'SIGNING_REQUEST_CLOSED' })
    expect(services.pollBankIdSignature).not.toHaveBeenCalled()
  })

  it('is idle without a session, and writes nothing', async () => {
    expect(await poll(scope({ signer: signerRow() }))).toEqual({ ok: true, data: { state: 'idle' } })
    expect(signerUpdates()).toEqual([])
    expect(services.pollBankIdSignature).not.toHaveBeenCalled()
  })

  it('takes a ten second lease, guarded on the session and on no live lease', async () => {
    services.pollBankIdSignature.mockResolvedValue({ ok: true, data: { status: 'pending', hintCode: null, qrStartToken: null, qrStartSecret: null } })
    await poll()
    expect(signerUpdates()[0]).toEqual({ poll_lease_until: iso(NOW + 10_000) })
    expect(db.findCall('signing_request_signers', 'or')).toEqual([`poll_lease_until.is.null,poll_lease_until.lt.${iso(NOW)}`])
    expect(db.findCalls('signing_request_signers', 'eq')).toEqual(expect.arrayContaining([['bankid_session_id', SESSION], ['status', 'pending']]))
  })

  it('answers pending without asking BankID when another poll holds the lease', async () => {
    leaseRows = []
    expect(await poll()).toEqual({ ok: true, data: { state: 'pending', hint_code: null, qr_start_token: null, qr_start_secret: null } })
    expect(services.pollBankIdSignature).not.toHaveBeenCalled()
    expect(signerUpdates()).toHaveLength(1)
  })

  it('passes the hint and the QR tokens on while BankID is pending, and lets the lease go', async () => {
    services.pollBankIdSignature.mockResolvedValue({ ok: true, data: { status: 'pending', hintCode: 'outstandingTransaction', qrStartToken: 'qr-2', qrStartSecret: 'secret-2' } })
    expect(await poll()).toEqual({ ok: true, data: { state: 'pending', hint_code: 'outstandingTransaction', qr_start_token: 'qr-2', qr_start_secret: 'secret-2' } })
    expect(services.pollBankIdSignature).toHaveBeenCalledWith(SESSION)
    expect(signerUpdates()[1]).toEqual({ poll_lease_until: null })
    expect(rpcArgs()).toBeUndefined()
  })

  it('ends the session when BankID failed, was cancelled or is gone', async () => {
    services.pollBankIdSignature.mockResolvedValue({ ok: true, data: { status: 'failed', hintCode: 'userCancel' } })
    expect(await poll()).toEqual({ ok: true, data: { state: 'failed', hint_code: 'userCancel', code: null } })
    endedWith(null)
    services.pollBankIdSignature.mockResolvedValue({ ok: true, data: { status: 'cancelled' } })
    expect(await poll()).toEqual({ ok: true, data: { state: 'failed', hint_code: null, code: null } })
    services.pollBankIdSignature.mockResolvedValue({ ok: true, data: { status: 'gone' } })
    expect(await poll()).toEqual({ ok: true, data: { state: 'failed', hint_code: null, code: 'SIGNING_EVIDENCE_INCOMPLETE' } })
    expect(rpcArgs()).toBeUndefined()
  })

  it('maps a provider failure and lets the lease go', async () => {
    services.pollBankIdSignature.mockResolvedValue({ ok: false, code: 'TIMEOUT' })
    expect(await poll()).toEqual({ ok: false, code: 'SIGNING_PROVIDER_ERROR', details: { provider_code: 'TIMEOUT' } })
    expect(signerUpdates()[1]).toEqual({ poll_lease_until: null })
  })

  it('refuses a completed signature that does not bind this document and signer, and records nothing', async () => {
    for (const nonVisible of [boundPayload({ sha256: 'ef'.repeat(32) }), boundPayload({ signer: 'another-signer' }), boundPayload({ request: 'another-request' }), 'not our payload']) {
      complete(collected(nonVisible))
      expect(await poll(), nonVisible).toEqual({ ok: false, code: 'SIGNING_SIGNATURE_UNBOUND' })
    }
    endedWith('SIGNING_SIGNATURE_UNBOUND')
    expect(rpcArgs()).toBeUndefined()
    expect(seal.sealSigningRequest).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith('BankID signature does not bind the signing payload', expect.any(Error), { signerId: SIGNER })
  })

  it('refuses an årsredovisning signature that does not carry the version\'s content hash', async () => {
    const r = requestRow({ ...request, annual_report_version_id: VERSION })
    complete(collected(boundPayload()))
    expect(await poll(scope({ request: r }))).toEqual({ ok: false, code: 'SIGNING_SIGNATURE_UNBOUND' })
    complete(collected(boundPayload({ content_hash: CONTENT_HASH })))
    expect((await poll(scope({ request: r }))).ok).toBe(true)
    expect(rpcArgs()?.p_signer_id).toBe(SIGNER)
  })

  it('refuses when the årsredovisning version changed while the signer signed', async () => {
    db.setTable('annual_report_versions', { data: { status: 'superseded', content_hash: CONTENT_HASH } })
    complete(collected(boundPayload({ content_hash: CONTENT_HASH })))
    expect(await poll(scope({ request: requestRow({ ...request, annual_report_version_id: VERSION }) }))).toEqual({ ok: false, code: 'SIGNING_SUBJECT_CHANGED' })
    endedWith('SIGNING_SUBJECT_CHANGED')
    expect(rpcArgs()).toBeUndefined()
  })

  it('refuses a bound signature that carries no visible text', async () => {
    complete(collected(boundPayload(), null))
    expect(await poll()).toEqual({ ok: false, code: 'SIGNING_EVIDENCE_INCOMPLETE' })
    endedWith('SIGNING_EVIDENCE_INCOMPLETE')
    expect(rpcArgs()).toBeUndefined()
  })

  it('records a bound signature through the RPC: the personnummer hashed and masked, never in clear', async () => {
    const signature = collected(boundPayload())
    complete(signature)
    expect(await poll()).toEqual({ ok: true, data: { state: 'signed', signed_at: iso(NOW - 2000), completed: false } })
    expect(rpcArgs()).toEqual({
      p_signer_id: SIGNER,
      p_session_id: SESSION,
      p_evidence: {
        given_name: 'Anna',
        surname: 'Andersson',
        personnummer_hash: hashPersonalNumber(PN),
        personnummer_masked: 'XXXXXXXX-1239',
        completed_at: iso(NOW - 2000),
        user_visible_data: '# Signera dokument\n\nJag signerar *Hyresavtal* för Bolaget AB.',
        signature_xml: signature.signatureXml,
        ocsp_response: signature.ocspResponse,
      },
    })
    expect(JSON.stringify(rpcArgs())).not.toContain(PN)
    expect(loggedText()).not.toContain(PN)
    expect(seal.sealSigningRequest).not.toHaveBeenCalled()
  })

  it('seals the request when the signature was the last one', async () => {
    db.setTable('rpc:record_signing_signature', { data: { ok: true, signed_at: iso(NOW - 2000), completed: true } })
    complete()
    expect(await poll()).toEqual({ ok: true, data: { state: 'signed', signed_at: iso(NOW - 2000), completed: true } })
    expect(seal.sealSigningRequest).toHaveBeenCalledWith(db.supabase, REQ, log)
  })

  it('answers signed even when the seal fails (it is retried on a later read)', async () => {
    db.setTable('rpc:record_signing_signature', { data: { ok: true, signed_at: iso(NOW - 2000), completed: true } })
    seal.sealSigningRequest.mockRejectedValue(new Error('storage down'))
    complete()
    expect(await poll()).toMatchObject({ ok: true, data: { state: 'signed', completed: true } })
    expect(log.error).toHaveBeenCalledWith('signing request seal failed; retried on the next read', expect.any(Error), { signingRequestId: REQ })
  })

  it('passes on the RPC\'s refusal and ends the session with its code', async () => {
    db.setTable('rpc:record_signing_signature', { data: { ok: false, code: 'SIGNING_SIGNER_MISMATCH' } })
    complete()
    expect(await poll()).toEqual({ ok: false, code: 'SIGNING_SIGNER_MISMATCH' })
    endedWith('SIGNING_SIGNER_MISMATCH')
    expect(seal.sealSigningRequest).not.toHaveBeenCalled()
  })

  it('ends the session and throws when the RPC itself fails', async () => {
    db.setTable('rpc:record_signing_signature', { data: null, error: { message: 'SIGNING_SLOT_NOT_PENDING: the slot moved' } })
    complete()
    await expect(poll()).rejects.toMatchObject({ message: 'SIGNING_SLOT_NOT_PENDING: the slot moved' })
    endedWith('SIGNING_RECORD_FAILED')
  })
})

describe('cancelSignatureSession', () => {
  it('stops the running session at BankID and on the signer', async () => {
    expect(await cancelSignatureSession(scope())).toEqual({ ok: true, data: { cancelled: true } })
    expect(services.cancelBankIdSignature).toHaveBeenCalledWith(SESSION)
    expect(signerUpdates()).toEqual([{ bankid_session_id: null, poll_lease_until: null, last_error_code: null }])
    expect(db.findCalls('signing_request_signers', 'eq')).toEqual(expect.arrayContaining([['bankid_session_id', SESSION]]))
  })

  it('answers the same without a session, and for a signer who is not pending, writing nothing', async () => {
    expect(await cancelSignatureSession(scope({ signer: signerRow() }))).toEqual({ ok: true, data: { cancelled: true } })
    expect(await cancelSignatureSession(scope({ signer: signerRow({ bankid_session_id: SESSION, status: 'signed', signed_at: iso(NOW) }) }))).toEqual({ ok: true, data: { cancelled: true } })
    expect(services.cancelBankIdSignature).not.toHaveBeenCalled()
    expect(signerUpdates()).toEqual([])
  })
})

describe('declineSignature', () => {
  const decline = (s: SignerScope = scope(), reason?: string | null) => declineSignature(s, { reason, now: NOW })

  it('refuses a closed request and a signer who is not pending', async () => {
    expect(await decline(scope({ request: requestRow({ ...request, expires_at: iso(NOW - 1) }) }))).toEqual({ ok: false, code: 'SIGNING_REQUEST_CLOSED' })
    expect(await decline(scope({ signer: signerRow({ status: 'signed', signed_at: iso(NOW) }) }))).toEqual({ ok: false, code: 'SIGNING_SIGNER_NOT_PENDING' })
    expect(db.payloads('signing_requests', 'update')).toEqual([])
  })

  it('stops the running session, closes the request first and then the signer, with the reason', async () => {
    expect(await decline(scope(), '  Fel belopp i avtalet  ')).toEqual({ ok: true, data: { declined: true } })
    expect(services.cancelBankIdSignature).toHaveBeenCalledWith(SESSION)
    expect(db.payloads('signing_requests', 'update')).toEqual([{ status: 'declined', declined_at: iso(NOW) }])
    expect(db.findCalls('signing_requests', 'eq')).toEqual(expect.arrayContaining([['id', REQ], ['status', 'open']]))
    const declined = { status: 'declined', declined_at: iso(NOW), decline_reason: 'Fel belopp i avtalet', bankid_session_id: null, poll_lease_until: null }
    expect(signerUpdates()).toContainEqual(declined)
    // The request is closed before the signer, record_signing_signature's lock order.
    const requestUpdate = db.calls.findIndex((c) => c.table === 'signing_requests' && c.method === 'update')
    const signerDecline = db.calls.findIndex((c) => c.table === 'signing_request_signers' && c.method === 'update' && (c.args[0] as { status?: string }).status === 'declined')
    expect(requestUpdate).toBeGreaterThanOrEqual(0)
    expect(requestUpdate).toBeLessThan(signerDecline)
  })

  it('keeps at most 500 characters of the reason, and none for a blank one', async () => {
    await decline(scope({ signer: signerRow() }), 'x'.repeat(600))
    await decline(scope({ signer: signerRow() }), '   ')
    await decline(scope({ signer: signerRow() }))
    expect(signerUpdates().map((u) => u.decline_reason)).toEqual(['x'.repeat(500), null, null])
  })

  it('refuses, and leaves the signer pending, when the request closed in the meantime', async () => {
    requestUpdateRows = []
    expect(await decline(scope({ signer: signerRow() }))).toEqual({ ok: false, code: 'SIGNING_REQUEST_CLOSED' })
    expect(signerUpdates()).toEqual([])
  })
})
