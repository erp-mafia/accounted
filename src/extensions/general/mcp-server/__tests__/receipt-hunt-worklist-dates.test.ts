/**
 * gnubok_receipt_hunt_worklist takes a since..until window, read like
 * gnubok_list_verifikat_without_documents's: "last month" is one call, not a
 * page through every row. Under test here: what the tool hands the worklist,
 * and what it refuses before any read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockResolveAgentWorklist = vi.fn()
vi.mock('@/lib/receipt-hunt/agent-worklist', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/receipt-hunt/agent-worklist')>()),
  resolveAgentWorklist: (...args: unknown[]) => mockResolveAgentWorklist(...args),
}))

import { tools } from '../server'

const worklist = tools.find((t) => t.name === 'gnubok_receipt_hunt_worklist')!
const supabase = {} as never

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveAgentWorklist.mockResolvedValue({ items: [], total_count: 0, inbox_address: null })
})

describe('gnubok_receipt_hunt_worklist: since and until', () => {
  it('declares until beside since', () => {
    const properties = (worklist.inputSchema as { properties: Record<string, unknown> }).properties
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['since', 'until']))
  })

  it('hands both bounds to the worklist', async () => {
    await worklist.execute({ since: '2026-10-01', until: '2026-10-31', limit: 50 }, 'company-1', 'user-1', supabase)
    expect(mockResolveAgentWorklist).toHaveBeenCalledWith(supabase, 'company-1', {
      limit: 50,
      offset: undefined,
      since: '2026-10-01',
      until: '2026-10-31',
    })
  })

  it('takes until alone, and neither', async () => {
    await worklist.execute({ until: '2026-10-31' }, 'company-1', 'user-1', supabase)
    expect(mockResolveAgentWorklist.mock.calls[0][2]).toMatchObject({ since: null, until: '2026-10-31' })
    await worklist.execute({}, 'company-1', 'user-1', supabase)
    expect(mockResolveAgentWorklist.mock.calls[1][2]).toMatchObject({ since: null, until: null })
  })

  it('refuses a bound that is not an ISO date, and a window that ends before it starts, before any read', async () => {
    for (const args of [{ until: '31/10/2026' }, { since: 20261001 }, { since: '2026-11-01', until: '2026-10-31' }]) {
      await expect(worklist.execute(args, 'company-1', 'user-1', supabase), JSON.stringify(args)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      })
    }
    expect(mockResolveAgentWorklist).not.toHaveBeenCalled()
  })
})
