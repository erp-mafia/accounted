import { describe, expect, it, vi } from 'vitest'
import { getAuditLog } from '../audit-service'

function createQuery(result: { data: unknown[]; error: unknown; count: number | null }) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    range: vi.fn(),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  query.order.mockReturnValue(query)
  query.range.mockResolvedValue(result)
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
    expect(result.count).toBe(0)
  })
})
