/**
 * Signing requests (../requests.ts): who and what can be sent for signing,
 * what is stored (token hashes, never a clear token; a typed personnummer
 * only hashed and encrypted, on the private table), who is mailed and who
 * gets the link in the answer, and the sender's cancel and remind. The
 * database is a table mock with storage; the mail, the brand base URL and the
 * BankID provider (the registry's tic services) are stubbed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import type { OperationContext } from '@/lib/operations/types'
import { decryptStoredPersonalNumber, hashPersonalNumber } from '@/lib/auth/bankid'
import { sha256Hex } from '../document'
import { hashSigningToken } from '../tokens'
import type { SigningRequestRow, SigningSignerRow } from '../types'
import {
  BANKID_TEST_KEY,
  BASE_URL,
  COMPANY,
  DAY,
  DOC,
  HOUR,
  MEMBER,
  MINUTE,
  PN,
  REQ,
  SENDER,
  SIGNER,
  VERSION,
  attachStorage,
  bankIdServices,
  onePagePdf,
  requestRow,
  signerRow,
  testLogger,
  type TestLogger,
} from './fixtures'

const mock = vi.hoisted(() => ({ supabase: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mock.supabase }))
vi.mock('@/lib/email/brand-sender', () => ({ getBaseUrlForCompany: vi.fn().mockResolvedValue('https://app.accounted.se') }))
const mail = vi.hoisted(() => ({ sendSigningRequestMail: vi.fn() }))
vi.mock('@/lib/email/send-signing-request', () => mail)
const registryGet = vi.hoisted(() => vi.fn())
vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { get: registryGet } }))
const bankIdEnabled = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/bankid-flags', () => ({ isBankIdEnabled: bankIdEnabled }))
const capability = vi.hoisted(() => vi.fn())
vi.mock('@/lib/entitlements/has-capability', () => ({ hasCapability: capability }))
const usageGate = vi.hoisted(() => vi.fn())
vi.mock('@/lib/usage/gate', () => ({ usageGateRefusal: usageGate }))

import { cancelSigningRequest, createSigningRequest, describeRequester, remindSigner, signingAvailability, type CreateSigningRequestInput } from '../requests'

const NOW = Date.parse('2026-10-25T10:00:00.000Z')
const STORAGE_PATH = `documents/${COMPANY}/${DOC}.pdf`

let pdf: Uint8Array
let db: ReturnType<typeof createTableMockSupabase>
let files: Map<string, Uint8Array>
let log: TestLogger
let ctx: OperationContext
let services: ReturnType<typeof bankIdServices>
/** Company members the signer check finds, and the caller's role for cancel and remind. */
let members: string[]
let role: string
/** Users with a BankID login. */
let bankIdUsers: Set<string>

beforeAll(async () => {
  pdf = await onePagePdf()
})

function documentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC,
    company_id: COMPANY,
    user_id: SENDER,
    file_name: 'hyresavtal.pdf',
    mime_type: 'application/pdf',
    file_size_bytes: pdf.byteLength,
    storage_path: STORAGE_PATH,
    sha256_hash: sha256Hex(pdf),
    is_current_version: true,
    ...overrides,
  }
}

const companyMembers: TableMockResolver = (calls) =>
  calls.some((c) => c.method === 'in') ? { data: members.map((user_id) => ({ user_id })) } : { data: { role } }

const bankIdIdentities: TableMockResolver = (calls) => {
  const userId = calls.find((c) => c.method === 'eq' && c.args[0] === 'user_id')?.args[1] as string | undefined
  return { data: userId && bankIdUsers.has(userId) ? { user_id: userId } : null }
}

const createdRequest: TableMockResolver = (calls) => (calls.some((c) => c.method === 'insert') ? { data: { id: REQ } } : { data: null })

const createdSigners: TableMockResolver = (calls) => {
  const insert = calls.find((c) => c.method === 'insert')
  if (!insert) return { data: null }
  return { data: (insert.args[0] as Array<{ position: number }>).map((r) => ({ id: `signer-${r.position}`, position: r.position })) }
}

beforeEach(() => {
  vi.clearAllMocks()
  usageGate.mockResolvedValue(null)
  vi.stubEnv('SIGNING_ENABLED', '1')
  vi.stubEnv('SIGNING_ARSREDOVISNING_ENABLED', '1')
  vi.stubEnv('BANKID_ENCRYPTION_KEY', BANKID_TEST_KEY)
  members = [MEMBER]
  role = 'owner'
  bankIdUsers = new Set([MEMBER])
  db = createTableMockSupabase({
    document_attachments: { data: documentRow() },
    company_members: companyMembers,
    bankid_identities: bankIdIdentities,
    signing_requests: createdRequest,
    signing_request_signers: createdSigners,
    signing_signer_private: { data: null },
    companies: { data: { name: 'Bolaget AB', team_id: null } },
    profiles: { data: { full_name: 'Karin Byråsson' } },
  })
  files = new Map([[STORAGE_PATH, pdf]])
  attachStorage(db.supabase, files)
  mock.supabase = db.supabase
  log = testLogger()
  ctx = { supabase: db.supabase as never, companyId: COMPANY, userId: SENDER, log }
  services = bankIdServices()
  bankIdEnabled.mockReturnValue(true)
  capability.mockResolvedValue(true)
  registryGet.mockResolvedValue({ id: 'tic', services })
  mail.sendSigningRequestMail.mockResolvedValue({ emailSent: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function input(overrides: Partial<CreateSigningRequestInput> = {}): CreateSigningRequestInput {
  return {
    documentId: DOC,
    title: 'Hyresavtal',
    signers: [{ name: 'Anna Andersson', email: 'anna@example.se' }],
    createdVia: 'app',
    now: NOW,
    ...overrides,
  }
}

const insertedRequests = () => db.payloads('signing_requests', 'insert') as Array<Record<string, unknown>>
const insertedSigners = () => (db.payloads('signing_request_signers', 'insert')[0] ?? []) as Array<Record<string, unknown>>
const insertedPrivates = () => (db.payloads('signing_signer_private', 'insert')[0] ?? []) as Array<Record<string, unknown>>
const tokenOf = (url: string) => url.split('/signera/')[1]!

describe('signingAvailability', () => {
  it('offers signing by the rollout and the provider, and lets the plan and the årsredovisning rollout decide the rest', async () => {
    expect(await signingAvailability(db.supabase as never, COMPANY)).toEqual({ offered: true, available: true, arsredovisning: true })

    vi.stubEnv('SIGNING_ARSREDOVISNING_ENABLED', '')
    expect(await signingAvailability(db.supabase as never, COMPANY)).toEqual({ offered: true, available: true, arsredovisning: false })

    capability.mockResolvedValue(false)
    vi.stubEnv('SIGNING_ARSREDOVISNING_ENABLED', '1')
    expect(await signingAvailability(db.supabase as never, COMPANY)).toEqual({ offered: true, available: false, arsredovisning: false })

    vi.stubEnv('SIGNING_ENABLED', '00000000-0000-4000-8000-0000000000aa')
    expect(await signingAvailability(db.supabase as never, COMPANY)).toEqual({ offered: false, available: false, arsredovisning: false })
  })
})

describe('createSigningRequest refuses', () => {
  it('when the signing switch is off, BankID is off or no provider is wired, before reading anything', async () => {
    vi.stubEnv('SIGNING_ENABLED', '')
    expect(await createSigningRequest(ctx, input())).toEqual({ ok: false, code: 'SIGNING_UNAVAILABLE' })
    vi.stubEnv('SIGNING_ENABLED', '1')
    bankIdEnabled.mockReturnValue(false)
    expect(await createSigningRequest(ctx, input())).toEqual({ ok: false, code: 'SIGNING_UNAVAILABLE' })
    bankIdEnabled.mockReturnValue(true)
    registryGet.mockResolvedValue(undefined)
    expect(await createSigningRequest(ctx, input())).toEqual({ ok: false, code: 'SIGNING_UNAVAILABLE' })
    expect(db.tables()).toEqual([])
  })

  it('when the rollout leaves the company out, before reading anything', async () => {
    vi.stubEnv('SIGNING_ENABLED', '00000000-0000-4000-8000-0000000000aa')
    expect(await createSigningRequest(ctx, input())).toEqual({ ok: false, code: 'SIGNING_UNAVAILABLE' })
    vi.stubEnv('SIGNING_ENABLED', `00000000-0000-4000-8000-0000000000aa, ${COMPANY.toUpperCase()}`)
    capability.mockResolvedValue(false)
    expect(await createSigningRequest(ctx, input())).toEqual({ ok: false, code: 'SIGNING_CAPABILITY_BLOCKED' })
    expect(db.tables()).toEqual([])
  })

  it('when the plan does not hold signing, and asks the gate for this company only', async () => {
    capability.mockResolvedValue(false)
    expect(await createSigningRequest(ctx, input())).toEqual({ ok: false, code: 'SIGNING_CAPABILITY_BLOCKED' })
    expect(capability).toHaveBeenCalledWith(db.supabase, COMPANY, 'signing')
    expect(db.tables()).toEqual([])
  })

  it('an annual-report request while the årsredovisning rollout leaves the company out', async () => {
    vi.stubEnv('SIGNING_ARSREDOVISNING_ENABLED', '')
    expect(await createSigningRequest(ctx, input({ annualReportVersionId: VERSION }))).toEqual({ ok: false, code: 'SIGNING_UNAVAILABLE' })
    expect(db.tables()).toEqual([])
  })

  it('a blank title', async () => {
    expect(await createSigningRequest(ctx, input({ title: '   ' }))).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'title' } })
    expect(insertedRequests()).toEqual([])
  })

  it('a document that is not a current PDF of at most 10 MB that opens', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ mime_type: 'image/png' }, 'SIGNING_DOCUMENT_UNSUPPORTED'],
      [{ is_current_version: false }, 'SIGNING_DOCUMENT_UNSUPPORTED'],
      [{ file_size_bytes: 10 * 1024 * 1024 + 1 }, 'SIGNING_DOCUMENT_UNSUPPORTED'],
    ]
    for (const [overrides, code] of cases) {
      db.setTable('document_attachments', { data: documentRow(overrides) })
      expect(await createSigningRequest(ctx, input()), JSON.stringify(overrides)).toEqual({ ok: false, code })
    }
    const notPdf = new TextEncoder().encode('just text, not a pdf')
    files.set(STORAGE_PATH, notPdf)
    db.setTable('document_attachments', { data: documentRow({ sha256_hash: sha256Hex(notPdf), file_size_bytes: notPdf.byteLength }) })
    expect(await createSigningRequest(ctx, input())).toEqual({ ok: false, code: 'SIGNING_DOCUMENT_UNSUPPORTED' })
    expect(insertedRequests()).toEqual([])
  })

  it('a document that is not in the archive or not in storage, and one whose stored bytes no longer match its hash', async () => {
    db.setTable('document_attachments', { data: null })
    expect(await createSigningRequest(ctx, input())).toEqual({ ok: false, code: 'SIGNING_DOCUMENT_NOT_FOUND' })
    db.setTable('document_attachments', { data: documentRow() })
    files.delete(STORAGE_PATH)
    expect(await createSigningRequest(ctx, input())).toEqual({ ok: false, code: 'SIGNING_DOCUMENT_NOT_FOUND' })
    files.set(STORAGE_PATH, await onePagePdf('Ett annat avtal'))
    expect(await createSigningRequest(ctx, input())).toEqual({ ok: false, code: 'SIGNING_DOCUMENT_CHANGED' })
    expect(insertedRequests()).toEqual([])
  })

  it('no signer or more than 20, and a signer without a name', async () => {
    expect(await createSigningRequest(ctx, input({ signers: [] }))).toMatchObject({ ok: false, code: 'SIGNING_SIGNERS_INVALID', details: { reason: 'count' } })
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `Person ${i}` }))
    expect(await createSigningRequest(ctx, input({ signers: many }))).toMatchObject({ details: { reason: 'count' } })
    expect(await createSigningRequest(ctx, input({ signers: [{ name: '  ' }] }))).toMatchObject({ details: { reason: 'name' } })
    expect(insertedRequests()).toEqual([])
  })

  it('the same address twice, whatever its case and spaces', async () => {
    const result = await createSigningRequest(ctx, input({ signers: [{ name: 'Anna', email: 'anna@example.se' }, { name: 'Anna B', email: ' ANNA@Example.se ' }] }))
    expect(result).toEqual({ ok: false, code: 'SIGNING_SIGNERS_INVALID', details: { reason: 'duplicate_email' } })
    expect(insertedRequests()).toEqual([])
  })

  it('a user_id that is not a member of the company, and the same member twice', async () => {
    members = []
    expect(await createSigningRequest(ctx, input({ signers: [{ name: 'Erik', userId: MEMBER }] }))).toEqual({
      ok: false,
      code: 'SIGNING_SIGNERS_INVALID',
      details: { reason: 'not_a_member' },
    })
    expect(db.findCall('company_members', 'in')).toEqual(['user_id', [MEMBER]])
    members = [MEMBER]
    expect(await createSigningRequest(ctx, input({ signers: [{ name: 'Erik', userId: MEMBER }, { name: 'Erik igen', userId: MEMBER }] }))).toMatchObject({
      details: { reason: 'duplicate_member' },
    })
    expect(insertedRequests()).toEqual([])
  })

  it('an invalid personnummer, and the same personnummer twice', async () => {
    for (const personalNumber of ['199001011234', '19900101', 'abc']) {
      expect(await createSigningRequest(ctx, input({ signers: [{ name: 'Anna', personalNumber }] })), personalNumber).toEqual({
        ok: false,
        code: 'SIGNING_SIGNERS_INVALID',
        details: { reason: 'personnummer' },
      })
    }
    const twice = await createSigningRequest(ctx, input({ signers: [{ name: 'Anna', personalNumber: PN }, { name: 'Anna igen', personalNumber: '900101-1239' }] }))
    expect(twice).toMatchObject({ details: { reason: 'duplicate_personnummer' } })
    expect(insertedRequests()).toEqual([])
  })

  it('an annual-report request where a signer has no slot, and a plain request where a signer has one', async () => {
    const missing = await createSigningRequest(
      ctx,
      input({ annualReportVersionId: VERSION, signers: [{ name: 'Anna', annualReportSignatureId: 'slot-1' }, { name: 'Erik' }] }),
    )
    expect(missing).toEqual({ ok: false, code: 'SIGNING_SIGNERS_INVALID', details: { reason: 'annual_report_slots' } })
    const stray = await createSigningRequest(ctx, input({ signers: [{ name: 'Anna', annualReportSignatureId: 'slot-1' }] }))
    expect(stray).toEqual({ ok: false, code: 'SIGNING_SIGNERS_INVALID', details: { reason: 'annual_report_slots' } })
    expect(insertedRequests()).toEqual([])
  })
})

describe('createSigningRequest', () => {
  it('stores the request over the document hash, signers with token hashes only, and a private lock row for a typed personnummer', async () => {
    const result = await createSigningRequest(
      ctx,
      input({
        title: '  Hyresavtal 2026  ',
        message: '  Hej, skriv under  ',
        signers: [
          { name: ' Anna Andersson ', email: ' Anna@Example.se ', roleLabel: ' VD ', personalNumber: '19900101-1239' },
          { name: 'Erik Eriksson', email: 'erik@example.se', userId: MEMBER },
          { name: 'Cecilia Carlsson' },
        ],
      }),
    )
    if (!result.ok || result.dryRun) throw new Error(`unexpected ${JSON.stringify(result)}`)
    expect(result.created).toBe(true)

    expect(insertedRequests()).toEqual([
      {
        company_id: COMPANY,
        created_by: SENDER,
        created_via: 'app',
        document_id: DOC,
        document_sha256: sha256Hex(pdf),
        title: 'Hyresavtal 2026',
        message: 'Hej, skriv under',
        annual_report_version_id: null,
        expires_at: new Date(NOW + 14 * DAY).toISOString(),
      },
    ])

    const rows = insertedSigners()
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => [r.position, r.name, r.email, r.role_label, r.user_id, r.lock_kind, r.annual_report_signature_id])).toEqual([
      [1, 'Anna Andersson', 'anna@example.se', 'VD', null, 'personnummer', null],
      [2, 'Erik Eriksson', 'erik@example.se', null, MEMBER, 'member', null],
      [3, 'Cecilia Carlsson', null, null, null, 'none', null],
    ])
    for (const row of rows) {
      expect(row.company_id).toBe(COMPANY)
      expect(row.signing_request_id).toBe(REQ)
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(new Set(rows.map((r) => r.token_hash)).size).toBe(3)

    const [lock, ...more] = insertedPrivates()
    expect(more).toEqual([])
    expect(lock).toMatchObject({ signer_id: 'signer-1', company_id: COMPANY, lock_personnummer_hash: hashPersonalNumber(PN) })
    expect(String(lock!.lock_personnummer_encrypted)).toMatch(/^\\x[0-9a-f]+$/)
    expect(decryptStoredPersonalNumber(String(lock!.lock_personnummer_encrypted))).toBe(PN)
    // The clear number never reaches the request or the signer rows.
    expect(JSON.stringify([insertedRequests(), rows])).not.toContain(PN)
    expect(JSON.stringify([insertedRequests(), rows])).not.toContain('19900101-1239')

    // Every clear token exists only in a URL (a mail, or the answer).
    const urls = [...mail.sendSigningRequestMail.mock.calls.map(([p]) => (p as { url: string }).url), ...result.data.signers.map((s) => s.url).filter((u): u is string => u !== null)]
    expect(urls).toHaveLength(3)
    for (const url of urls) {
      expect(url).toMatch(new RegExp(`^${BASE_URL}/signera/[A-Za-z0-9_-]{43}$`))
      expect(rows.map((r) => r.token_hash)).toContain(hashSigningToken(tokenOf(url)))
      expect(JSON.stringify([insertedRequests(), rows, insertedPrivates()])).not.toContain(tokenOf(url))
    }
    expect(result.data).toMatchObject({ signing_request_id: REQ, status: 'open', title: 'Hyresavtal 2026', document_id: DOC, document_sha256: sha256Hex(pdf) })
  })

  it('mails the signers with an address and answers the url only for the others', async () => {
    const result = await createSigningRequest(
      ctx,
      input({ message: 'Hej', signers: [{ name: 'Anna', email: 'anna@example.se' }, { name: 'Cecilia' }, { name: 'Erik', email: 'erik@example.se' }] }),
    )
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(mail.sendSigningRequestMail).toHaveBeenCalledTimes(2)
    for (const [index, email] of [[0, 'anna@example.se'], [2, 'erik@example.se']] as const) {
      const sent = mail.sendSigningRequestMail.mock.calls.find(([p]) => (p as { email: string }).email === email)![0] as Record<string, unknown>
      expect(sent).toMatchObject({
        companyId: COMPANY,
        companyName: 'Bolaget AB',
        requester: 'Karin Byråsson',
        title: 'Hyresavtal',
        email,
        expiresAt: new Date(NOW + 14 * DAY).toISOString(),
        message: 'Hej',
        // The document card: the pages of the archived PDF and everyone asked to sign.
        pageCount: 1,
        signerCount: 3,
      })
      expect(hashSigningToken(tokenOf(String(sent.url)))).toBe(insertedSigners()[index]!.token_hash)
    }
    expect(result.data.signers.map((s) => [s.signer_id, s.email_sent, s.url === null])).toEqual([
      ['signer-1', true, true],
      ['signer-2', false, false],
      ['signer-3', true, true],
    ])
    expect(hashSigningToken(tokenOf(result.data.signers[1]!.url!))).toBe(insertedSigners()[1]!.token_hash)
    // The mailed signers are stamped; nobody else is.
    expect(db.payloads('signing_request_signers', 'update')).toEqual([{ link_sent_at: new Date(NOW).toISOString() }, { link_sent_at: new Date(NOW).toISOString() }])
    expect(db.findCalls('signing_request_signers', 'eq').filter(([column]) => column === 'id').map(([, id]) => id)).toEqual(['signer-1', 'signer-3'])
  })

  it('answers every url, and mails nobody, when told not to send', async () => {
    const result = await createSigningRequest(ctx, input({ sendEmail: false, signers: [{ name: 'Anna', email: 'anna@example.se' }, { name: 'Erik', email: 'erik@example.se' }] }))
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(mail.sendSigningRequestMail).not.toHaveBeenCalled()
    expect(result.data.signers.every((s) => !s.email_sent && s.url !== null)).toBe(true)
    expect(db.payloads('signing_request_signers', 'update')).toEqual([])
  })

  it('answers the url when the mail did not go out, and leaves link_sent_at unset', async () => {
    mail.sendSigningRequestMail.mockResolvedValue({ emailSent: false })
    const result = await createSigningRequest(ctx, input())
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(result.data.signers[0]).toMatchObject({ email_sent: false, url: expect.stringContaining('/signera/') })
    expect(db.payloads('signing_request_signers', 'update')).toEqual([])
  })

  it('locks a member to their BankID login only when they have one, and copies nothing from it', async () => {
    bankIdUsers = new Set()
    const result = await createSigningRequest(ctx, input({ signers: [{ name: 'Erik', userId: MEMBER }] }))
    expect(result.ok).toBe(true)
    expect(insertedSigners()[0]).toMatchObject({ user_id: MEMBER, lock_kind: 'none' })
    expect(db.payloads('signing_signer_private', 'insert')).toEqual([])
  })

  it('keeps the expiry between one and 90 days', async () => {
    await createSigningRequest(ctx, input({ expiresInDays: 365 }))
    await createSigningRequest(ctx, input({ expiresInDays: 0 }))
    await createSigningRequest(ctx, input({ expiresInDays: 30.7 }))
    expect(insertedRequests().map((r) => r.expires_at)).toEqual([
      new Date(NOW + 90 * DAY).toISOString(),
      new Date(NOW + DAY).toISOString(),
      new Date(NOW + 30 * DAY).toISOString(),
    ])
  })

  it('stops at the signings the month includes before anything is stored or mailed', async () => {
    const refusal = { ok: false, code: 'USAGE_CONSENT_REQUIRED', details: { kind: 'signing', included: 3, unit_price_ore: 1000 }, messageSv: 'x' }
    usageGate.mockResolvedValue(refusal)
    expect(await createSigningRequest(ctx, input())).toBe(refusal)
    expect(usageGate).toHaveBeenCalledWith(mock.supabase, COMPANY, 'signing')
    expect(insertedRequests()).toEqual([])
    expect(mail.sendSigningRequestMail).not.toHaveBeenCalled()
  })

  it('carries the slots of an annual-report request', async () => {
    usageGate.mockResolvedValue({ ok: false, code: 'USAGE_CONSENT_REQUIRED' })
    const result = await createSigningRequest(
      ctx,
      input({ annualReportVersionId: VERSION, signers: [{ name: 'Anna', annualReportSignatureId: 'slot-1' }, { name: 'Erik', annualReportSignatureId: 'slot-2' }] }),
    )
    // An annual report's signing is always included: never asked about.
    expect(usageGate).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(insertedRequests()[0]).toMatchObject({ annual_report_version_id: VERSION })
    expect(insertedSigners().map((r) => r.annual_report_signature_id)).toEqual(['slot-1', 'slot-2'])
  })

  it('takes the request away again, and mails nobody, when the signers are not stored', async () => {
    db.setTable('signing_request_signers', { data: null, error: { message: 'SIGNING_SIGNER_SLOT_MISMATCH' } })
    const result = await createSigningRequest(ctx, input())
    expect(result).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' })
    expect(db.findCalls('signing_requests', 'delete')).toHaveLength(1)
    expect(db.findCall('signing_requests', 'eq')).toEqual(['id', REQ])
    expect(mail.sendSigningRequestMail).not.toHaveBeenCalled()
  })

  it('takes the request away again when the personnummer lock is not stored', async () => {
    db.setTable('signing_signer_private', { data: null, error: { message: 'boom' } })
    const result = await createSigningRequest(ctx, input({ signers: [{ name: 'Anna', personalNumber: PN }] }))
    expect(result).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' })
    expect(db.findCalls('signing_requests', 'delete')).toHaveLength(1)
    expect(mail.sendSigningRequestMail).not.toHaveBeenCalled()
  })
})

describe('describeRequester', () => {
  it('names the byrå team when the sender is a member of the company\'s team', async () => {
    db.setTable('companies', { data: { name: 'Bolaget AB', team_id: 'team-1' } })
    db.setTable('team_members', { data: { team_id: 'team-1', teams: { name: ' Byrån AB ', kind: 'byra' } } })
    expect(await describeRequester(db.supabase as never, COMPANY, SENDER)).toEqual({ companyName: 'Bolaget AB', requester: 'Byrån AB' })
    db.setTable('team_members', { data: { team_id: 'team-1', teams: [{ name: 'Byrån i lista AB', kind: 'byra' }] } })
    expect(await describeRequester(db.supabase as never, COMPANY, SENDER)).toEqual({ companyName: 'Bolaget AB', requester: 'Byrån i lista AB' })
  })

  it('names the sender, not their personal team, when the company sits in the sender\'s personal team', async () => {
    db.setTable('companies', { data: { name: 'Bolaget AB', team_id: 'team-1' } })
    db.setTable('team_members', { data: { team_id: 'team-1', teams: { name: 'Personal', kind: 'personal' } } })
    expect(await describeRequester(db.supabase as never, COMPANY, SENDER)).toEqual({ companyName: 'Bolaget AB', requester: 'Karin Byråsson' })
  })

  it('names the sender, else the company, else says Företaget', async () => {
    expect(await describeRequester(db.supabase as never, COMPANY, SENDER)).toEqual({ companyName: 'Bolaget AB', requester: 'Karin Byråsson' })
    db.setTable('profiles', { data: { full_name: '  ' } })
    expect(await describeRequester(db.supabase as never, COMPANY, SENDER)).toEqual({ companyName: 'Bolaget AB', requester: 'Bolaget AB' })
    db.setTable('companies', { data: null })
    expect(await describeRequester(db.supabase as never, COMPANY, SENDER)).toEqual({ companyName: 'Företaget', requester: 'Företaget' })
  })
})

describe('cancelSigningRequest', () => {
  let request: SigningRequestRow | null
  let updated: Array<{ id: string }>
  let sessions: Array<{ id: string; bankid_session_id: string }>

  beforeEach(() => {
    request = requestRow()
    updated = [{ id: REQ }]
    sessions = [{ id: SIGNER, bankid_session_id: 'sess-1' }]
    db.setTable('signing_requests', (calls) => (calls.some((c) => c.method === 'update') ? { data: updated } : { data: request }))
    db.setTable('signing_request_signers', (calls) => (calls.some((c) => c.method === 'not') ? { data: sessions } : { data: null }))
  })

  const requestUpdates = () => db.payloads('signing_requests', 'update')

  it('answers SIGNING_REQUEST_NOT_FOUND for a request that is not the company\'s', async () => {
    request = null
    expect(await cancelSigningRequest(ctx, { signingRequestId: REQ })).toEqual({ ok: false, code: 'SIGNING_REQUEST_NOT_FOUND' })
    expect(db.findCall('signing_requests', 'eq')).toEqual(['company_id', COMPANY])
  })

  it('lets only the sender, an owner or an admin cancel', async () => {
    ctx = { ...ctx, userId: MEMBER }
    for (const r of ['member', 'viewer']) {
      role = r
      expect(await cancelSigningRequest(ctx, { signingRequestId: REQ }), r).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    }
    expect(requestUpdates()).toEqual([])
    for (const r of ['owner', 'admin']) {
      role = r
      expect(await cancelSigningRequest(ctx, { signingRequestId: REQ }), r).toEqual({ ok: true, data: { signing_request_id: REQ, cancelled: true } })
    }
  })

  it('lets the sender cancel whatever their role', async () => {
    role = 'member'
    expect(await cancelSigningRequest(ctx, { signingRequestId: REQ })).toEqual({ ok: true, data: { signing_request_id: REQ, cancelled: true } })
  })

  it('answers the same for a request already cancelled, without writing', async () => {
    request = requestRow({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    expect(await cancelSigningRequest(ctx, { signingRequestId: REQ })).toEqual({ ok: true, data: { signing_request_id: REQ, cancelled: true } })
    expect(requestUpdates()).toEqual([])
  })

  it('refuses a completed or declined request, and one another call closed first', async () => {
    request = requestRow({ status: 'completed', completed_at: new Date().toISOString() })
    expect(await cancelSigningRequest(ctx, { signingRequestId: REQ })).toEqual({ ok: false, code: 'SIGNING_REQUEST_CLOSED' })
    request = requestRow({ status: 'declined', declined_at: new Date().toISOString() })
    expect(await cancelSigningRequest(ctx, { signingRequestId: REQ })).toEqual({ ok: false, code: 'SIGNING_REQUEST_CLOSED' })
    expect(requestUpdates()).toEqual([])
    request = requestRow()
    updated = []
    expect(await cancelSigningRequest(ctx, { signingRequestId: REQ })).toEqual({ ok: false, code: 'SIGNING_REQUEST_CLOSED' })
    expect(services.cancelBankIdSignature).not.toHaveBeenCalled()
  })

  it('closes an open request and stops the BankID signings in progress', async () => {
    const now = Date.parse('2026-10-25T12:00:00.000Z')
    services.cancelBankIdSignature.mockRejectedValue(new Error('TIC down'))
    expect(await cancelSigningRequest(ctx, { signingRequestId: REQ, now })).toEqual({ ok: true, data: { signing_request_id: REQ, cancelled: true } })
    expect(requestUpdates()).toEqual([{ status: 'cancelled', cancelled_at: new Date(now).toISOString() }])
    expect(db.findCalls('signing_requests', 'eq')).toEqual(expect.arrayContaining([['status', 'open']]))
    expect(services.cancelBankIdSignature).toHaveBeenCalledWith('sess-1')
    expect(db.payloads('signing_request_signers', 'update')).toEqual([{ bankid_session_id: null, poll_lease_until: null }])
  })
})

describe('remindSigner', () => {
  let request: SigningRequestRow | null
  let signer: SigningSignerRow | null
  let rotated: Array<{ id: string }>

  beforeEach(() => {
    request = requestRow({ message: 'Hej' })
    signer = signerRow({ link_sent_at: new Date(NOW - 2 * DAY).toISOString() })
    rotated = [{ id: SIGNER }]
    db.setTable('signing_requests', () => ({ data: request }))
    db.setTable('signing_request_signers', (calls) => (calls.some((c) => c.method === 'update') ? { data: rotated } : { data: signer }))
  })

  const remind = () => remindSigner(ctx, { signingRequestId: REQ, signerId: SIGNER, now: NOW })
  const updates = () => db.payloads('signing_request_signers', 'update') as Array<Record<string, unknown>>

  it('lets only the sender, an owner or an admin remind', async () => {
    ctx = { ...ctx, userId: MEMBER }
    role = 'member'
    expect(await remind()).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    role = 'admin'
    expect((await remind()).ok).toBe(true)
  })

  it('refuses a request that is not open, an unknown signer, and one who signed or declined', async () => {
    request = null
    expect(await remind()).toEqual({ ok: false, code: 'SIGNING_REQUEST_NOT_FOUND' })
    request = requestRow({ expires_at: new Date(NOW - 1).toISOString() })
    expect(await remind()).toEqual({ ok: false, code: 'SIGNING_REQUEST_CLOSED' })
    request = requestRow({ status: 'cancelled', cancelled_at: new Date(NOW).toISOString() })
    expect(await remind()).toEqual({ ok: false, code: 'SIGNING_REQUEST_CLOSED' })
    request = requestRow()
    signer = null
    expect(await remind()).toEqual({ ok: false, code: 'SIGNING_SIGNER_NOT_FOUND' })
    signer = signerRow({ status: 'signed', signed_at: new Date(NOW).toISOString() })
    expect(await remind()).toEqual({ ok: false, code: 'SIGNING_SIGNER_NOT_PENDING' })
    signer = signerRow({ status: 'declined', declined_at: new Date(NOW).toISOString() })
    expect(await remind()).toEqual({ ok: false, code: 'SIGNING_SIGNER_NOT_PENDING' })
    expect(updates()).toEqual([])
    expect(mail.sendSigningRequestMail).not.toHaveBeenCalled()
  })

  it('gives a signer without an address a new link to hand over, mailing nothing and ignoring the mail interval', async () => {
    signer = signerRow({ email: null, link_sent_at: null, last_reminded_at: new Date(NOW - HOUR).toISOString() })
    const outcome = await remind()
    expect(outcome).toMatchObject({ ok: true, data: { email_sent: false, url: expect.stringMatching(/\/signera\/[A-Za-z0-9_-]{43}$/) } })
    expect(updates()).toHaveLength(1)
  })

  it('reminds at most once per 24 hours after the last mail, the first or a reminder', async () => {
    signer = signerRow({ link_sent_at: new Date(NOW - 23 * HOUR).toISOString() })
    expect(await remind()).toEqual({ ok: false, code: 'SIGNING_REMIND_TOO_SOON' })
    signer = signerRow({ link_sent_at: new Date(NOW - 3 * DAY).toISOString(), last_reminded_at: new Date(NOW - HOUR).toISOString() })
    expect(await remind()).toEqual({ ok: false, code: 'SIGNING_REMIND_TOO_SOON' })
    expect(updates()).toEqual([])
    signer = signerRow({ link_sent_at: new Date(NOW - 3 * DAY).toISOString(), last_reminded_at: new Date(NOW - 25 * HOUR).toISOString() })
    expect((await remind()).ok).toBe(true)
    signer = signerRow({ link_sent_at: null, last_reminded_at: null })
    expect((await remind()).ok).toBe(true)
  })

  it('refuses while the signer may be in a BankID signing right now', async () => {
    signer = signerRow({ link_sent_at: null, bankid_session_id: 'sess-1', bankid_session_started_at: new Date(NOW - 2 * MINUTE).toISOString() })
    expect(await remind()).toEqual({ ok: false, code: 'SIGNING_SESSION_ACTIVE' })
    expect(updates()).toEqual([])
    signer = signerRow({ link_sent_at: null, bankid_session_id: 'sess-1', bankid_session_started_at: new Date(NOW - 10 * MINUTE).toISOString() })
    expect((await remind()).ok).toBe(true)
  })

  it('rotates the link: a new token hash, the session dropped, and the mail carries the new link', async () => {
    const counted = (calls: Array<{ method: string; args: unknown[] }>) => calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head)
    db.setTable('signing_request_signers', (calls) => (calls.some((c) => c.method === 'update') ? { data: rotated } : counted(calls) ? { data: null, count: 2 } : { data: signer }))
    const result = await remind()
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(result.data).toEqual({ signing_request_id: REQ, signer_id: SIGNER, email_sent: true, url: null })
    const [update] = updates()
    expect(update).toEqual({ token_hash: expect.stringMatching(/^[0-9a-f]{64}$/), last_reminded_at: new Date(NOW).toISOString(), bankid_session_id: null, poll_lease_until: null })
    expect(db.findCalls('signing_request_signers', 'eq')).toEqual(expect.arrayContaining([['status', 'pending']]))
    const sent = mail.sendSigningRequestMail.mock.calls[0]![0] as Record<string, unknown>
    expect(sent).toMatchObject({ email: 'anna@example.se', reminder: true, title: 'Hyresavtal', message: 'Hej', requester: 'Karin Byråsson', expiresAt: request!.expires_at, signerCount: 2 })
    expect(hashSigningToken(tokenOf(String(sent.url)))).toBe(update!.token_hash)
    expect(JSON.stringify(update)).not.toContain(tokenOf(String(sent.url)))
  })

  it('answers the new link when the mail did not go out', async () => {
    mail.sendSigningRequestMail.mockResolvedValue({ emailSent: false })
    const result = await remind()
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(result.data.email_sent).toBe(false)
    expect(hashSigningToken(tokenOf(result.data.url!))).toBe(updates()[0]!.token_hash)
  })

  it('mails nothing when the signer stopped being pending before the rotation', async () => {
    rotated = []
    expect(await remind()).toEqual({ ok: false, code: 'SIGNING_SIGNER_NOT_PENDING' })
    expect(mail.sendSigningRequestMail).not.toHaveBeenCalled()
  })
})
