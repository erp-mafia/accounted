/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  agiSubmissionFromDeclaration,
  parseCachedAgiSubmission,
  readAgiSubmissionStatus,
} from '../lib/agi-submission-status'
import { skatteverketExtension } from '../index'
import type { ExtensionContext } from '@/lib/extensions/types'

/**
 * GET /agi/status feeds AGIPanel and the run page. The kvittens cron deletes
 * the `agi_submission_{period}` cache when it promotes the declaration, so
 * the route must serve kvittensnummer / signeradAv / signeradTid from
 * agi_declarations in that case (#1597); with the cache present it still
 * returns the cache untouched.
 */

const PERIOD = '202606'

const SIGNED_ROW = {
  salary_run_id: 'run-1',
  status: 'submitted',
  kvittensnummer: 'e2f1a4c0-kvittens',
  submitted_at: '2026-07-14T08:30:00+00:00',
  response_data: {
    signeradAv: '191212121212',
    signeradTid: '2026-07-14T08:30:00Z',
    submittedAtEstimated: false,
    uuidKvittens: 'e2f1a4c0-kvittens',
    reconciledBy: 'cron',
  },
}

/** Supabase stub whose agi_declarations read resolves to `row`, recording the filters. */
function makeSupabase(row: unknown) {
  const filters: Record<string, unknown> = {}
  const reads: string[] = []
  const chain: any = {}
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn((col: string, val: unknown) => {
    filters[col] = val
    return chain
  })
  chain.maybeSingle = vi.fn(async () => ({ data: row, error: null }))
  const supabase = {
    from: vi.fn((table: string) => {
      reads.push(table)
      return chain
    }),
  } as any
  return { supabase, filters, reads }
}

describe('agiSubmissionFromDeclaration', () => {
  it('builds a signed record with kvittensnummer, signatory and signing time (estimated=false)', () => {
    expect(agiSubmissionFromDeclaration(SIGNED_ROW)).toEqual({
      status: 'signed',
      kvittensnummer: 'e2f1a4c0-kvittens',
      signeradAv: '191212121212',
      signeradTid: '2026-07-14T08:30:00Z',
      submittedAt: '2026-07-14T08:30:00+00:00',
      submittedAtEstimated: false,
      updatedAt: '2026-07-14T08:30:00+00:00',
      source: 'declaration',
    })
  })

  it('flags the reconciliation-time fallback when signeradTid is absent', () => {
    const record = agiSubmissionFromDeclaration({
      ...SIGNED_ROW,
      response_data: {
        signeradAv: '191212121212',
        signeradTid: null,
        submittedAtEstimated: true,
      },
    })
    expect(record).toMatchObject({
      status: 'signed',
      kvittensnummer: 'e2f1a4c0-kvittens',
      signeradAv: '191212121212',
      submittedAt: '2026-07-14T08:30:00+00:00',
      submittedAtEstimated: true,
    })
    expect(record?.signeradTid).toBeUndefined()
  })

  it('treats a missing signeradTid as estimated even when the flag predates the receipt', () => {
    // The interactive /agi/kvittenser handler writes response_data without
    // submittedAtEstimated; the absence of signeradTid is what makes the
    // stamp an estimate.
    const record = agiSubmissionFromDeclaration({
      ...SIGNED_ROW,
      response_data: { signeradAv: '191212121212', signeradTid: null },
    })
    expect(record?.submittedAtEstimated).toBe(true)
  })

  it('never carries salaryRunId: the period row is repointed at a correction run', () => {
    expect(agiSubmissionFromDeclaration(SIGNED_ROW)).not.toHaveProperty('salaryRunId')
  })

  it('returns null while the declaration has no receipt', () => {
    expect(agiSubmissionFromDeclaration(null)).toBeNull()
    expect(
      agiSubmissionFromDeclaration({ ...SIGNED_ROW, status: 'pending_signature', kvittensnummer: null }),
    ).toBeNull()
    expect(agiSubmissionFromDeclaration({ ...SIGNED_ROW, status: 'generated' })).toBeNull()
  })
})

describe('parseCachedAgiSubmission', () => {
  it('parses the JSON string the extension stores and tolerates garbage', () => {
    expect(parseCachedAgiSubmission(JSON.stringify({ status: 'awaiting_signing' }))).toEqual({
      status: 'awaiting_signing',
    })
    expect(parseCachedAgiSubmission('{not json')).toBeNull()
    expect(parseCachedAgiSubmission(null)).toBeNull()
    expect(parseCachedAgiSubmission('')).toBeNull()
  })
})

describe('readAgiSubmissionStatus', () => {
  it('cache deleted: serves the receipt from agi_declarations for the company and period', async () => {
    const { supabase, filters, reads } = makeSupabase(SIGNED_ROW)
    const record = await readAgiSubmissionStatus(supabase, 'company-1', PERIOD, null)
    expect(reads).toEqual(['agi_declarations'])
    expect(filters).toEqual({ company_id: 'company-1', period_year: 2026, period_month: 6 })
    expect(record).toMatchObject({
      status: 'signed',
      kvittensnummer: 'e2f1a4c0-kvittens',
      signeradAv: '191212121212',
      signeradTid: '2026-07-14T08:30:00Z',
      submittedAtEstimated: false,
      source: 'declaration',
    })
  })

  it('cache present: returns the cached record without touching agi_declarations', async () => {
    const { supabase, reads } = makeSupabase(SIGNED_ROW)
    const cached = {
      status: 'awaiting_signing',
      signeringslank: 'https://skatteverket.se/sign/abc',
      salaryRunId: 'run-2',
      updatedAt: '2026-07-20T09:00:00Z',
    }
    const record = await readAgiSubmissionStatus(supabase, 'company-1', PERIOD, JSON.stringify(cached))
    expect(reads).toEqual([])
    expect(record).toEqual({ ...cached, source: 'cache' })
  })

  it('returns null without a DB read for a malformed period', async () => {
    const { supabase, reads } = makeSupabase(SIGNED_ROW)
    expect(await readAgiSubmissionStatus(supabase, 'company-1', '2026-06', null)).toBeNull()
    expect(reads).toEqual([])
  })

  it('returns null when the declaration is still awaiting signature', async () => {
    const { supabase } = makeSupabase({ ...SIGNED_ROW, status: 'pending_signature', kvittensnummer: null })
    expect(await readAgiSubmissionStatus(supabase, 'company-1', PERIOD, null)).toBeNull()
  })
})

describe('GET /agi/status', () => {
  function findRoute() {
    const route = skatteverketExtension.apiRoutes?.find(
      (r) => r.method === 'GET' && r.path === '/agi/status',
    )
    if (!route) throw new Error('/agi/status route not registered')
    return route
  }

  function makeContext(opts: { cached?: unknown; row?: unknown }): ExtensionContext {
    const { supabase } = makeSupabase(opts.row ?? null)
    return {
      userId: 'user-1',
      companyId: 'company-1',
      extensionId: 'skatteverket',
      requestId: 'req_test',
      supabase,
      emit: vi.fn().mockResolvedValue(undefined),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
      settings: {
        get: vi.fn().mockResolvedValue(opts.cached ?? null),
        set: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
      },
    } as any
  }

  function makeRequest(query: string): Request {
    return new Request(`http://localhost/api/extensions/ext/skatteverket/agi/status${query}`)
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 500 without an extension context', async () => {
    const res = await findRoute().handler(makeRequest(`?period=${PERIOD}`))
    expect(res.status).toBe(500)
  })

  it('returns 400 without a period', async () => {
    const res = await findRoute().handler(makeRequest(''), makeContext({}))
    expect(res.status).toBe(400)
  })

  it('(a) cache deleted, declaration signed: carries kvittensnummer, signeradAv, signeradTid, estimated=false', async () => {
    const ctx = makeContext({ row: SIGNED_ROW })
    const res = await findRoute().handler(makeRequest(`?period=${PERIOD}`), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({
      status: 'signed',
      kvittensnummer: 'e2f1a4c0-kvittens',
      signeradAv: '191212121212',
      signeradTid: '2026-07-14T08:30:00Z',
      submittedAt: '2026-07-14T08:30:00+00:00',
      submittedAtEstimated: false,
      source: 'declaration',
    })
    expect(ctx.settings.get).toHaveBeenCalledWith(`agi_submission_${PERIOD}`)
  })

  it('(b) cache deleted, signeradTid absent and submittedAtEstimated true: estimated flag set', async () => {
    const ctx = makeContext({
      row: {
        ...SIGNED_ROW,
        response_data: { signeradAv: '191212121212', signeradTid: null, submittedAtEstimated: true },
      },
    })
    const res = await findRoute().handler(makeRequest(`?period=${PERIOD}`), ctx)
    const body = await res.json()
    expect(body.data).toMatchObject({
      status: 'signed',
      kvittensnummer: 'e2f1a4c0-kvittens',
      signeradAv: '191212121212',
      submittedAt: '2026-07-14T08:30:00+00:00',
      submittedAtEstimated: true,
    })
    expect(body.data.signeradTid).toBeUndefined()
  })

  it('(c) cache present: the cached in-flight record still wins', async () => {
    const cached = {
      status: 'awaiting_signing',
      signeringslank: 'https://skatteverket.se/sign/abc',
      salaryRunId: 'run-2',
    }
    const ctx = makeContext({ cached: JSON.stringify(cached), row: SIGNED_ROW })
    const res = await findRoute().handler(makeRequest(`?period=${PERIOD}`), ctx)
    const body = await res.json()
    expect(body.data).toEqual({ ...cached, source: 'cache' })
    expect(ctx.supabase.from).not.toHaveBeenCalled()
  })

  it('returns null data when nothing has been filed for the period', async () => {
    const ctx = makeContext({ row: null })
    const res = await findRoute().handler(makeRequest(`?period=${PERIOD}`), ctx)
    const body = await res.json()
    expect(body.data).toBeNull()
  })
})
