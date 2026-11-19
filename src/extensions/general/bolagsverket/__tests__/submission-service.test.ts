import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase, createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/bokslut/ixbrl/build-input', () => ({
  buildIxbrlInput: vi.fn(async () => ({
    entryPointId: 'k2-ab-risbs-2024-09-12',
    period: { start: '2025-01-01', end: '2025-12-31' },
  })),
}))
vi.mock('@/lib/bokslut/ixbrl/document/generate', () => ({
  generateIxbrlDocument: vi.fn(() => ({ xhtml: '<?xml version="1.0"?><html></html>' })),
  embedKontrollsumma: vi.fn(
    (xhtml: string, checksum: string) => `${xhtml}<!-- checksum:${checksum} -->`,
  ),
}))
vi.mock('@/lib/bokslut/ixbrl/validate/rules', () => ({
  runPreflightChecks: vi.fn(() => ({ ok: true, issues: [] })),
}))
vi.mock('@/lib/bokslut/ixbrl/validate/arelle-client', () => ({
  validateIxbrlWithArelle: vi.fn(async () => ({
    status: 'passed',
    validator_version: 'test',
    issues: [],
  })),
}))
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: vi.fn(async () => ({ id: 'doc-1' })),
}))
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => {
    throw new Error('service client not expected in these tests')
  }),
}))

import { uploadDocument } from '@/lib/core/documents/document-service'
import { validateIxbrlWithArelle } from '@/lib/bokslut/ixbrl/validate/arelle-client'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runPreflightChecks } from '@/lib/bokslut/ixbrl/validate/rules'
import {
  applyHandelse,
  arsredovisningHandlingTyp,
  inspectRevisionsberattelse,
  submitRevisionsberattelse,
  BolagsverketSubmissionError,
  ensureSubscription,
  handleWebhook,
  hashPnr,
  getOrgnr,
  submitArsredovisning,
} from '../lib/submission-service'
import type { HandelseMeddelande } from '../types'
import { makeInput, makeK3Input } from '@/lib/bokslut/ixbrl/__tests__/fixtures'

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/**
 * Recording mock: chainable builder consuming queued results per terminal
 * (single/maybeSingle/await), capturing update payloads per table so tests
 * can assert what was written.
 */
function makeRecordingSupabase(results: Array<{ data?: unknown; error?: unknown }>) {
  let idx = 0
  const updates: Array<{ table: string; payload: Record<string, unknown> }> = []
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = []
  const next = () => results[idx++] ?? { data: null, error: null }
  const makeBuilder = (table: string) => {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'order', 'limit']) {
      b[m] = () => b
    }
    b.insert = (payload: Record<string, unknown>) => {
      inserts.push({ table, payload })
      return b
    }
    b.update = (payload: Record<string, unknown>) => {
      updates.push({ table, payload })
      return b
    }
    b.single = async () => next()
    b.maybeSingle = async () => next()
    b.then = (resolve: (v: unknown) => void) => resolve(next())
    return b
  }
  return { supabase: { from: (table: string) => makeBuilder(table) } as never, updates, inserts }
}

function makeClientMock(overrides: Record<string, unknown> = {}) {
  return {
    environment: 'test',
    createInlamningToken: vi.fn(async () => ({
      token: 'tok-1',
      avtalstext: 'Avtalstext',
      avtalstextAndrad: '2017-12-06',
    })),
    createChecksumToken: vi.fn(async () => ({ token: 'tok-2', avtalstext: '', avtalstextAndrad: '' })),
    createChecksum: vi.fn(async () => ({ kontrollsumma: 'ksum', algoritm: 'SHA-256' })),
    kontrollera: vi.fn(async () => ({ orgnr: '5560001111', utfall: [] })),
    lamnaIn: vi.fn(async () => ({
      orgnr: '5560001111',
      avsandare: 'avs',
      undertecknare: 'und',
      handlingsinfo: {
        typ: 'arsredovisning_komplett',
        dokumentlangd: 1,
        idnummer: '49679',
        sha256checksumma: 'sha256',
      },
      url: 'https://ext.bolagsverket.se/eu/49679',
    })),
    ...overrides,
  } as never
}

const submitParams = {
  companyId: 'company-1',
  userId: 'user-1',
  fiscalPeriodId: 'period-1',
  annualReportVersionId: 'version-1',
  avsandarePnr: '198001019879',
  undertecknare: {
    pnr: '198001019879',
    fornamn: 'Karl',
    efternamn: 'Karlsson',
    roll: 'Styrelseledamot',
    epost: 'anna@example.com',
  },
}

const eligibleValidation = {
  digital_filing_eligible: true,
  digital_issues: [],
}

function message(overrides: Partial<HandelseMeddelande> = {}): HandelseMeddelande {
  return {
    typ: 'AR-v2',
    id: '5560001111',
    nr: 3,
    tid: '2026-06-01T10:00:00.000+02:00',
    data: {
      version: '2.0',
      handlingsinfo: [{ handling: 'arsredovisning', idnummer: '49679' }],
      status: 'arsred_inkommen',
    },
    ...overrides,
  }
}

describe('ensureSubscription', () => {
  const HOOK = 'https://app.test/api/extensions/ext/bolagsverket/webhook'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  /**
   * auth_secret is withheld from end-user roles and the table is written by
   * the server only (20260929173432): a session client that is touched at
   * all fails the test.
   */
  function sessionThatMustNotBeUsed() {
    return {
      from: vi.fn(() => {
        throw new Error('the session client must not touch bolagsverket_subscriptions')
      }),
    }
  }

  function serviceReturning(...results: Array<{ data?: unknown; error?: unknown }>) {
    const service = createQueuedMockSupabase()
    for (const result of results) service.enqueue(result)
    vi.mocked(createServiceClientNoCookies).mockReturnValueOnce(service.supabase as never)
    return service
  }

  it('registers a new subscription on the service role, never the session client', async () => {
    const service = serviceReturning(
      { data: null }, // no subscription for this company
      { data: null }, // no other company shares the orgnr
      { data: null }, // insert
    )
    const session = sessionThatMustNotBeUsed()
    const createSubscription = vi.fn(async (_url: string, _orgnr: string, _secret: string) => undefined)
    const client = makeClientMock({ createSubscription })

    await ensureSubscription(
      { supabase: session as never, client: client as never, appUrl: 'https://app.test', log: makeLog() },
      'company-1',
      'user-1',
      '5560001111',
    )

    expect(session.from).not.toHaveBeenCalled()
    expect(service.findCall('bolagsverket_subscriptions', 'select')).toEqual(['id, auth_secret'])
    expect(service.findCalls('bolagsverket_subscriptions', 'eq')[0]).toEqual(['company_id', 'company-1'])
    const inserted = service.findCall('bolagsverket_subscriptions', 'insert')![0] as {
      company_id: string
      user_id: string
      auth_secret: string
    }
    expect(inserted).toMatchObject({ company_id: 'company-1', user_id: 'user-1', orgnr: '5560001111', url: HOOK })
    expect(createSubscription).toHaveBeenCalledWith(HOOK, '5560001111', inserted.auth_secret)
  })

  it("renews this company's subscription with its stored secret, scoped to the company", async () => {
    const service = serviceReturning(
      { data: { id: 'sub-1', auth_secret: 'stored-secret' } },
      { data: null }, // renewal update
    )
    const session = sessionThatMustNotBeUsed()
    const createSubscription = vi.fn(async (_url: string, _orgnr: string, _secret: string) => undefined)
    const client = makeClientMock({ createSubscription })

    await ensureSubscription(
      { supabase: session as never, client: client as never, appUrl: 'https://app.test', log: makeLog() },
      'company-1',
      'user-1',
      '5560001111',
    )

    expect(session.from).not.toHaveBeenCalled()
    expect(createSubscription).toHaveBeenCalledWith(HOOK, '5560001111', 'stored-secret')
    expect(service.findCall('bolagsverket_subscriptions', 'insert')).toBeUndefined()
    const eqs = service.findCalls('bolagsverket_subscriptions', 'eq')
    expect(eqs).toContainEqual(['id', 'sub-1'])
    expect(eqs.filter(([column]) => column === 'company_id')).toHaveLength(2) // lookup + renewal
  })
})

describe('getOrgnr / hashPnr', () => {
  it('gives the 10-digit API form whichever written form is stored, and refuses none', async () => {
    const stored = (org_number: string | null) => createTableMockSupabase({
      company_settings: { data: { org_number }, error: null },
      companies: { data: { org_number: null }, error: null },
    }).supabase as never
    expect(await getOrgnr(stored('556677-8899'), 'c')).toBe('5566778899')
    expect(await getOrgnr(stored('165566778899'), 'c')).toBe('5566778899')
    await expect(getOrgnr(stored(`83${'5566778899'}`), 'c')).rejects.toThrow(/saknas/)
  })

  it('hashes personnummer with company salt: never the raw value', () => {
    const hash = hashPnr('company-1', '19830101-9876', 'test-secret')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain('9876')
    expect(hashPnr('company-2', '198301019876', 'test-secret')).not.toBe(hash)
    // Same pnr + company → stable.
    expect(hashPnr('company-1', '198301019876', 'test-secret')).toBe(hash)
  })
})

describe('handleWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('rejects messages without a matching auth header (401)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ company_id: 'company-1', auth_secret: 'right-secret' }], error: null })

    const result = await handleWebhook(supabase as never, message(), 'wrong-secret')
    expect(result.status).toBe(401)
  })

  it('rejects messages for unknown orgnr (401)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [], error: null })

    const result = await handleWebhook(supabase as never, message(), 'any')
    expect(result.status).toBe(401)
  })

  it('acks the subscription test message without touching submissions', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ company_id: 'company-1', auth_secret: 's3cret' }], error: null })

    const result = await handleWebhook(
      supabase as never,
      message({ nr: -1, data: { version: '2.0', status: 'test' } }),
      's3cret',
    )
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
  })

  it('applies a real status event to the matching submission and emits events', async () => {
    const emitted: string[] = []
    eventBus.on('arsredovisning.status_changed', (payload) => {
      emitted.push(`changed:${payload.status}`)
    })
    eventBus.on('arsredovisning.registered', () => {
      emitted.push('registered')
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    // 1) subscription lookup
    enqueue({ data: [{ company_id: 'company-1', auth_secret: 's3cret' }], error: null })
    // 2) submission lookup by idnummer
    enqueue({
      data: [
        {
          id: 'sub-1',
          status: 'uploaded',
          fiscal_period_id: 'period-1',
          user_id: 'user-1',
          company_id: 'company-1',
        },
      ],
      error: null,
    })
    // 3) update
    enqueue({ data: null, error: null })

    const result = await handleWebhook(
      supabase as never,
      message({ data: { version: '2.0', handlingsinfo: [{ handling: 'arsredovisning', idnummer: '49679' }], status: 'arsred_registrerad' } }),
      's3cret',
    )
    expect(result.status).toBe(200)
    expect(emitted).toContain('changed:registrerad')
    expect(emitted).toContain('registered')
  })

  it('rejects malformed payloads (400)', async () => {
    const { supabase } = createQueuedMockSupabase()
    const result = await handleWebhook(
      supabase as never,
      {} as never,
      's3cret',
    )
    expect(result.status).toBe(400)
  })
})

describe('applyHandelse', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('emits forelagd event on föreläggande and skips unknown statuses', async () => {
    const emitted: string[] = []
    eventBus.on('arsredovisning.forelagd', () => {
      emitted.push('forelagd')
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        {
          id: 'sub-1',
          status: 'inkommen',
          fiscal_period_id: 'period-1',
          user_id: 'user-1',
          company_id: 'company-1',
        },
      ],
      error: null,
    })
    enqueue({ data: null, error: null })

    await applyHandelse(
      supabase as never,
      message({ data: { version: '2.0', handlingsinfo: [{ handling: 'arsredovisning', idnummer: '49679' }], status: 'arsred_forelaggande_skickat' } }),
      ['company-1'],
    )
    expect(emitted).toEqual(['forelagd'])

    // Unknown status: nothing should be queried or emitted.
    await applyHandelse(
      supabase as never,
      message({ data: { version: '2.0', status: 'test' } }),
      ['company-1'],
    )
    expect(emitted).toEqual(['forelagd'])
  })

  it('does not emit when the stored status already matches', async () => {
    const emitted: string[] = []
    eventBus.on('arsredovisning.status_changed', () => {
      emitted.push('changed')
    })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        {
          id: 'sub-1',
          status: 'inkommen',
          fiscal_period_id: 'period-1',
          user_id: 'user-1',
          company_id: 'company-1',
        },
      ],
      error: null,
    })

    await applyHandelse(supabase as never, message(), ['company-1'])
    expect(emitted).toEqual([])
  })

  it('logs rejected transitions instead of silently continuing', async () => {
    const emitted: string[] = []
    eventBus.on('arsredovisning.status_changed', () => {
      emitted.push('changed')
    })
    const log = makeLog()
    const { supabase, enqueue } = createQueuedMockSupabase()
    // Stored status differs from the incoming one, but the DB trigger
    // rejects the transition.
    enqueue({
      data: [
        {
          id: 'sub-1',
          status: 'registrerad',
          fiscal_period_id: 'period-1',
          user_id: 'user-1',
          company_id: 'company-1',
        },
      ],
      error: null,
    })
    enqueue({ data: null, error: { message: 'Ogiltig statusövergång: registrerad → inkommen' } })

    await applyHandelse(supabase as never, message(), ['company-1'], log)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0][0]).toMatch(/rejected/)
    expect(emitted).toEqual([])
  })
})

describe('submitArsredovisning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    vi.mocked(uploadDocument).mockResolvedValue({ id: 'doc-1' } as never)
  })

  it('refuses when an active submission already exists for the fiscal period', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { org_number: '556000-1111' }, error: null }) // company_settings
    enqueue({
      data: {
        id: 'version-1',
        status: 'signed',
        ixbrl_data: makeInput(),
        validation_summary: eligibleValidation,
      },
      error: null,
    })
    enqueue({ data: [{ id: 'sub-0', status: 'uploaded' }], error: null }) // active submissions

    await expect(
      submitArsredovisning(
        { supabase: supabase as never, client: makeClientMock(), appUrl: 'https://app.test', log: makeLog() },
        submitParams,
      ),
    ).rejects.toMatchObject({
      name: 'BolagsverketSubmissionError',
      code: 'BOLAGSVERKET_SUBMISSION_EXISTS',
    })
  })

  it('blocks a signed version that is not eligible for connected filing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { org_number: '556000-1111' }, error: null })
    enqueue({
      data: {
        id: 'version-1',
        status: 'signed',
        ixbrl_data: makeInput(),
        validation_summary: {
          digital_filing_eligible: false,
          digital_issues: [{ code: 'AR-DIGITAL-AUDIT' }],
        },
      },
      error: null,
    })

    await expect(
      submitArsredovisning(
        {
          supabase: supabase as never,
          client: makeClientMock(),
          appUrl: 'https://app.test',
          log: makeLog(),
        },
        submitParams,
      ),
    ).rejects.toMatchObject({ code: 'BOLAGSVERKET_DIGITAL_INELIGIBLE' })
  })

  it('does not file a K3 version once the K3 flag is off, even one locked while it was on', async () => {
    vi.stubEnv('NEXT_PUBLIC_K3_IXBRL_ENABLED', '')
    try {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: { org_number: '556000-1111' }, error: null })
      enqueue({
        data: {
          id: 'version-k3',
          status: 'signed',
          ixbrl_data: makeK3Input(),
          entry_point: 'k3-ab-risbs-2021-10-31',
          taxonomy_version: '2021-10-31',
          validation_summary: eligibleValidation,
        },
        error: null,
      })
      await expect(
        submitArsredovisning(
          { supabase: supabase as never, client: makeClientMock(), appUrl: 'https://app.test', log: makeLog() },
          submitParams,
        ),
      ).rejects.toMatchObject({ code: 'BOLAGSVERKET_K3_FILING_CLOSED', details: { annual_report_version_id: 'version-k3' } })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('requires the certificate signer to match the immutable version', async () => {
    const { supabase } = makeRecordingSupabase([
      { data: { org_number: '5560001111' } },
      {
        data: {
          id: 'version-1',
          status: 'signed',
          ixbrl_data: makeInput(),
          taxonomy_version: '2024-09-12',
          validation_summary: eligibleValidation,
        },
      },
      { data: [] },
      { data: { id: 'acc-1' } },
      {
        data: [
          {
            signer_name: 'Anna Svensson',
            role: 'VD',
            signed_at: '2026-03-01T10:00:00Z',
            status: 'signed',
            signing_method: 'paper_original',
            evidence_reference: 'Arkiv A-1',
          },
        ],
      },
    ])

    await expect(
      submitArsredovisning(
        {
          supabase,
          client: makeClientMock(),
          appUrl: 'https://app.test',
          log: makeLog(),
        },
        {
          ...submitParams,
          undertecknare: { ...submitParams.undertecknare, fornamn: 'Någon annan' },
        },
      ),
    ).rejects.toMatchObject({
      code: 'BOLAGSVERKET_CERTIFICATE_SIGNER_MISMATCH',
    })
  })

  it('marks the submission as unknown and blocks an automatic retry when upload is uncertain', async () => {
    const { supabase, updates } = makeRecordingSupabase([
      { data: { org_number: '5560001111' } }, // getOrgnr
      {
        data: {
          id: 'version-1',
          status: 'signed',
          ixbrl_data: makeInput(),
          taxonomy_version: '2024-09-12',
          validation_summary: eligibleValidation,
        },
      },
      { data: [] },                            // no active submission
      { data: { id: 'acc-1' } },               // avtal acceptance exists
      { data: [{ signer_name: 'Anna Svensson', role: 'VD', signed_at: '2026-03-01T10:00:00Z', status: 'signed', signing_method: 'paper_original', evidence_reference: 'Arkiv A-1' }] },
      { data: null },                          // no AGM recorded after the lock
      { data: null },                          // no profile: no revisorspåteckning
      {},                                      // local validation run
      {},                                      // Arelle validation run
      { data: null },                          // no exact request
      { data: { id: 'sub-1' } },               // insert submission row
      {},                                      // update → kontrollerad
      {},                                      // archive link update
      {},                                      // update → sending
      {},                                      // update → unknown
    ])
    const client = makeClientMock({
      lamnaIn: vi.fn(async () => {
        throw new Error('inlamning exploded')
      }),
    })
    const log = makeLog()

    const result = await submitArsredovisning(
      { supabase, client, appUrl: 'https://app.test', log },
      submitParams,
    )

    expect(result.outcome).toBe('state_unknown')
    const unknownUpdate = updates.find((u) => u.payload.status === 'unknown')
    expect(unknownUpdate).toBeDefined()
    expect(unknownUpdate!.payload.error_message).toContain('inlamning exploded')
  })

  it('blocks filing when the exact uploaded bytes cannot be archived first', async () => {
    vi.mocked(uploadDocument).mockRejectedValueOnce(new Error('magic bytes rejected'))
    const { supabase, updates } = makeRecordingSupabase([
      { data: { org_number: '5560001111' } }, // getOrgnr
      {
        data: {
          id: 'version-1',
          status: 'signed',
          ixbrl_data: makeInput(),
          taxonomy_version: '2024-09-12',
          validation_summary: eligibleValidation,
        },
      },
      { data: [] },                            // no active submission
      { data: { id: 'acc-1' } },               // avtal acceptance exists
      { data: [{ signer_name: 'Anna Svensson', role: 'VD', signed_at: '2026-03-01T10:00:00Z', status: 'signed', signing_method: 'paper_original', evidence_reference: 'Arkiv A-1' }] },
      { data: null },                          // no AGM recorded after the lock
      { data: null },                          // no profile: no revisorspåteckning
      {},                                      // local validation run
      {},                                      // Arelle validation run
      { data: null },                          // no exact request
      { data: { id: 'sub-1' } },               // insert submission row
      {},                                      // update → kontrollerad
      {},                                      // archive failure update
      {},                                      // mark submission error
    ])
    const log = makeLog()

    await expect(
      submitArsredovisning(
        { supabase, client: makeClientMock(), appUrl: 'https://app.test', log },
        submitParams,
      ),
    ).rejects.toThrow('Dokumentarkivering misslyckades')

    // The failure is logged AND visible on the row.
    const docFailureUpdate = updates.find(
      (u) => typeof u.payload.error_message === 'string' && !u.payload.status,
    )
    expect(docFailureUpdate).toBeDefined()
    expect(docFailureUpdate!.payload.error_message).toContain('magic bytes rejected')

    expect(updates.some((update) => update.payload.status === 'sending')).toBe(false)
  })

  it('reuses a stopped kontrollera row when the user explicitly accepts warnings', async () => {
    const { supabase, updates } = makeRecordingSupabase([
      { data: { org_number: '5560001111' } },
      {
        data: {
          id: 'version-1',
          status: 'signed',
          ixbrl_data: makeInput(),
          taxonomy_version: '2024-09-12',
          validation_summary: eligibleValidation,
        },
      },
      { data: [] },
      { data: { id: 'acc-1' } },
      {
        data: [
          {
            signer_name: 'Anna Svensson',
            role: 'VD',
            signed_at: '2026-03-01T10:00:00Z',
            status: 'signed',
            signing_method: 'paper_original',
            evidence_reference: 'Arkiv A-1',
          },
        ],
      },
      { data: null }, // no AGM recorded after the lock
      { data: null }, // no profile: no revisorspåteckning
      {},
      {},
      { data: { id: 'sub-1', status: 'kontrollerad' } },
      { data: { id: 'sub-1' } },
      {},
      {},
      {},
      {},
      {},
    ])

    const result = await submitArsredovisning(
      { supabase, client: makeClientMock(), appUrl: '', log: makeLog() },
      { ...submitParams, ignoreWarnings: true },
    )

    expect(result.outcome).toBe('uploaded')
    expect(updates.some((update) => update.payload.status === 'draft')).toBe(true)
    expect(updates.some((update) => update.payload.status === 'uploaded')).toBe(true)
    expect(validateIxbrlWithArelle).toHaveBeenCalledWith(
      expect.stringContaining('checksum:ksum'),
    )
    const archivedFile = vi.mocked(uploadDocument).mock.calls[0][3]
    expect(Buffer.from(archivedFile.buffer).toString('utf8')).toContain('checksum:ksum')
  })

  it('exports BolagsverketSubmissionError with a stable code', () => {
    const err = new BolagsverketSubmissionError('BOLAGSVERKET_SUBMISSION_EXISTS', 'exists', {
      submission_id: 'sub-1',
    })
    expect(err.code).toBe('BOLAGSVERKET_SUBMISSION_EXISTS')
    expect(err.details).toEqual({ submission_id: 'sub-1' })
  })
})

describe('the revisor package: kompletteras and the separate revisionsberättelse (API 2.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    vi.mocked(uploadDocument).mockResolvedValue({ id: 'doc-1' } as never)
  })

  const pateckning = {
    required: true,
    revisionsbolag: null,
    opinion: 'unmodified' as const,
    revisorer: [],
  }

  it('picks the handling type from the påteckning', () => {
    expect(arsredovisningHandlingTyp({})).toBe('arsredovisning_komplett')
    expect(arsredovisningHandlingTyp({ revisorspateckning: null })).toBe('arsredovisning_komplett')
    expect(arsredovisningHandlingTyp({ revisorspateckning: pateckning })).toBe('arsredovisning_kompletteras')
    expect(
      arsredovisningHandlingTyp({
        revisorspateckning: {
          ...pateckning,
          required: false,
          revisorer: [{ firstName: 'Rita', lastName: 'Revisor', titel: 'Godkänd revisor', huvudansvarig: null, signedDate: null }],
        },
      }),
    ).toBe('arsredovisning_kompletteras')
  })

  it('uploads an audited årsredovisning as kompletteras and tells the revisor', async () => {
    const { supabase, updates } = makeRecordingSupabase([
      { data: { org_number: '5560001111' } },
      {
        data: {
          id: 'version-1',
          status: 'signed',
          ixbrl_data: makeInput(),
          taxonomy_version: '2024-09-12',
          validation_summary: eligibleValidation,
        },
      },
      { data: [] }, // no active årsredovisning
      { data: { id: 'acc-1' } },
      {
        data: [
          { signer_name: 'Karl Karlsson', role: 'Styrelseledamot', signed_at: '2026-02-20T10:00:00Z', status: 'signed', signing_method: 'bankid', evidence_reference: 'receipt:signing/r/s' },
          { signer_name: 'Rita Revisor', role: 'Auktoriserad revisor', signed_at: '2026-02-21T10:00:00Z', status: 'signed', signing_method: 'paper_original', evidence_reference: 'archive:RB-1', pateckning_opinion: 'unmodified', pateckning_firm_name: null },
        ],
      },
      { data: null }, // no AGM recorded after the lock
      // Edited after the påteckning: the filing carries what the revisor's slot froze.
      { data: { auditor_report_required: true, auditor_firm_name: 'Annan byrå AB', auditor_opinion: 'modified' } },
      {}, // local validation run
      {}, // Arelle validation run
      { data: null }, // no exact request
      { data: { id: 'sub-1' } },
      {}, // kontrollerad
      {}, // archive link
      {}, // sending
      {}, // uploaded
      {}, // version filed
    ])
    const client = makeClientMock()
    const result = await submitArsredovisning(
      { supabase, client, appUrl: 'https://app.test', log: makeLog() },
      { ...submitParams, notifieringEpost: ['rita@revisor.se'] },
    )

    expect(result).toMatchObject({ outcome: 'uploaded', handlingTyp: 'arsredovisning_kompletteras' })
    const checked = vi.mocked(runPreflightChecks).mock.calls[0][0]
    expect(checked.underskrifter.signers.map((signer) => signer.lastName)).toEqual(['Karlsson'])
    expect(checked.revisorspateckning).toMatchObject({
      required: true,
      opinion: 'unmodified',
      revisionsbolag: null,
      revisorer: [{ firstName: 'Rita', lastName: 'Revisor', titel: 'Auktoriserad revisor', signedDate: '2026-02-21' }],
    })
    const kontrollera = (client as unknown as { kontrollera: ReturnType<typeof vi.fn> }).kontrollera
    expect(kontrollera.mock.calls[0][2]).toBe('arsredovisning_kompletteras')
    const lamnaIn = (client as unknown as { lamnaIn: ReturnType<typeof vi.fn> }).lamnaIn
    expect(lamnaIn.mock.calls[0][1]).toMatchObject({
      typ: 'arsredovisning_kompletteras',
      notifieringEpostadresser: ['rita@revisor.se'],
      epostadresser: ['anna@example.com'],
    })
    expect(updates.some((update) => update.table === 'annual_report_versions' && update.payload.status === 'filed')).toBe(true)
  })

  const RB_XHTML =
    '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Revisionsberättelse</title></head><body>' +
    '<div style="display:none"><ix:header><ix:references><link:schemaRef xlink:type="simple" ' +
    'xlink:href="http://xbrl.taxonomier.se/se/fr/ar/rar/2020-12-01/se-ar-rar-2020-12-01.xsd"/></ix:references></ix:header></div></body></html>'

  const rbParams = {
    companyId: 'company-1',
    userId: 'user-1',
    fiscalPeriodId: 'period-1',
    avsandarePnr: '198001019879',
    undertecknare: { pnr: '197501019876', fornamn: 'Rita', efternamn: 'Revisor', epost: 'rita@revisor.se' },
    xhtml: RB_XHTML,
    notifieringEpost: ['anna@example.com'],
  }

  it('recognises a revisionsberättelse in iXBRL and refuses anything else', () => {
    expect(inspectRevisionsberattelse(RB_XHTML)).toEqual({
      entryPoint: 'se-ar-rar-2020-12-01',
      taxonomyVersion: '2020-12-01',
    })
    const arsredovisning = RB_XHTML.replace(
      'se/fr/ar/rar/2020-12-01/se-ar-rar-2020-12-01.xsd',
      'se/fr/gaap/k2-all/ab/risbs/2024-09-12/se-k2-ab-risbs-2024-09-12.xsd',
    )
    expect(() => inspectRevisionsberattelse(arsredovisning)).toThrow(BolagsverketSubmissionError)
    expect(() => inspectRevisionsberattelse('not a document')).toThrow(
      expect.objectContaining({ code: 'BOLAGSVERKET_RB_INVALID_FILE' }),
    )
    expect(() => inspectRevisionsberattelse(RB_XHTML + ' '.repeat(5 * 1024 * 1024))).toThrow(
      expect.objectContaining({ code: 'BOLAGSVERKET_RB_INVALID_FILE' }),
    )
  })

  it('refuses a revisionsberättelse before the årsredovisning went up as kompletteras', async () => {
    const { supabase } = makeRecordingSupabase([{ data: { org_number: '5560001111' } }, { data: [] }])
    await expect(
      submitRevisionsberattelse({ supabase, client: makeClientMock(), appUrl: 'https://app.test', log: makeLog() }, rbParams),
    ).rejects.toMatchObject({ code: 'BOLAGSVERKET_RB_NO_ARSREDOVISNING' })
  })

  it('refuses a second revisionsberättelse while one is open with Bolagsverket', async () => {
    const { supabase } = makeRecordingSupabase([
      { data: { org_number: '5560001111' } },
      { data: [{ id: 'sub-ar', annual_report_version_id: 'version-1', status: 'inkommen' }] },
      { data: [{ id: 'sub-rb', status: 'uploaded' }] },
    ])
    await expect(
      submitRevisionsberattelse({ supabase, client: makeClientMock(), appUrl: 'https://app.test', log: makeLog() }, rbParams),
    ).rejects.toMatchObject({ code: 'BOLAGSVERKET_SUBMISSION_EXISTS' })
  })

  it('asks for the avtalstext before anything is sent', async () => {
    const { supabase } = makeRecordingSupabase([
      { data: { org_number: '5560001111' } },
      { data: [{ id: 'sub-ar', annual_report_version_id: 'version-1', status: 'uploaded' }] },
      { data: [] },
      {}, // Arelle validation run
      { data: null }, // not accepted yet
    ])
    const client = makeClientMock()
    const result = await submitRevisionsberattelse({ supabase, client, appUrl: 'https://app.test', log: makeLog() }, rbParams)
    expect(result).toMatchObject({ outcome: 'avtal_required', avtalstextAndrad: '2017-12-06' })
    expect((client as unknown as { kontrollera: ReturnType<typeof vi.fn> }).kontrollera).not.toHaveBeenCalled()
  })

  it("uploads the revisor's file as revisionsberattelse, signed by the revisor, archived first", async () => {
    const { supabase, updates, inserts } = makeRecordingSupabase([
      { data: { org_number: '5560001111' } },
      { data: [{ id: 'sub-ar', annual_report_version_id: 'version-1', status: 'inkommen' }] },
      { data: [] }, // no open revisionsberättelse
      {}, // Arelle validation run
      { data: { id: 'acc-1' } },
      { data: { period_end: '2025-12-31' } },
      { data: null }, // no exact request
      { data: { id: 'sub-rb' } },
      {}, // kontrollerad
      {}, // archive link
      {}, // sending
      {}, // uploaded
    ])
    const client = makeClientMock()
    const result = await submitRevisionsberattelse({ supabase, client, appUrl: 'https://app.test', log: makeLog() }, rbParams)

    expect(result).toMatchObject({ outcome: 'uploaded', submissionId: 'sub-rb', handlingTyp: 'revisionsberattelse' })
    const kontrollera = (client as unknown as { kontrollera: ReturnType<typeof vi.fn> }).kontrollera
    expect(kontrollera.mock.calls[0][2]).toBe('revisionsberattelse')
    expect(Buffer.from(kontrollera.mock.calls[0][1], 'base64').toString('utf8')).toBe(RB_XHTML)
    const lamnaIn = (client as unknown as { lamnaIn: ReturnType<typeof vi.fn> }).lamnaIn
    expect(lamnaIn.mock.calls[0][1]).toMatchObject({
      typ: 'revisionsberattelse',
      undertecknare: '197501019876',
      epostadresser: ['rita@revisor.se'],
      notifieringEpostadresser: ['anna@example.com'],
    })
    expect(vi.mocked(uploadDocument).mock.calls[0][3].name).toBe('revisionsberattelse-2025-12-31-inlamnad.xhtml')
    // The revisionsberättelse completes the årsredovisning: its version is
    // not touched. Arelle validated the revisor's exact bytes first, and the
    // run is kept with the årsredovisning's version under the file's hash.
    expect(updates.some((update) => update.table === 'annual_report_versions')).toBe(false)
    expect(validateIxbrlWithArelle).toHaveBeenCalledWith(RB_XHTML, { filename: 'revisionsberattelse.xhtml' })
    expect(inserts.find((insert) => insert.table === 'annual_report_validation_runs')?.payload).toMatchObject({
      version_id: 'version-1',
      validation_layer: 'arelle',
      status: 'passed',
      artifact_hash: createHash('sha256').update(RB_XHTML).digest('hex'),
    })
  })

  it.each([
    ['failed', 'BOLAGSVERKET_RB_ARELLE_FAILED'],
    ['unavailable', 'BOLAGSVERKET_ARELLE_UNAVAILABLE'],
  ] as const)('stops a revisionsberättelse Arelle reports as %s before anything is sent', async (status, code) => {
    vi.mocked(validateIxbrlWithArelle).mockResolvedValueOnce({
      status,
      validator_version: 'test',
      issues: [{ code: 'xbrl.5.2.5.2', severity: 'error', message: 'Invalid fact' }],
    })
    const { supabase, inserts } = makeRecordingSupabase([
      { data: { org_number: '5560001111' } },
      { data: [{ id: 'sub-ar', annual_report_version_id: 'version-1', status: 'inkommen' }] },
      { data: [] },
      {}, // Arelle validation run
    ])
    const client = makeClientMock()
    await expect(
      submitRevisionsberattelse({ supabase, client, appUrl: 'https://app.test', log: makeLog() }, rbParams),
    ).rejects.toMatchObject({ code, details: { issues: [{ code: 'xbrl.5.2.5.2' }] } })
    expect(inserts.find((insert) => insert.table === 'annual_report_validation_runs')?.payload).toMatchObject({ status })
    const mock = client as unknown as Record<string, ReturnType<typeof vi.fn>>
    expect(mock.createInlamningToken).not.toHaveBeenCalled()
    expect(mock.kontrollera).not.toHaveBeenCalled()
    expect(mock.lamnaIn).not.toHaveBeenCalled()
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('moves both handlings of a case and notifies once for the årsredovisning', async () => {
    const emitted: string[] = []
    eventBus.on('arsredovisning.status_changed', (payload) => {
      emitted.push(`changed:${payload.submissionId}`)
    })
    eventBus.on('arsredovisning.registered', (payload) => {
      emitted.push(`registered:${payload.submissionId}`)
    })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'sub-ar', status: 'inkommen', fiscal_period_id: 'period-1', user_id: 'user-1', company_id: 'company-1', annual_report_version_id: 'version-1', handling_typ: 'arsredovisning_kompletteras' },
        { id: 'sub-rb', status: 'inkommen', fiscal_period_id: 'period-1', user_id: 'user-1', company_id: 'company-1', annual_report_version_id: 'version-1', handling_typ: 'revisionsberattelse' },
      ],
      error: null,
    })
    enqueue({ data: null, error: null }) // ÅR status
    enqueue({ data: null, error: null }) // version registered
    enqueue({ data: null, error: null }) // RB status

    await applyHandelse(
      supabase as never,
      message({
        data: {
          version: '2.0',
          handlingsinfo: [
            { handling: 'arsredovisning', idnummer: '49679' },
            { handling: 'revisionsberattelse', idnummer: '49680' },
          ],
          status: 'arsred_registrerad',
        },
      }),
      ['company-1'],
    )

    expect(emitted).toEqual(['changed:sub-ar', 'registered:sub-ar', 'changed:sub-rb'])
    expect(findCalls('arsredovisning_submissions', 'in')[0]).toEqual(['idnummer', ['49679', '49680']])
  })
})
