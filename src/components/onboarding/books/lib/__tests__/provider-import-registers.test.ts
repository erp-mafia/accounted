import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { providerImportRegisters } from '../provider'

/**
 * The books act imports customers, suppliers and invoices through the
 * background import job, as the Import page does, and no longer through
 * /migrate, which saved the Fortnox records its 90-second detail pass did
 * not reach from the short list (crm#1436).
 */

const JOBS = '/api/extensions/ext/arcim-migration/migration-jobs'

const counts = (imported: number) => [
  { resource: 'customers', total: 1249, imported, skipped: 0 },
  { resource: 'suppliers', total: 30, imported: Math.min(imported, 30), skipped: 0 },
]

function status(state: string, imported: number, job: Record<string, unknown> = {}, acceptable = false) {
  return {
    data: {
      job: { id: 'job-1', state, phase: state === 'completed' ? 'completed' : 'import', error_code: null, ...job },
      counts: counts(imported), issues: [], review: { total: acceptable ? 1 : 0, acceptable, truncated: false, unchanged: false },
    },
  }
}

function provider(answers: unknown[]) {
  const calls: { url: string; method: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (init?.method === 'POST' && url === JOBS) return new Response(JSON.stringify({ data: { jobId: 'job-1' } }), { status: 202 })
    if (init?.method === 'POST') return new Response('{}', { status: 202 })
    return new Response(JSON.stringify(answers.shift()), { status: 200 })
  }))
  return calls
}

async function run<T>(promise: Promise<T>, polls: number): Promise<T> {
  for (let i = 0; i < polls; i++) await vi.advanceTimersByTimeAsync(2500)
  return promise
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('providerImportRegisters', () => {
  it('starts the background job for the chosen registers and answers with its counts once it completes', async () => {
    const calls = provider([status('running', 300), status('completed', 1249)])
    const progress: [number, number][] = []
    const results = await run(providerImportRegisters('consent-1', ['customers', 'suppliers'],
      (imported, total) => progress.push([imported, total])), 2)
    expect(calls[0]).toEqual({ url: JOBS, method: 'POST', body: { consentId: 'consent-1', resources: ['customers', 'suppliers'] } })
    expect(calls.some(({ url }) => url.includes('/migrate'))).toBe(false)
    expect(progress).toEqual([[330, 1279], [1279, 1279]])
    expect(results).toEqual({
      customers: { imported: 1249, total: 1249, skipped: 0 },
      suppliers: { imported: 30, total: 30, skipped: 0 },
    })
  })

  it('answers once every record has an outcome, the ones to review included', async () => {
    // A review the Import page lists is no failure of the books act.
    provider([status('needs_attention', 1248, { phase: 'completed' }, true)])
    const results = await run(providerImportRegisters('consent-1', ['customers'], () => {}), 1)
    expect(results.customers).toEqual({ imported: 1248, total: 1249, skipped: 0 })
  })

  // A refused register has no counts, so without its refusal the books act
  // showed "0 kunder" with no reason (crm#1081).
  it('carries the registers the provider refused, grouped by remedy', async () => {
    provider([status('needs_attention', 0, {
      phase: 'completed', provider: 'fortnox',
      refused_resources: { customers: 'license', salesInvoices: 'license', suppliers: 'permission' },
    }, true)])
    const results = await run(providerImportRegisters('consent-1', ['customers', 'suppliers', 'salesInvoices'], () => {}), 1)
    expect(results.refused).toEqual([
      { messageKey: 'ext_arcim_job_refused_license_sales', resources: ['customers', 'salesInvoices'] },
      { messageKey: 'ext_arcim_refused_user_right', resources: ['suppliers'] },
    ])
  })

  it('names a Bokio token without read permission as the token', async () => {
    provider([status('completed', 0, { provider: 'bokio', refused_resources: { supplierInvoices: 'permission' } })])
    const results = await run(providerImportRegisters('consent-1', ['supplierInvoices'], () => {}), 1)
    expect(results.refused).toEqual([{ messageKey: 'ext_arcim_job_refused_token', resources: ['supplierInvoices'] }])
  })

  it('stops with the job\'s own reason when it cannot go on', async () => {
    provider([status('needs_attention', 300, { error_code: 'PROVIDER_AUTH_EXPIRED' })])
    const stopped = expect(providerImportRegisters('consent-1', ['customers'], () => {})).rejects.toThrow(/.+/)
    await vi.advanceTimersByTimeAsync(2500)
    await stopped
  })
})
