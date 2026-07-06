import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/bokslut/ixbrl/build-input', () => ({
  buildIxbrlInput: vi.fn(async () => ({
    entryPointId: 'k2-ab-risbs-2024-09-12',
    period: { start: '2025-01-01', end: '2025-12-31' },
  })),
}))
vi.mock('@/lib/bokslut/ixbrl/document/k2-document', () => ({
  generateK2IxbrlDocument: vi.fn(() => ({ xhtml: '<?xml version="1.0"?><html></html>' })),
  embedKontrollsumma: vi.fn((xhtml: string) => xhtml),
}))
vi.mock('@/lib/bokslut/ixbrl/validate/rules', () => ({
  runPreflightChecks: vi.fn(() => ({ ok: true, issues: [] })),
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
import {
  applyHandelse,
  BolagsverketSubmissionError,
  handleWebhook,
  hashPnr,
  normalizeOrgnr,
  submitArsredovisning,
} from '../lib/submission-service'
import type { HandelseMeddelande } from '../types'

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
  const next = () => results[idx++] ?? { data: null, error: null }
  const makeBuilder = (table: string) => {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'insert']) {
      b[m] = () => b
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
  return { supabase: { from: (table: string) => makeBuilder(table) } as never, updates }
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
  avsandarePnr: '198001019876',
  undertecknare: {
    pnr: '198001019876',
    fornamn: 'Anna',
    efternamn: 'Svensson',
    roll: 'VD',
    epost: 'anna@example.com',
  },
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

describe('normalizeOrgnr / hashPnr', () => {
  it('normalizes 12-digit and dashed org numbers to the 10-digit API form', () => {
    expect(normalizeOrgnr('556000-1111')).toBe('5560001111')
    expect(normalizeOrgnr('165560001111')).toBe('5560001111')
    expect(normalizeOrgnr('5560001111')).toBe('5560001111')
  })

  it('hashes personnummer with company salt: never the raw value', () => {
    const hash = hashPnr('company-1', '19830101-9876')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain('9876')
    expect(hashPnr('company-2', '198301019876')).not.toBe(hash)
    // Same pnr + company → stable.
    expect(hashPnr('company-1', '198301019876')).toBe(hash)
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

  it('marks the submission row as error and rethrows when inlämning fails', async () => {
    const { supabase, updates } = makeRecordingSupabase([
      { data: { org_number: '5560001111' } }, // getOrgnr
      { data: [] },                            // no active submission
      { data: { id: 'acc-1' } },               // avtal acceptance exists
      { data: { id: 'sub-1' } },               // insert submission row
      {},                                      // update → kontrollerad
      {},                                      // markSubmissionError update
    ])
    const client = makeClientMock({
      lamnaIn: vi.fn(async () => {
        throw new Error('inlamning exploded')
      }),
    })
    const log = makeLog()

    await expect(
      submitArsredovisning({ supabase, client, appUrl: 'https://app.test', log }, submitParams),
    ).rejects.toThrow('inlamning exploded')

    const errorUpdate = updates.find((u) => u.payload.status === 'error')
    expect(errorUpdate).toBeDefined()
    expect(errorUpdate!.table).toBe('arsredovisning_submissions')
    expect(errorUpdate!.payload.error_message).toContain('inlamning exploded')
  })

  it('logs and persists a document-archive failure without blocking the filing', async () => {
    vi.mocked(uploadDocument).mockRejectedValueOnce(new Error('magic bytes rejected'))
    const { supabase, updates } = makeRecordingSupabase([
      { data: { org_number: '5560001111' } }, // getOrgnr
      { data: [] },                            // no active submission
      { data: { id: 'acc-1' } },               // avtal acceptance exists
      { data: { id: 'sub-1' } },               // insert submission row
      {},                                      // update → kontrollerad
      {},                                      // error_message update (doc failure)
      {},                                      // update → uploaded
      // ensureSubscription throws on the empty appUrl before any query.
    ])
    const log = makeLog()

    const result = await submitArsredovisning(
      { supabase, client: makeClientMock(), appUrl: '', log },
      submitParams,
    )
    expect(result.outcome).toBe('uploaded')

    // The failure is logged AND visible on the row.
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error.mock.calls[0][0]).toMatch(/archive/)
    const docFailureUpdate = updates.find(
      (u) => typeof u.payload.error_message === 'string' && !u.payload.status,
    )
    expect(docFailureUpdate).toBeDefined()
    expect(docFailureUpdate!.payload.error_message).toContain('magic bytes rejected')

    // The filing itself still went through with dokument_id null.
    const uploadedUpdate = updates.find((u) => u.payload.status === 'uploaded')
    expect(uploadedUpdate).toBeDefined()
    expect(uploadedUpdate!.payload.dokument_id).toBeNull()

    // Subscription failure (invalid appUrl) is logged, not swallowed.
    expect(log.warn.mock.calls.some(([msg]) => /prenumeration/.test(String(msg)))).toBe(true)
  })

  it('exports BolagsverketSubmissionError with a stable code', () => {
    const err = new BolagsverketSubmissionError('BOLAGSVERKET_SUBMISSION_EXISTS', 'exists', {
      submission_id: 'sub-1',
    })
    expect(err.code).toBe('BOLAGSVERKET_SUBMISSION_EXISTS')
    expect(err.details).toEqual({ submission_id: 'sub-1' })
  })
})
