import { describe, expect, it, vi } from 'vitest'
import { insertVatCheckReviewRow, listVatCheckReviews } from '../check-review-store'

/** A query chain that records its filters and resolves to `result`. */
function chain(result: { data: unknown; error: unknown }) {
  const calls: Array<[string, unknown[]]> = []
  const proxy: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'in', 'order', 'limit', 'insert', 'single']) {
    proxy[method] = (...args: unknown[]) => {
      calls.push([method, args])
      return proxy
    }
  }
  proxy.then = (resolve: (value: unknown) => void) => resolve(result)
  return { proxy, calls }
}

function client(tables: Record<string, { data: unknown; error: unknown }>) {
  const chains: Record<string, ReturnType<typeof chain>> = {}
  return {
    chains,
    from: vi.fn((table: string) => {
      chains[table] = chain(tables[table] ?? { data: [], error: null })
      return chains[table].proxy
    }),
  }
}

const PERIOD = { start: '2025-10-19', end: '2026-09-30' }

describe('listVatCheckReviews', () => {
  it('keeps the latest row per code, drops a code whose latest row is a withdrawal, and filters by company and period', async () => {
    // Newest first, as the query orders them.
    const rows = [
      { check_code: 'RC_INPUT_VAT_MISMATCH', action: 'withdrawn', fingerprint: null, note: null, source: 'web', actor: 'u1', created_at: '2026-10-15T10:00:00Z' },
      { check_code: 'RC_BASIS_MISSING', action: 'reviewed', fingerprint: 'v1:1111111111111111', note: 'A61', source: 'agent', actor: 'u2', created_at: '2026-10-15T09:00:00Z' },
      { check_code: 'RC_INPUT_VAT_MISMATCH', action: 'reviewed', fingerprint: 'v1:2222222222222222', note: null, source: 'web', actor: 'u1', created_at: '2026-10-14T09:00:00Z' },
      { check_code: 'RC_BASIS_MISSING', action: 'reviewed', fingerprint: 'v1:3333333333333333', note: 'old', source: 'web', actor: 'u1', created_at: '2026-10-13T09:00:00Z' },
    ]
    const db = client({
      vat_check_reviews: { data: rows, error: null },
      profiles: { data: [{ id: 'u2', email: 'anna@example.se', full_name: ' Anna Andersson ' }], error: null },
    })

    const reviews = await listVatCheckReviews(db as never, 'company-1', PERIOD, { labelClient: db as never })

    expect(reviews).toEqual([
      {
        check_code: 'RC_BASIS_MISSING',
        fingerprint: 'v1:1111111111111111',
        reviewed_at: '2026-10-15T09:00:00Z',
        reviewed_by: 'u2',
        reviewed_by_label: 'Anna Andersson',
        note: 'A61',
        source: 'agent',
      },
    ])
    const filters = db.chains.vat_check_reviews.calls.filter(([method]) => method === 'eq').map(([, args]) => args)
    expect(filters).toEqual([
      ['company_id', 'company-1'],
      ['period_start', '2025-10-19'],
      ['period_end', '2026-09-30'],
    ])
  })

  it('answers without names when the reader may not see the profiles', async () => {
    const db = client({
      vat_check_reviews: {
        data: [{ check_code: 'RC_BASIS_MISSING', action: 'reviewed', fingerprint: 'v1:1111111111111111', note: null, source: 'web', actor: 'u9', created_at: 't' }],
        error: null,
      },
      profiles: { data: null, error: { message: 'permission denied' } },
    })
    const reviews = await listVatCheckReviews(db as never, 'company-1', PERIOD, { labelClient: db as never })
    expect(reviews[0]?.reviewed_by_label).toBeNull()
  })

  it('throws a read failure for the caller to decide on', async () => {
    const db = client({ vat_check_reviews: { data: null, error: new Error('db down') } })
    await expect(listVatCheckReviews(db as never, 'company-1', PERIOD)).rejects.toThrow('db down')
  })
})

describe('insertVatCheckReviewRow', () => {
  it('writes the period by its dates and drops a fingerprint on a withdrawal', async () => {
    const db = client({ vat_check_reviews: { data: { created_at: '2026-10-15T09:00:00Z' }, error: null } })
    const result = await insertVatCheckReviewRow(db as never, {
      companyId: 'company-1',
      period: { type: 'yearly', ...PERIOD },
      checkCode: 'RC_BASIS_MISSING',
      action: 'withdrawn',
      fingerprint: 'v1:1111111111111111',
      note: null,
      source: 'web',
      actor: 'u1',
    })
    expect(result).toEqual({ created_at: '2026-10-15T09:00:00Z' })
    const insert = db.chains.vat_check_reviews.calls.find(([method]) => method === 'insert')
    expect(insert?.[1][0]).toEqual({
      company_id: 'company-1',
      period_type: 'yearly',
      period_start: '2025-10-19',
      period_end: '2026-09-30',
      check_code: 'RC_BASIS_MISSING',
      action: 'withdrawn',
      fingerprint: null,
      note: null,
      source: 'web',
      actor: 'u1',
    })
  })
})
