import { describe, expect, it, vi } from 'vitest'
import { getAuditLog } from '../audit-service'

/** A builder whose every call chains, awaited for `result` (filters may follow .range()). */
function createQuery(result: { data: unknown[]; error: unknown; count: number | null }) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    gte: vi.fn(),
    lte: vi.fn(),
    or: vi.fn(),
    order: vi.fn(),
    range: vi.fn(),
    then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
  }
  for (const method of ['select', 'eq', 'gte', 'lte', 'or', 'order', 'range'] as const) {
    query[method].mockReturnValue(query)
  }
  return query
}

describe('getAuditLog', () => {
  it('requests an exact count for interactive pagination', async () => {
    const query = createQuery({ data: [], error: null, count: 12 })
    const supabase = { from: vi.fn(() => query) }

    const result = await getAuditLog(supabase as never, 'company-1')

    expect(query.select).toHaveBeenCalledWith('*', { count: 'exact' })
    expect(result.count).toBe(12)
  })

  it('skips the exact count for full archive exports', async () => {
    const query = createQuery({ data: [], error: null, count: null })
    const supabase = { from: vi.fn(() => query) }

    const result = await getAuditLog(supabase as never, 'company-1', {
      includeCount: false,
      pageSize: 500,
    })

    expect(query.select).toHaveBeenCalledWith('*')
    expect(query.order).toHaveBeenNthCalledWith(1, 'created_at', { ascending: false })
    expect(query.order).toHaveBeenNthCalledWith(2, 'id', { ascending: false })
    expect(query.lte).not.toHaveBeenCalled()
    expect(query.or).not.toHaveBeenCalled()
    expect(result.count).toBe(0)
  })

  it('pages by offset when no cursor is given', async () => {
    const query = createQuery({ data: [], error: null, count: null })
    const supabase = { from: vi.fn(() => query) }

    await getAuditLog(supabase as never, 'company-1', { page: 3, pageSize: 500, includeCount: false })

    expect(query.range).toHaveBeenCalledWith(1000, 1499)
  })

  it('starts after the cursor row from an index bound instead of an offset', async () => {
    const query = createQuery({ data: [], error: null, count: null })
    const supabase = { from: vi.fn(() => query) }
    const after = { created_at: '2026-09-27T19:22:19.718785+00:00', id: '59d7ccf1-0182-41c8-8a41-4ae48f69e46d' }

    await getAuditLog(supabase as never, 'company-1', {
      page: 400,
      pageSize: 500,
      includeCount: false,
      to_date: '2026-12-31T23:59:59.999Z',
      after,
    })

    // First page window: the cursor replaces the offset (page is ignored).
    expect(query.range).toHaveBeenCalledWith(0, 499)
    // The bound the (company_id, created_at DESC, id DESC) index starts from,
    // next to the caller's own to_date bound.
    expect(query.lte).toHaveBeenCalledWith('created_at', after.created_at)
    expect(query.lte).toHaveBeenCalledWith('created_at', '2026-12-31T23:59:59.999Z')
    // Strictly after the cursor: an older timestamp, or the same one with a lower id.
    expect(query.or).toHaveBeenCalledWith(
      `created_at.lt.${after.created_at},and(created_at.eq.${after.created_at},id.lt.${after.id})`,
    )
  })
})
